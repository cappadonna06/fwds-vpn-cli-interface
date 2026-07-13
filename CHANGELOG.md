<!--
  MAINTAINER NOTES (not shown to external readers who read the rendered doc):
  - This is the EXTERNAL-facing changelog. Write entries for technicians/field users,
    not developers. Describe what changed in the app, not how the code changed.
    Keep internal detail (commit refs, refactors, PR mechanics) in PRs and Docs/.
  - On each release: rename "Unreleased" to the version + date, bump the version in
    package.json and src-tauri/tauri.conf.json to match, and TAG the release commit:
        git tag -a v0.2.0 <commit> -m "v0.2.0"  &&  git push origin v0.2.0
    (No tags existed before v0.2.0 — v0.1.2 was tagged retroactively at 208350f.)
  - Group changes under Added / Changed / Fixed. Newest version on top.
-->

# Changelog

All notable, user-visible changes to the **FWDS Controller Console** are recorded here.
This is the external-facing log for technicians and field users; internal engineering
detail lives in the pull requests and `Docs/`.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased] — targeting v0.2.0

The first release since v0.1.2. Adds a new way to reach a controller, two new tools,
a full visual refresh, and clearer diagnostics.

### Added
- **Local Connect (SSH) mode** — connect to a controller on the **same local network**
  without bringing up the VPN. Includes **automatic controller discovery**: it finds the
  controller for you, so there's no address to type in.
- **SD Card Maker** — write a controller SD card image directly from the console, under
  a new **Additional Tools** section in the sidebar.
- **LED Decoder tool** (under Additional Tools) — enter what the controller's front-panel
  LEDs are doing and get back what it means, with severity.
- **Connection preflight warnings** — before you connect, the console checks that the
  tools a connection needs are present and warns you up front, with the exact fix, if
  something's missing — instead of failing partway through.

### Changed
- **New Frontline Wildfire Defense look-and-feel** — the entire interface was rebranded
  to the Frontline design system (logos, colors, typography, layout).

### Fixed
- **Cellular diagnostics are now accurate.** The card cleanly separates three cases that
  used to blur together: **no modem detected** (a hardware fault — reboot, then service),
  **no service** (modem is fine but can't attach — antenna, coverage, or SIM), and a
  **modem that isn't responding**. A healthy modem sitting in a no-coverage area is no
  longer mislabeled as failed hardware.

---

## [0.1.2] — 2026-04-24 (macOS) / 2026-04-27 (Windows)

First documented release. This is the build shipped in the initial installer package
(`FWDS Controller Console_0.1.2` — universal `.dmg` for macOS, `x64`/`arm64` `.msi`
for Windows). It corresponds to commit `208350f`.

> Note: this version was tagged retroactively while establishing this changelog — there
> was no git tag or release PR at the time it shipped.

Baseline capabilities at this release:

- **Connect to a Mark I (WFDS) controller over OpenVPN** from the desktop console
  (available for macOS and Windows).
- **Run and copy on-target CLI command blocks** and read the results back.
- **Tabs:** Session, Commands, Wizard, System Configuration, Diagnostics, and Report.
- **Parsed diagnostic cards** for connectivity — Wi-Fi, cellular, ethernet, and
  satellite checks — plus pressure and firmware-version cards.
- **SIM Picker / carrier scan** for cellular setup and troubleshooting.
- **Report export** (including Slack-formatted output) for sharing diagnostic results.

<!-- Everything prior to 0.1.2 (0.1.1 macOS release, 0.1.0 line) predates this changelog
     and was never released with external notes. Reconstruct from git history if needed. -->
