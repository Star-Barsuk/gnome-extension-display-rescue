import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    LAYOUT_LOGICAL,
    SAFE_H,
    SAFE_SCALE,
    SAFE_W,
    TRANSFORM_NORMAL,
    assessExternalLayout,
    buildConnectorIndex,
    buildJoinMonitors,
    buildMirrorMembers,
    collectExternalSpecsFromXml,
    orderConnectors,
    pickModeId,
} from './displayLogic.js';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';

const METHOD_VERIFY = 0;
const METHOD_PERSISTENT = 2;
const METHOD_TEMPORARY = 1;

// Finite D-Bus timeout: a replug mid-apply must fail the call instead of
// hanging it forever (which used to wedge the hotkeys via _busy).
const DBUS_TIMEOUT_MS = 10000;
// Watchdog slightly above the D-Bus timeout: last-resort busy release.
const WATCHDOG_MS = 12000;
// Watcher tuning: replug bursts (plus KOA/BDL EDID flips) are collapsed
// by the settle delay; our own applies stay quiet for a while after.
const SETTLE_MS = 2000;
const SELF_QUIET_US = 4000000;

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

    onMonitorsChanged(callback) {
        return this._proxy.connect('g-signal', (proxy, sender, name) => {
            if (name === 'MonitorsChanged')
                callback();
        });
    }

    offMonitorsChanged(handlerId) {
        try {
            this._proxy.disconnect(handlerId);
        } catch (e) {
            // Already disconnected.
        }
    }

    call(method, params) {
        return new Promise((resolve, reject) => {
            this._proxy.call(
                method,
                params,
                Gio.DBusCallFlags.NONE,
                DBUS_TIMEOUT_MS,
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

export default class DisplayRescueExtension extends Extension {
    enable() {
        try {
            this._settings = this.getSettings();
        } catch (e) {
            // Missing schema = packaging bug. Fail loud (ERROR state) with
            // a clear log instead of running half-dead without keybindings.
            log(`[display-rescue] settings schema missing, cannot enable: ${e.message}`);
            throw e;
        }
        this._client = new DisplayConfigClient();
        // Capture the client: on a fast disable/enable cycle an older
        // init chain must not subscribe its dead proxy over the new one.
        const client = this._client;
        this._connecting = true;
        this._starting = client.init().then(() => {
            // Subscribe only once the proxy exists; the id is released
            // in disable() so no signal connection outlives the session.
            if (this._client === client && client.ready)
                this._monitorsSignalId = client.onMonitorsChanged(() => this._onMonitorsChanged());
        }).catch(e => {
            log(`[display-rescue] DisplayConfig proxy failed: ${e.message}`);
        }).finally(() => {
            this._connecting = false;
        });
        // Busy flag bounds transient memory under key spam: one in-flight
        // apply at a time, no stacked unpacked states. Epoch discards late
        // results after disable() instead of retaining a dead client.
        this._busy = false;
        this._epoch = (this._epoch || 0) + 1;
        this._watchdog = 0;
        this._settleTimer = 0;
        this._lastSelfApply = 0;
        this._monitorsSignalId = 0;
        this._reconnecting = false;
        // Reconnect if Mutter restarts: without this the proxy stays dead
        // until the extension is toggled manually.
        this._nameWatcher = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onDisplayConfigAppeared(),
            () => log('[display-rescue] DisplayConfig service vanished'));

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
        this._reconnecting = false;
        this._connecting = false;
        if (this._nameWatcher) {
            try {
                Gio.bus_unwatch_name(this._nameWatcher);
            } catch (e) {
                // Already unwatched.
            }
            this._nameWatcher = 0;
        }
        if (this._settleTimer) {
            try {
                GLib.source_remove(this._settleTimer);
            } catch (e) {
                // Already fired or removed.
            }
            this._settleTimer = 0;
        }
        if (this._watchdog) {
            try {
                GLib.source_remove(this._watchdog);
            } catch (e) {
                // Already fired or removed.
            }
            this._watchdog = 0;
        }
        for (const key of ['mirror', 'join', 'reset']) {
            try {
                Main.wm.removeKeybinding(key);
            } catch (e) {
                // Already removed.
            }
        }
        if (this._client) {
            if (this._monitorsSignalId)
                this._client.offMonitorsChanged(this._monitorsSignalId);
            this._monitorsSignalId = 0;
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

    _onDisplayConfigAppeared() {
        // Fires once at watch time too: only reconnect a dead proxy, and
        // never race an in-flight initial init.
        if (!this._client || this._client.ready || this._reconnecting || this._connecting)
            return;
        this._reconnecting = true;
        const client = this._client;
        log('[display-rescue] DisplayConfig reappeared, reconnecting');
        client.init().then(() => {
            if (this._client === client && client.ready)
                this._monitorsSignalId = client.onMonitorsChanged(() => this._onMonitorsChanged());
        }).catch(e => {
            log(`[display-rescue] DisplayConfig reconnect failed: ${e.message}`);
        }).finally(() => {
            this._reconnecting = false;
        });
    }

    _runExclusive(action, fn) {
        if (this._busy) {
            log(`[display-rescue] ${action} ignored: another apply in flight`);
            return Promise.resolve();
        }
        this._busy = true;
        // Watchdog: if a D-Bus call hangs past its timeout (cable pulled
        // mid-apply), release the hotkeys instead of wedging them forever.
        // The epoch alive-checks inside the handlers still guard disable().
        this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
            this._watchdog = 0;
            log(`[display-rescue] ${action} timed out, releasing hotkeys`);
            this._busy = false;
            // Report the factual layout instead of a bare error: a slow
            // modeset may still have succeeded after the timeout.
            this._reportActualLayout(action).catch(e => {
                log(`[display-rescue] layout report failed: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
        return fn().catch(e => this._onError(action, e)).finally(() => {
            if (this._watchdog) {
                GLib.source_remove(this._watchdog);
                this._watchdog = 0;
            }
            this._busy = false;
        });
    }

    _alive(epoch) {
        return this._client !== null && this._epoch === epoch;
    }

    async _attemptApply(serial, logicalMonitors, properties) {
        // Stamp self-triggered reconfigures so the MonitorsChanged watcher
        // stays quiet about layouts we applied ourselves.
        this._lastSelfApply = GLib.get_monotonic_time();
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
        // NOTE: no file rewrite here on purpose. Mutter is the sole writer
        // of monitors.xml from its in-memory store and always wins a write
        // race, so a file-level purge cannot stick while the session runs.
        // Reset = backup plus safe mirror; the watcher hints if a bad
        // layout ever comes back by itself.
        warpToPrimaryCenter();
        showOsd(backupPath ? `Reset to 1080p mirror (backup kept)` : 'Reset to 1080p mirror');
        log('[display-rescue] Reset applied: 1080p mirror');
    }

    _onMonitorsChanged() {
        // Our own applies also emit this signal: stay quiet for a while.
        if (GLib.get_monotonic_time() - this._lastSelfApply < SELF_QUIET_US) {
            log('[display-rescue] MonitorsChanged ignored (self apply)');
            return;
        }
        // Collapse replug bursts into a single assessment after settle.
        if (this._settleTimer)
            GLib.source_remove(this._settleTimer);
        const epoch = this._epoch;
        this._settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleTimer = 0;
            if (this._epoch === epoch)
                this._assessAfterSettle(epoch).catch(e => {
                    log(`[display-rescue] settle assessment failed: ${e.message}`);
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    async _assessAfterSettle(epoch) {
        if (!this._alive(epoch))
            return;
        const {monitors, logicalMonitors} = await this._client.getState();
        if (!this._alive(epoch))
            return;
        let known = null;
        try {
            const [ok, bytes] = GLib.file_get_contents(monitorsXmlPath());
            if (ok)
                known = collectExternalSpecsFromXml(new TextDecoder().decode(bytes));
        } catch (e) {
            log(`[display-rescue] read monitors.xml failed: ${e.message}`);
        }
        const verdict = assessExternalLayout(monitors, logicalMonitors, known);
        if (!verdict.needsHint) {
            log('[display-rescue] settle assessment: layout looks safe');
            return;
        }
        const unknown = verdict.unknownExternal.map(s => s.join('/')).join(', ');
        log(`[display-rescue] replugged layout needs attention: unknown=[${unknown}] oversizedJoin=${verdict.oversizedJoin}`);
        showOsd('Display changed — Super+Alt+M for safe mirror');
    }

    async _reportActualLayout(action) {
        if (!this._client || !this._client.ready)
            return;
        const {logicalMonitors} = await this._client.getState();
        const members = logicalMonitors.reduce((n, lm) => n + lm[5].length, 0);
        const label = logicalMonitors.length > 1
            ? 'Join'
            : members > 1 ? 'Mirror' : 'Single';
        showOsd(`${action} timed out — now: ${label}`);
        log(`[display-rescue] ${action} timed out, actual layout: ${label}`);
    }

    _onError(action, e) {
        log(`[display-rescue] ${action} failed: ${e.message}`);
        showOsd(`${action} failed`);
    }
}
