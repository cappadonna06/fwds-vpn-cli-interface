<!--
  Maintainer note (not shown when this renders): customer- and field-facing
  release log. Keep it plain — what changed for the person using the app, not
  how the code changed. New changes go under [Unreleased]. See RELEASING.md for
  the changelog + release-PR process.
-->

# FWDS Controller Console — Release Notes

The latest updates to the console, in plain terms for the people who use it in the field.

## [Unreleased]

### Fixed

- **No false wiring warning on an unpressurized system.** With no pressure in the lines, the source and distribution readings both hover near zero (the source often reads slightly negative), and the System Pressure card used to misread that as a P2/P3 sensor swap and tell you to check the wiring at the controller. It now flags a possible swap only when there's a genuine, non-zero reading showing distribution above source or supply — a truly dead source is still reported.

## [0.2.1] — July 2026

The first update since April's 0.1.2 — a new way to reach a controller, two new tools, a fresh look, clearer diagnostics, and stronger session-log privacy.

### New

- **Local Connect (SSH).** Reach a controller on the same local network without bringing up the VPN. The console can find the controller for you, so there's no address to type in.
- **SD Card Maker.** Write a controller SD card image right from the console, under a new Additional Tools section in the sidebar.
- **LED Decoder.** Enter what the controller's front-panel lights are doing and get back what they mean, with severity. Also under Additional Tools.
- **Connection preflight checks.** Before you connect, the console makes sure the tools a connection needs are installed, and tells you up front (with the exact fix) if anything is missing, instead of failing partway through.

### Improved

- **A new look and feel.** The whole interface moved to the Frontline Wildfire Defense design system: updated logos, colors, typography, and layout.

### Fixed

- **Cellular diagnostics now read true.** The card separates three cases that used to blur together: no modem detected (a hardware fault), no service (the modem is fine but can't attach; check antenna, coverage, or SIM), and a modem that isn't responding. A healthy modem in a no-coverage area is no longer flagged as failed hardware.

### Privacy & security

- **Session logs stay private.** Session transcripts are now kept in the console's own private storage instead of on your Desktop, so they no longer sync to iCloud. Secrets like Wi-Fi passwords are hidden automatically before anything is written, and logs older than two weeks clear out on their own.
- **You decide whether to log.** A new Settings tab lets you turn session logging off entirely, and shows you exactly where the log files are kept.

## [0.1.2] — April 2026

The first released version of the console.

- Connect to a Mark I controller over VPN from your Mac or PC.
- Run controller command blocks and read the results back.
- Tabs for Connect, Commands, Setup Wizard, System Configuration, Diagnostics, and Report.
- Status cards for Wi-Fi, cellular, ethernet, and satellite, plus pressure and firmware.
- SIM Picker for checking which cellular carrier has coverage.
- Session reports you can share, including Slack-formatted output.
