import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    LAYOUT_LOGICAL,
    SAFE_H,
    SAFE_RATE,
    SAFE_SCALE,
    SAFE_W,
    TRANSFORM_NORMAL,
    buildConnectorIndex,
    buildJoinMonitors,
    buildMirrorMembers,
    buildSafeMirrorsXml,
    collectExternalSpecsFromXml,
    isBuiltinConnector,
    orderConnectors,
    pickModeId,
} from './displayLogic.js';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';

const METHOD_VERIFY = 0;
const METHOD_PERSISTENT = 2;
const METHOD_TEMPORARY = 1;

class DisplayConfigClient {
    constructor() {
        this._proxy = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                BUS_NAME,
                OBJECT_PATH,
                BUS_NAME,
                null,
                (source, res) => {
                    try {
                        this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    release() {
        // Drop the proxy explicitly so disable() frees the session
        // reference immediately instead of waiting for the GC sweep.
        this._proxy = null;
    }

    get ready() {
        return this._proxy !== null;
    }

    call(method, params) {
        return new Promise((resolve, reject) => {
            this._proxy.call(
                method,
                params,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        resolve(proxy.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async getState() {
        const result = await this.call('GetCurrentState', null);
        const [serial, monitors, logicalMonitors, properties] = result.deep_unpack();
        return {serial, monitors, logicalMonitors, properties};
    }

    async apply(serial, method, logicalMonitors, properties) {
        const params = new GLib.Variant(
            '(uua(iiduba(ssa{sv}))a{sv})',
            [serial, method, logicalMonitors, properties]
        );
        return this.call('ApplyMonitorsConfig', params);
    }
}

function showOsd(text) {
    try {
        Main.osdWindowManager.show(-1, Gio.ThemedIcon.new('video-display-symbolic'), text, null, null);
    } catch (e) {
        try {
            Main.notify('Display Rescue', text);
        } catch (_ignored) {
            log(`[display-rescue] ${text} (osd failed: ${e.message})`);
        }
    }
}

function warpToPrimaryCenter() {
    try {
        const primary = Main.layoutManager.primaryMonitor;
        if (!primary || !global.display || typeof global.display.warp_pointer !== 'function')
            return;
        const x = Math.round(primary.x + primary.width / 2);
        const y = Math.round(primary.y + primary.height / 2);
        global.display.warp_pointer(x, y);
    } catch (e) {
        log(`[display-rescue] warp failed: ${e.message}`);
    }
}

function monitorsXmlPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.config', 'monitors.xml']);
}

function backupMonitorsXml() {
    const path = monitorsXmlPath();
    const src = Gio.File.new_for_path(path);
    if (!src.query_exists(null))
        return null;
    const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
    const backupPath = `${path}.bak-${stamp}`;
    try {
        src.copy(Gio.File.new_for_path(backupPath), Gio.FileCopyFlags.NONE, null, null);
        return backupPath;
    } catch (e) {
        log(`[display-rescue] backup failed: ${e.message}`);
        return null;
    }
}

function writeMonitorsXml(text) {
    const dest = Gio.File.new_for_path(monitorsXmlPath());
    dest.replace_contents(
        new TextEncoder().encode(text),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

export default class DisplayRescueExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new DisplayConfigClient();
        this._starting = this._client.init().catch(e => {
            log(`[display-rescue] DisplayConfig proxy failed: ${e.message}`);
        });
        // Busy flag bounds transient memory under key spam: one in-flight
        // apply at a time, no stacked unpacked states. Epoch discards late
        // results after disable() instead of retaining a dead client.
        this._busy = false;
        this._epoch = (this._epoch || 0) + 1;

        this._mirrorHandler = () => this._runExclusive('Mirror', () => this._onMirror());
        this._joinHandler = () => this._runExclusive('Join', () => this._onJoin());
        this._resetHandler = () => this._runExclusive('Reset', () => this._onReset());

        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('mirror', this._settings, flags, mode, this._mirrorHandler);
        Main.wm.addKeybinding('join', this._settings, flags, mode, this._joinHandler);
        Main.wm.addKeybinding('reset', this._settings, flags, mode, this._resetHandler);
    }

    disable() {
        // Bump the epoch first so any in-flight handler abandons its work
        // instead of touching a released client.
        this._epoch = (this._epoch || 0) + 1;
        this._busy = false;
        for (const key of ['mirror', 'join', 'reset']) {
            try {
                Main.wm.removeKeybinding(key);
            } catch (e) {
                // Already removed.
            }
        }
        if (this._client) {
            this._client.release();
            this._client = null;
        }
        this._settings = null;
        this._starting = null;
        this._mirrorHandler = null;
        this._joinHandler = null;
        this._resetHandler = null;
    }

    async _ready() {
        if (this._starting) {
            await this._starting;
            // Release the startup promise chain after first use: it is only
            // needed once, retaining it for the session lifetime is waste.
            this._starting = null;
        }
        if (!this._client || !this._client.ready)
            throw new Error('DisplayConfig service unavailable');
    }

    _runExclusive(action, fn) {
        if (this._busy) {
            log(`[display-rescue] ${action} ignored: another apply in flight`);
            return Promise.resolve();
        }
        this._busy = true;
        const epoch = this._epoch;
        return fn().catch(e => this._onError(action, e)).finally(() => {
            if (this._epoch === epoch)
                this._busy = false;
        });
    }

    _alive(epoch) {
        return this._client !== null && this._epoch === epoch;
    }

    async _attemptApply(serial, logicalMonitors, properties) {
        try {
            await this._client.apply(serial, METHOD_VERIFY, logicalMonitors, properties);
        } catch (e) {
            log(`[display-rescue] verify rejected, trying direct apply: ${e.message}`);
        }
        try {
            await this._client.apply(serial, METHOD_PERSISTENT, logicalMonitors, properties);
            return;
        } catch (e) {
            log(`[display-rescue] persistent apply failed, retrying with fresh serial: ${e.message}`);
        }
        // The serial may have gone stale in a hotplug race: refetch once
        // and retry persistent, then fall back to temporary on the same
        // fresh serial instead of a third round-trip with a dead one.
        const fresh = await this._client.getState();
        try {
            await this._client.apply(fresh.serial, METHOD_PERSISTENT, logicalMonitors, properties);
        } catch (e) {
            await this._client.apply(fresh.serial, METHOD_TEMPORARY, logicalMonitors, properties);
        }
    }

    async _onMirror() {
        await this._ready();
        const epoch = this._epoch;
        const {serial, monitors} = await this._client.getState();
        if (!this._alive(epoch))
            return;
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);
        if (connectors.length === 0)
            throw new Error('no outputs found');
        const {members, common} = buildMirrorMembers(index, connectors);
        await this._attemptApply(serial, [[0, 0, SAFE_SCALE, TRANSFORM_NORMAL, true, members]],
            {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)});
        if (!this._alive(epoch))
            return;
        warpToPrimaryCenter();
        showOsd(`Mirror ${common.width}x${common.height}`);
        log(`[display-rescue] Mirror applied: ${common.width}x${common.height} on ${connectors.join(',')}`);
    }

    async _onJoin() {
        await this._ready();
        const epoch = this._epoch;
        const {serial, monitors, logicalMonitors: currentLogical} = await this._client.getState();
        if (!this._alive(epoch))
            return;
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);
        if (connectors.length < 2) {
            showOsd('Join needs 2 outputs');
            return;
        }
        const logicalMonitors = buildJoinMonitors(index, connectors, currentLogical);
        await this._attemptApply(serial, logicalMonitors,
            {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)});
        if (!this._alive(epoch))
            return;
        warpToPrimaryCenter();
        showOsd('Join (extend)');
        log(`[display-rescue] Join applied on ${connectors.join(',')}`);
    }

    async _onReset() {
        await this._ready();
        const epoch = this._epoch;
        const backupPath = backupMonitorsXml();
        const {serial, monitors} = await this._client.getState();
        if (!this._alive(epoch))
            return;
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);
        const members = [];
        for (const connector of connectors) {
            const entry = index.get(connector);
            const modeId = pickModeId(entry, SAFE_W, SAFE_H)
                || (entry.current && entry.current.modeId)
                || entry.modes[0].modeId;
            members.push([connector, modeId, {}]);
        }
        if (members.length === 0)
            throw new Error('no outputs found');
        await this._attemptApply(serial, [[0, 0, SAFE_SCALE, TRANSFORM_NORMAL, true, members]],
            {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)});
        if (!this._alive(epoch))
            return;
        // Purge stale configs (e.g. the 4K Join) so the next hotplug or
        // EDID flip cannot resurrect the bad layout automatically.
        try {
            this._purgeStaleConfigs(monitors);
        } catch (e) {
            log(`[display-rescue] purge failed: ${e.message}`);
        }
        warpToPrimaryCenter();
        showOsd(backupPath ? `Reset to 1080p mirror (backup kept)` : 'Reset to 1080p mirror');
        log('[display-rescue] Reset applied: 1080p mirror, stale configs purged');
    }

    _purgeStaleConfigs(liveMonitors) {
        let builtinSpec = null;
        let builtinMode = {width: SAFE_W, height: SAFE_H, rate: SAFE_RATE};
        for (const entry of liveMonitors) {
            const spec = entry[0];
            const modes = entry[1];
            const props = entry[2];
            const builtin = (props && props['is-builtin']) || isBuiltinConnector(spec[0]);
            if (builtin && !builtinSpec) {
                builtinSpec = spec;
                const current = modes.find(m => m[6] && m[6]['is-current']) || modes[0];
                if (current) {
                    builtinMode = {
                        width: current[1],
                        height: current[2],
                        rate: Number(current[3]).toFixed(3),
                    };
                }
            }
        }
        if (!builtinSpec)
            return;
        const seen = new Map();
        const addSpec = spec => {
            const key = spec.join('|');
            if (!seen.has(key))
                seen.set(key, spec);
        };
        for (const entry of liveMonitors) {
            const spec = entry[0];
            const props = entry[2];
            const builtin = (props && props['is-builtin']) || isBuiltinConnector(spec[0]);
            if (!builtin)
                addSpec(spec);
        }
        try {
            const [ok, bytes] = GLib.file_get_contents(monitorsXmlPath());
            if (ok)
                for (const spec of collectExternalSpecsFromXml(new TextDecoder().decode(bytes)))
                    addSpec(spec);
        } catch (e) {
            log(`[display-rescue] read monitors.xml failed: ${e.message}`);
        }
        writeMonitorsXml(buildSafeMirrorsXml(builtinSpec, builtinMode, [...seen.values()]));
    }

    _onError(action, e) {
        log(`[display-rescue] ${action} failed: ${e.message}`);
        showOsd(`${action} failed`);
    }
}
