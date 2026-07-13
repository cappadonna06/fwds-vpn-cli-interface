<!--
  Maintainer note (not shown when this renders): this is the customer- and
  field-facing release log. Keep it in plain language — what changed for the
  person using the app, not how the code changed. On each release: add a new
  "## vX.Y.Z — <Month Year>" section at the top under New / Improved / Fixed,
  bump the version in package.json and src-tauri/tauri.conf.json, and tag the
  release commit (git tag vX.Y.Z).
-->

# FWDS Controller Console — Release Notes

The latest updates to the console, in plain terms for the people who use it in the field.

## v0.2.0 — July 2026

A new way to reach a controller, two new tools, a fresh look, and clearer diagnostics.

### New

- **Local Connect (SSH).** Reach a controller on the same local network without bringing up the VPN. The console can find the controller for you, so there's no address to type in.
- **SD Card Maker.** Write a controller SD card image right from the console, under a new Additional Tools section in the sidebar.
- **LED Decoder.** Enter what the controller's front-panel lights are doing and get back what they mean, with severity. Also under Additional Tools.
- **Connection preflight checks.** Before you connect, the console makes sure the tools a connection needs are installed, and tells you up front (with the exact fix) if anything is missing, instead of failing partway through.

### Improved

- **A new look and feel.** The whole interface moved to the Frontline Wildfire Defense design system: updated logos, colors, typography, and layout.

### Fixed

- **Cellular diagnostics now read true.** The card separates three cases that used to blur together: no modem detected (a hardware fault), no service (the modem is fine but can't attach; check antenna, coverage, or SIM), and a modem that isn't responding. A healthy modem in a no-coverage area is no longer flagged as failed hardware.

## v0.1.2 — April 2026

The first released version of the console.

- Connect to a Mark I controller over VPN from your Mac or PC.
- Run controller command blocks and read the results back.
- Tabs for Connect, Commands, Setup Wizard, System Configuration, Diagnostics, and Report.
- Status cards for Wi-Fi, cellular, ethernet, and satellite, plus pressure and firmware.
- SIM Picker for checking which cellular carrier has coverage.
- Session reports you can share, including Slack-formatted output.
