<div align="center">

# display-rescue

**Blind-safe display mode hotkeys for GNOME: vanilla Mirror / Join plus config reset**

[![GNOME](https://img.shields.io/badge/GNOME_Shell-50-4A86CF?style=flat&logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Wayland](https://img.shields.io/badge/Wayland-only-FFBC00?style=flat)](https://wayland.freedesktop.org/)
[![GJS](https://img.shields.io/badge/GJS-ESM-729FCF?style=flat&logo=javascript&logoColor=white)](https://gjs.guide/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat)](#license)

</div>

Connecting a TV over HDMI to a laptop is a trap on GNOME: switching
`Settings → Displays` from Mirror to Join moves every window and the mouse
onto the TV, and there is no way back blind. This extension adds global
hotkeys that perform exactly the same calls as the Settings toggle, plus an
emergency reset — all working with no visible screen.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Hotkeys](#hotkeys)
- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Repository Layout](#repository-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Versions](#versions)
- [License](#license)

---

## Quick Start

```bash
# 1. Install (copies the extension into ~/.local/share/gnome-shell/extensions)
make install

# 2. Log out and back in (Wayland picks up new extensions on login)

# 3. Enable
gnome-extensions enable display-rescue@star-barsuk
```

Stuck in Join with all windows on the TV? Press `Super+Alt+M` blind —
the same Mirror call Settings would make, with an OSD confirmation on
every output.

---

## Hotkeys

| Hotkey (default) | Action |
|------------------|--------|
| `Super+Alt+M` | Vanilla Mirror: clone the same image on all outputs |
| `Super+Alt+J` | Vanilla Join: built-in display left (primary) + HDMI right, current modes kept |
| `Super+Alt+R` | Reset: back up `monitors.xml` and force a safe `1080p` mirror |

All bindings are remappable in the extension preferences. Monitor matching
is done by connector (`eDP-1`, `HDMI-1`) only, so unstable TV EDIDs
(`KOA` vs `BDL` dongle flavours) do not break switching.

After a cable replug the extension shows an OSD hint
(`Display changed — Super+Alt+M for safe mirror`) when it sees an unknown
EDID or an oversized Join. It never switches layouts by itself.

---

## How It Works

- Same D-Bus calls as Ubuntu Settings:
  `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig`
  (`verify` first, then `persistent`, `temporary` fallback).
- `Mirror` merges all outputs into one logical monitor at the largest
  common mode (preferring `1920x1080@60` for TV compatibility);
  `Join` keeps every output's current mode/scale side by side.
- No `xrandr` (does not exist on Wayland), no writes to `monitors.xml`
  (Mutter owns that file from its in-memory store and always wins a write
  race — file-level purges cannot stick while the session runs).
- Hardened for hostile timing: in-flight guard against key spam, finite
  D-Bus timeouts with watchdog release, fresh-serial retry on hotplug
  races, epoch guards against late results after disable, auto-reconnect
  if the DisplayConfig service restarts.
- Near-zero steady-state footprint: one D-Bus proxy, no timers, no actors,
  no signal subscriptions beyond the replug watcher (released on disable).

---

## Requirements

| Requirement | Version | Purpose |
|-------------|---------|---------|
| GNOME Shell | 50 | Extension API target (`metadata.json`) |
| Wayland session | any | The extension drives Mutter over D-Bus |
| `glib-compile-schemas` | any | `make build` (compiled into `schemas/`) |
| `gjs` | any (dev) | Running the unit tests (`make test`) |

---

## Repository Layout

```text
.
├── metadata.json               # uuid display-rescue@star-barsuk, GNOME 50
├── extension.js                # shell wiring: keybindings, D-Bus, OSD, watcher
├── displayLogic.js             # pure layout logic, no GNOME imports (unit-tested)
├── prefs.js                    # preferences window (hotkey remapping)
├── schemas/
│   └── org.gnome.shell.extensions.display-rescue.gschema.xml
├── tests/
│   └── run.js                  # gjs assertions over displayLogic.js
├── Makefile                    # build / install / test / lint / zip
├── README.md
└── .gitignore
```

---

## Development

```bash
make test    # gjs unit tests for the pure layout logic
make lint    # tests + metadata.json + schema XML validation
make build   # glib-compile-schemas schemas
make install # build + copy into ~/.local/share/gnome-shell/extensions
make zip     # distribution archive for extensions.gnome.org
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Black laptop screen after Join, windows only on TV | Expected Mutter behaviour — press `Super+Alt+M` blind to return to Mirror |
| OSD `Display changed — Super+Alt+M for safe mirror` after replug | Unknown EDID or oversized Join detected; press `Super+Alt+M` if the picture is wrong, ignore otherwise |
| Hotkey does nothing, log says `another apply in flight` | Previous apply still running (slow modeset); wait a few seconds and retry |
| Log says `timed out — now: <layout>` | D-Bus call hung (cable pulled mid-apply); hotkeys were released, the OSD names the factual layout |
| `Join needs 2 outputs` | Only one output connected |
| Extension in ERROR state after login | Missing settings schema (broken install); reinstall via `make install` and log out/in |
| Bad `4K` Join returns by itself after EDID flip | Stored per-EDID config auto-applied by Mutter; fix blind with `Super+Alt+M` |

Live log for diagnosis:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep display-rescue
```

---

## Versions

| Commit | Date | Changes |
|--------|------|---------|
| `3e9bfcf` | 2026-09-12 | Remove file purge (loses to Mutter), harden lifecycle: ghost-free subscribe, reconnect, settings guard, watchdog layout report |
| `769769f` | 2026-09-12 | Replug watcher with blind hint, no auto-switching |
| `bbe4b29` | 2026-09-12 | Finite D-Bus timeouts, watchdog, unconditional busy reset |
| `dc4ee4c` | 2026-09-12 | Memory optimization: lean index, lifecycle release, `displayLogic.js` + tests |
| `7bd3a51` | 2026-09-12 | Initial release: vanilla Mirror/Join hotkeys plus config reset |

---

## License

MIT © 2026 Star-Barsuk
