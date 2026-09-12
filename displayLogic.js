// Pure display-layout logic for Display Rescue.
//
// This module has no GNOME imports on purpose: it runs under plain gjs
// so `make test` can exercise it without a live shell session.
// All inputs are plain unpacked D-Bus structures, all outputs are plain
// values ready to be packed into ApplyMonitorsConfig calls.

export const SAFE_W = 1920;
export const SAFE_H = 1080;
export const SAFE_SCALE = 1.0;
export const TRANSFORM_NORMAL = 0;
export const LAYOUT_LOGICAL = 1;

export function isBuiltinConnector(connector) {
    return /^(eDP|LVDS)/.test(connector);
}

export function buildConnectorIndex(monitors) {
    // monitors: [ [spec, modes, props], ... ]
    // spec: [connector, vendor, product, serial]
    // Lean entries on purpose: only the fields needed for mode selection
    // are retained, the unpacked per-mode property dicts are dropped so a
    // hotkey press holds no more than necessary while building the payload.
    const index = new Map();
    for (const entry of monitors) {
        const spec = entry[0];
        const modes = entry[1];
        const connector = spec[0];
        let current = null;
        let preferred = null;
        const leanModes = [];
        for (const mode of modes) {
            const props = mode[6];
            const lean = {
                modeId: mode[0],
                width: mode[1],
                height: mode[2],
                refresh: mode[3],
                preferredScale: mode[4],
                supportedScales: mode[5],
                isCurrent: !!(props && props['is-current']),
                isPreferred: !!(props && props['is-preferred']),
            };
            leanModes.push(lean);
            if (lean.isCurrent)
                current = lean;
            if (lean.isPreferred)
                preferred = lean;
        }
        index.set(connector, {spec, modes: leanModes, current, preferred});
    }
    return index;
}

export function currentScaleFor(logicalMonitors, connector) {
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

export function pickModeId(entry, width, height) {
    // Prefer exact size at 60Hz, prefer is-current within that size.
    const sized = entry.modes.filter(m => m.width === width && m.height === height);
    if (sized.length === 0)
        return null;
    const at60 = sized.filter(m => Math.abs(m.refresh - 60.0) < 0.5);
    const pool = at60.length > 0 ? at60 : sized;
    const current = pool.find(m => m.isCurrent);
    if (current)
        return current.modeId;
    const preferred = pool.find(m => m.isPreferred);
    if (preferred)
        return preferred.modeId;
    return pool[0].modeId;
}

export function findCommonSize(index) {
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

export function orderConnectors(connectors) {
    // Built-in first as primary (vanilla Settings behavior), then HDMI/others sorted.
    const score = c => {
        if (isBuiltinConnector(c))
            return 0;
        if (c.startsWith('HDMI'))
            return 1;
        if (c.startsWith('DP'))
            return 2;
        return 3;
    };
    return [...connectors].sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1));
}

export function buildMirrorMembers(index, connectors) {
    // One shared mode size for the whole clone group (vanilla Mirror rule).
    const common = findCommonSize(index) || {width: SAFE_W, height: SAFE_H};
    const members = [];
    for (const connector of connectors) {
        const entry = index.get(connector);
        const modeId = pickModeId(entry, common.width, common.height)
            || (entry.current && entry.current.modeId)
            || (entry.preferred && entry.preferred.modeId)
            || entry.modes[0].modeId;
        members.push([connector, modeId, {}]);
    }
    return {members, common};
}

export function buildJoinMonitors(index, connectors, currentLogical) {
    // Vanilla extend: keep each output current mode/scale, place side by side.
    const logicalMonitors = [];
    let x = 0;
    connectors.forEach((connector, i) => {
        const entry = index.get(connector);
        const modeId = (entry.current && entry.current.modeId)
            || (entry.preferred && entry.preferred.modeId)
            || entry.modes[0].modeId;
        const mode = entry.modes.find(m => m.modeId === modeId) || entry.modes[0];
        let scale = currentScaleFor(currentLogical, connector);
        if (!Number.isFinite(scale) || scale <= 0)
            scale = SAFE_SCALE;
        if (!mode.supportedScales.includes(scale))
            scale = mode.preferredScale || SAFE_SCALE;
        logicalMonitors.push([x, 0, scale, TRANSFORM_NORMAL, i === 0, [[connector, modeId, {}]]]);
        x += Math.round(mode.width / scale);
    });
    return logicalMonitors;
}

export function collectExternalSpecsFromXml(text) {
    // Harvest every non-built-in monitorspec ever stored, so the watcher
    // can tell a never-seen EDID from a known one (read-only use).
    const specs = [];
    const re = /<monitor>\s*<monitorspec>\s*<connector>([^<]*)<\/connector>\s*<vendor>([^<]*)<\/vendor>\s*<product>([^<]*)<\/product>\s*<serial>([^<]*)<\/serial>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (isBuiltinConnector(m[1]))
            continue;
        specs.push([m[1], m[2], m[3], m[4]]);
    }
    return specs;
}

export function assessExternalLayout(liveMonitors, logicalMonitors, knownExternalSpecs) {
    // Decides whether the user needs a blind hint after a replug, without
    // ever switching anything automatically. Returns plain data so the
    // shell side only formats and shows it.
    // liveMonitors: raw unpacked GetCurrentState entries [spec, modes, props].
    // knownExternalSpecs: specs harvested from monitors.xml history.
    // null history means "unreadable": skip the unknown check instead of
    // flagging every external output (avoids hint spam on a broken file).
    const known = knownExternalSpecs
        ? new Set(knownExternalSpecs.map(s => s.join('|')))
        : null;
    const unknownExternal = [];
    let oversizedJoin = false;
    const joined = logicalMonitors.length > 1;
    for (const entry of liveMonitors) {
        const spec = entry[0];
        const modes = entry[1];
        const props = entry[2];
        if ((props && props['is-builtin']) || isBuiltinConnector(spec[0]))
            continue;
        if (known && !known.has(spec.join('|')))
            unknownExternal.push(spec);
        const current = modes.find(m => m[6] && m[6]['is-current']) || modes[0];
        if (joined && current && current[1] > SAFE_W)
            oversizedJoin = true;
    }
    return {unknownExternal, oversizedJoin, needsHint: unknownExternal.length > 0 || oversizedJoin};
}
