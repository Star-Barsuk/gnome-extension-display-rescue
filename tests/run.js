// Unit tests for displayLogic.js. Runs under plain gjs, no shell session.
// Fails fast with a nonzero exit code on the first broken expectation.

import {
    assessExternalLayout,
    buildConnectorIndex,
    buildJoinMonitors,
    buildMirrorMembers,
    collectExternalSpecsFromXml,
    findCommonSize,
    orderConnectors,
    pickModeId,
} from '../displayLogic.js';

let passed = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        printerr(`FAIL ${name}\n  actual:   ${a}\n  expected: ${e}\n`);
        throw new Error(`test failed: ${name}`);
    }
    passed += 1;
    print(`ok ${name}`);
}

// Two outputs sharing 1080p, TV also offering 4K.
const MONITORS = [
    [['eDP-1', 'CSO', '0x142e', '0x00000000'], [
        ['1920x1080@60.000', 1920, 1080, 60.0, 1.0, [1.0, 1.25, 2.0],
            {'is-current': true, 'is-preferred': true}],
        ['1280x720@59.855', 1280, 720, 59.855, 1.0, [1.0], {}],
    ], {'is-builtin': true}],
    [['HDMI-1', 'KOA', 'OneMeeting', '0x00000001'], [
        ['3840x2160@60.000', 3840, 2160, 60.0, 1.0, [1.0, 2.0], {'is-preferred': true}],
        ['1920x1080@60.000', 1920, 1080, 60.0, 1.0, [1.0, 2.0], {'is-current': true}],
    ], {'is-builtin': false}],
];
const LOGICAL_MIRROR = [[0, 0, 1.0, 0, true,
    [['eDP-1', 'CSO', '0x142e', '0x00000000'], ['HDMI-1', 'KOA', 'OneMeeting', '0x00000001']], {}]];

const index = buildConnectorIndex(MONITORS);
check('index connectors', [...index.keys()], ['eDP-1', 'HDMI-1']);
check('index lean mode keeps flags only',
    index.get('eDP-1').modes[0],
    {modeId: '1920x1080@60.000', width: 1920, height: 1080, refresh: 60.0,
        preferredScale: 1.0, supportedScales: [1.0, 1.25, 2.0],
        isCurrent: true, isPreferred: true});
check('index drops raw props dict', 'modeProps' in index.get('eDP-1').modes[0], false);

check('order puts builtin first', orderConnectors(['HDMI-1', 'DP-1', 'eDP-1']), ['eDP-1', 'HDMI-1', 'DP-1']);
check('common size prefers 1080p', findCommonSize(index), {width: 1920, height: 1080});
check('pick 1080p@60 on TV', pickModeId(index.get('HDMI-1'), 1920, 1080), '1920x1080@60.000');
check('pick missing size', pickModeId(index.get('HDMI-1'), 800, 600), null);

const mirror = buildMirrorMembers(index, ['eDP-1', 'HDMI-1']);
check('mirror common', mirror.common, {width: 1920, height: 1080});
check('mirror members', mirror.members,
    [['eDP-1', '1920x1080@60.000', {}], ['HDMI-1', '1920x1080@60.000', {}]]);

const join = buildJoinMonitors(index, ['eDP-1', 'HDMI-1'], LOGICAL_MIRROR);
check('join layout', join,
    [[0, 0, 1.0, 0, true, [['eDP-1', '1920x1080@60.000', {}]]],
        [1920, 0, 1.0, 0, false, [['HDMI-1', '1920x1080@60.000', {}]]]]);

const xmlSample = '<monitors version="2">'
    + '<configuration><logicalmonitor>'
    + '<monitor><monitorspec><connector>HDMI-1</connector><vendor>KOA</vendor>'
    + '<product>OneMeeting</product><serial>0x00000001</serial></monitorspec></monitor>'
    + '<monitor><monitorspec><connector>HDMI-1</connector><vendor>BDL</vendor>'
    + '<product>OneMeeting</product><serial>0x01010101</serial></monitorspec></monitor>'
    + '<monitor><monitorspec><connector>eDP-1</connector><vendor>CSO</vendor>'
    + '<product>0x142e</product><serial>0x00000000</serial></monitorspec></monitor>'
    + '</logicalmonitor></configuration></monitors>';
check('collect skips builtin', collectExternalSpecsFromXml(xmlSample),
    [['HDMI-1', 'KOA', 'OneMeeting', '0x00000001'],
        ['HDMI-1', 'BDL', 'OneMeeting', '0x01010101']]);

// Watcher decision logic: replug assessment.
const JOIN_4K_LOGICAL = [
    [0, 0, 1.25, 0, true, [['eDP-1', 'CSO', '0x142e', '0x00000000']], {}],
    [1536, 0, 1.0, 0, false, [['HDMI-1', 'BDL', 'OneMeeting', '0x01010101']], {}],
];
const MONITORS_BDL_4K = [
    MONITORS[0],
    [['HDMI-1', 'BDL', 'OneMeeting', '0x01010101'], [
        ['3840x2160@30.000', 3840, 2160, 30.0, 1.0, [1.0],
            {'is-current': true, 'is-preferred': true}],
        ['1920x1080@60.000', 1920, 1080, 60.0, 1.0, [1.0], {}],
    ], {'is-builtin': false}],
];
const KNOWN = [['HDMI-1', 'KOA', 'OneMeeting', '0x00000001']];

const badFlip = assessExternalLayout(MONITORS_BDL_4K, JOIN_4K_LOGICAL, KNOWN);
check('flip flags unknown EDID', badFlip.unknownExternal,
    [['HDMI-1', 'BDL', 'OneMeeting', '0x01010101']]);
check('flip flags oversized join', badFlip.oversizedJoin, true);
check('flip needs hint', badFlip.needsHint, true);

const cleanMirror = assessExternalLayout(MONITORS, LOGICAL_MIRROR, KNOWN);
check('known mirror needs no hint', cleanMirror.needsHint, false);

const JOIN_1080_LOGICAL = [
    [0, 0, 1.0, 0, true, [['eDP-1', 'CSO', '0x142e', '0x00000000']], {}],
    [1920, 0, 1.0, 0, false, [['HDMI-1', 'KOA', 'OneMeeting', '0x00000001']], {}],
];
const cleanJoin = assessExternalLayout(MONITORS, JOIN_1080_LOGICAL, KNOWN);
check('known 1080p join needs no hint', cleanJoin.needsHint, false);

const unreadableHistory = assessExternalLayout(MONITORS, LOGICAL_MIRROR, null);
check('unreadable history skips unknown check', unreadableHistory.needsHint, false);

print(`\n${passed} assertions passed`);
