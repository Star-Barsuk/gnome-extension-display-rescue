import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const LAYOUT_LOGICAL = 1;

const METHOD_VERIFY = 0;
const METHOD_PERSISTENT = 2;
const METHOD_TEMPORARY = 1;

const TRANSFORM_NORMAL = 0;
const SAFE_W = 1920;
const SAFE_H = 1080;
const SAFE_SCALE = 1.0;

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

function buildConnectorIndex(monitors) {
    // monitors: [ [spec, modes, props], ... ]
    // spec: [connector, vendor, product, serial]
    const index = new Map();
    for (const entry of monitors) {
        const [spec, modes] = entry;
        const connector = spec[0];
        let current = null;
        let preferred = null;
        for (const mode of modes) {
            const [modeId, width, height, refresh, preferredScale, supportedScales, modeProps] = mode;
            const info = {modeId, width, height, refresh, preferredScale, supportedScales, modeProps};
            if (modeProps && modeProps['is-current'])
                current = info;
            if (modeProps && modeProps['is-preferred'])
                preferred = info;
        }
        index.set(connector, {
            spec,
            modes: modes.map(m => ({
                modeId: m[0],
                width: m[1],
                height: m[2],
                refresh: m[3],
                preferredScale: m[4],
                supportedScales: m[5],
                modeProps: m[6],
            })),
            current,
            preferred,
        });
    }
    return index;
}

function currentScaleFor(logicalMonitors, connector) {
    for (const lm of logicalMonitors) {
        const scale = lm[2];
        const members = lm[5];
        for (const m of members) {
            if (m[0] === connector)
                return scale;
        }
    }
    return SAFE_SCALE;
}

function pickModeId(entry, width, height) {
    // Prefer exact size at 60Hz, prefer is-current within that size.
    const sized = entry.modes.filter(m => m.width === width && m.height === height);
    if (sized.length === 0)
        return null;
    const at60 = sized.filter(m => Math.abs(m.refresh - 60.0) < 0.5);
    const pool = at60.length > 0 ? at60 : sized;
    const current = pool.find(m => m.modeProps && m.modeProps['is-current']);
    if (current)
        return current.modeId;
    const preferred = pool.find(m => m.modeProps && m.modeProps['is-preferred']);
    if (preferred)
        return preferred.modeId;
    return pool[0].modeId;
}

function findCommonSize(index) {
    // Intersection of WxH across all outputs, largest first.
    const lists = [...index.values()].map(e => e.modes.map(m => `${m.width}x${m.height}`));
    if (lists.length === 0)
        return null;
    const counts = new Map();
    for (const list of lists) {
        for (const size of new Set(list))
            counts.set(size, (counts.get(size) || 0) + 1);
    }
    const common = [...counts.entries()]
        .filter(([, n]) => n === lists.length)
        .map(([size]) => size);
    if (common.length === 0)
        return null;
    // Prefer 1920x1080 for TV compatibility, else largest area.
    if (common.includes(`${SAFE_W}x${SAFE_H}`))
        return {width: SAFE_W, height: SAFE_H};
    common.sort((a, b) => {
        const [aw, ah] = a.split('x').map(Number);
        const [bw, bh] = b.split('x').map(Number);
        return bw * bh - aw * ah;
    });
    const [width, height] = common[0].split('x').map(Number);
    return {width, height};
}

function orderConnectors(connectors) {
    // Built-in first as primary (vanilla Settings behavior), then HDMI/others sorted.
    const score = c => {
        if (c.startsWith('eDP') || c.startsWith('LVDS'))
            return 0;
        if (c.startsWith('HDMI'))
            return 1;
        if (c.startsWith('DP'))
            return 2;
        return 3;
    };
    return [...connectors].sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1));
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

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function collectExternalSpecsFromXml(text) {
    // Harvest every non-built-in monitorspec ever stored, so a future
    // EDID flip (KOA vs BDL dongles) still matches a safe mirror config.
    const specs = [];
    const re = /<monitor>\s*<monitorspec>\s*<connector>([^<]*)<\/connector>\s*<vendor>([^<]*)<\/vendor>\s*<product>([^<]*)<\/product>\s*<serial>([^<]*)<\/serial>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (/^(eDP|LVDS)/.test(m[1]))
            continue;
        specs.push([m[1], m[2], m[3], m[4]]);
    }
    return specs;
}

function buildSafeMirrorsXml(builtinSpec, builtinMode, externalSpecs) {
    const monitorBlock = (spec, w, h, rate) => `      <monitor>
        <monitorspec>
          <connector>${escapeXml(spec[0])}</connector>
          <vendor>${escapeXml(spec[1])}</vendor>
          <product>${escapeXml(spec[2])}</product>
          <serial>${escapeXml(spec[3])}</serial>
        </monitorspec>
        <mode>
          <width>${w}</width>
          <height>${h}</height>
          <rate>${rate}</rate>
        </mode>
      </monitor>`;
    const builtinBlock = monitorBlock(builtinSpec, builtinMode.width, builtinMode.height, builtinMode.rate);
    const parts = externalSpecs.map(ext => `  <configuration>
    <layoutmode>logical</layoutmode>
    <logicalmonitor>
      <x>0</x>
      <y>0</y>
      <scale>1</scale>
      <primary>yes</primary>
${builtinBlock}
${monitorBlock(ext, SAFE_W, SAFE_H, '60.000')}
    </logicalmonitor>
  </configuration>`);
    if (parts.length === 0) {
        parts.push(`  <configuration>
    <layoutmode>logical</layoutmode>
    <logicalmonitor>
      <x>0</x>
      <y>0</y>
      <scale>1</scale>
      <primary>yes</primary>
${builtinBlock}
    </logicalmonitor>
  </configuration>`);
    }
    return `<monitors version="2">\n${parts.join('\n')}\n</monitors>\n`;
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
        this._settings = this.getSettings();
        this._client = new DisplayConfigClient();
        this._starting = this._client.init().catch(e => {
            log(`[display-rescue] DisplayConfig proxy failed: ${e.message}`);
        });

        this._mirrorHandler = () => this._onMirror().catch(e => this._onError('Mirror', e));
        this._joinHandler = () => this._onJoin().catch(e => this._onError('Join', e));
        this._resetHandler = () => this._onReset().catch(e => this._onError('Reset', e));

        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('mirror', this._settings, flags, mode, this._mirrorHandler);
        Main.wm.addKeybinding('join', this._settings, flags, mode, this._joinHandler);
        Main.wm.addKeybinding('reset', this._settings, flags, mode, this._resetHandler);
    }

    disable() {
        for (const key of ['mirror', 'join', 'reset']) {
            try {
                Main.wm.removeKeybinding(key);
            } catch (e) {
                // Already removed.
            }
        }
        this._mirrorHandler = null;
        this._joinHandler = null;
        this._resetHandler = null;
        this._client = null;
        this._settings = null;
        this._starting = null;
    }

    async _ready() {
        if (this._starting)
            await this._starting;
        if (!this._client || !this._client._proxy)
            throw new Error('DisplayConfig service unavailable');
    }

    async _applyWithVerify(serial, logicalMonitors, properties) {
        // Verify first (no side effects), then persist like Settings does.
        try {
            await this._client.apply(serial, METHOD_VERIFY, logicalMonitors, properties);
        } catch (e) {
            log(`[display-rescue] verify rejected, trying direct apply: ${e.message}`);
        }
        try {
            await this._client.apply(serial, METHOD_PERSISTENT, logicalMonitors, properties);
        } catch (e) {
            // Fall back to temporary so blind users still get a picture.
            await this._client.apply(serial, METHOD_TEMPORARY, logicalMonitors, properties);
        }
    }

    async _onMirror() {
        await this._ready();
        const {serial, monitors} = await this._client.getState();
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);
        if (connectors.length === 0)
            throw new Error('no outputs found');

        const common = findCommonSize(index) || {width: SAFE_W, height: SAFE_H};
        const members = [];
        for (const connector of connectors) {
            const modeId = pickModeId(index.get(connector), common.width, common.height)
                || index.get(connector).current?.modeId
                || index.get(connector).preferred?.modeId
                || index.get(connector).modes[0].modeId;
            members.push([connector, modeId, {}]);
        }
        const logicalMonitors = [[0, 0, SAFE_SCALE, TRANSFORM_NORMAL, true, members]];
        const properties = {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)};
        await this._applyWithVerify(serial, logicalMonitors, properties);
        warpToPrimaryCenter();
        showOsd(`Mirror ${common.width}x${common.height}`);
    }

    async _onJoin() {
        await this._ready();
        const {serial, monitors, logicalMonitors: currentLogical} = await this._client.getState();
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);
        if (connectors.length < 2) {
            showOsd('Join needs 2 outputs');
            return;
        }

        // Vanilla behavior: keep each output current mode/scale, place side by side.
        const logicalMonitors = [];
        let x = 0;
        connectors.forEach((connector, i) => {
            const entry = index.get(connector);
            const modeId = entry.current?.modeId || entry.preferred?.modeId || entry.modes[0].modeId;
            const mode = entry.modes.find(m => m.modeId === modeId) || entry.modes[0];
            let scale = currentScaleFor(currentLogical, connector);
            if (!Number.isFinite(scale) || scale <= 0)
                scale = SAFE_SCALE;
            if (!mode.supportedScales.includes(scale))
                scale = mode.preferredScale || SAFE_SCALE;
            const primary = i === 0;
            logicalMonitors.push([x, 0, scale, TRANSFORM_NORMAL, primary, [[connector, modeId, {}]]]);
            x += Math.round(mode.width / scale);
        });
        const properties = {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)};
        await this._applyWithVerify(serial, logicalMonitors, properties);
        warpToPrimaryCenter();
        showOsd('Join (extend)');
    }

    async _onReset() {
        await this._ready();
        const backupPath = backupMonitorsXml();
        const {serial, monitors} = await this._client.getState();
        const index = buildConnectorIndex(monitors);
        const connectors = orderConnectors([...index.keys()]);

        const members = [];
        for (const connector of connectors) {
            const entry = index.get(connector);
            const modeId = pickModeId(entry, SAFE_W, SAFE_H)
                || entry.current?.modeId
                || entry.modes[0].modeId;
            members.push([connector, modeId, {}]);
        }
        if (members.length === 0)
            throw new Error('no outputs found');
        const logicalMonitors = [[0, 0, SAFE_SCALE, TRANSFORM_NORMAL, true, members]];
        const properties = {'layout-mode': GLib.Variant.new_uint32(LAYOUT_LOGICAL)};
        await this._applyWithVerify(serial, logicalMonitors, properties);
        // Purge stale configs (e.g. the 4K Join) so the next hotplug or
        // EDID flip cannot resurrect the bad layout automatically.
        try {
            this._purgeStaleConfigs(monitors);
        } catch (e) {
            log(`[display-rescue] purge failed: ${e.message}`);
        }
        warpToPrimaryCenter();
        showOsd(backupPath ? `Reset to 1080p mirror (backup kept)` : 'Reset to 1080p mirror');
    }

    _purgeStaleConfigs(liveMonitors) {
        let builtinSpec = null;
        let builtinMode = {width: SAFE_W, height: SAFE_H, rate: '60.000'};
        for (const entry of liveMonitors) {
            const spec = entry[0];
            const modes = entry[1];
            const props = entry[2];
            const isBuiltin = (props && props['is-builtin']) || /^(eDP|LVDS)/.test(spec[0]);
            if (isBuiltin && !builtinSpec) {
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
            const isBuiltin = (props && props['is-builtin']) || /^(eDP|LVDS)/.test(spec[0]);
            if (!isBuiltin)
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
