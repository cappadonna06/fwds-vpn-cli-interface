# Frontline Remote Controller Console - Command Catalog

## Purpose

This document describes the controller commands the app currently exposes as presets, plus additional commands that should remain documented for operator reference.

## Preset commands currently exposed in the UI

### Setup-oriented

- `setup`
- `setup-station`
- `setup-system`
- `setup-network`

### Connectivity and diagnostics

- `wifi-check`
- `cellular-check`
- `ethernet-check`
- `satellite-check -m`
- `cell-signal`
- `wifi-signal`

### Identification and versioning

- `sid`
- `version`
- `release`

### System control

- `reboot`

## Command notes

### `setup`

- Use for first-time or broad controller setup
- Treat as the top-level guided path
- Expect interactive prompts

### `setup-station`

- Focused on station/site metadata
- Safer than system-level reconfiguration
- Still should be operator-reviewed

### `setup-system`

- Potentially destructive on an already configured controller
- Should be treated as a guarded action in a future revision of the app

### `setup-network`

- Focused on connectivity changes
- Good entry point for Wi-Fi, Ethernet, cellular, or satellite changes without broader system changes

### `wifi-check`, `cellular-check`, `ethernet-check`, `satellite-check -m`

- Useful for post-setup validation and troubleshooting
- Best used after relevant setup changes and expected reconnect/reboot steps

### `cell-signal`, `wifi-signal`

- Useful for focused link-quality checks

### `sid`, `version`, `release`

- Useful for basic controller identification and build verification

### `reboot`

- Use only when the setup step or troubleshooting path calls for it
- Operators should expect the current remote session to drop

## Additional documented commands not currently exposed as presets

These remain useful to document even though v1 does not expose them as quick-action buttons:

- `setup-ethernet`
- `setup-wifi`
- `setup-cellular`
- `setup-satellite`
- `setup-preferred-network`
- `setup-server`
- `factory-reset`
- `factory-reset-network`
- `exit`
- `logout`
- `help`

## UX guidance

### Safe/common commands

Show prominently:

- `setup`
- `setup-network`
- `wifi-check`
- `cellular-check`
- `ethernet-check`
- `satellite-check -m`
- `cell-signal`
- `wifi-signal`
- `sid`
- `version`
- `release`
- `reboot`

### Guarded commands

Treat as support-only or confirmation-required in future revisions:

- `setup-system` on an already-configured controller
- `setup-server`
- `factory-reset`
- `factory-reset-network`

## Current app limitation

The app currently sends explicit SSH commands and shows output in the shared log pane. It does not yet provide a persistent interactive shell or command-specific confirmation modals.
