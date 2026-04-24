# `installer-main` Diagnostic Rules

This document records the current diagnostic rule set implemented in `installer-main`.

Source of truth used:

- rules: [controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:2)
- operator-facing issue text: [app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:214)

## Severity Model

`installer-main` produces a flat issue list. Each rule returns one of:

- `:ok`
- `{:warning, issue_key}`
- `{:critical, issue_key}`

The UI renders these as issue rows with severity icons:

- `:critical` = red / critical
- `:warning` = amber / warning

There is no separate neutral, inactive, healthy, or not-validated card model in this app. If a rule does not fire, nothing is shown for that condition.

## Rule Inventory

The app currently evaluates these rule families:

1. Pressure thresholds and pressure wiring
2. Network offline / poor wireless signal
3. Heartbeat freshness
4. Controller current state
5. Water flow while active
6. Satellite loopback presence / staleness
7. Power / voltage
8. Firmware freshness

## Rule Matrix

| Subsystem | Issue key | Severity | Trigger | Operator text |
| --- | --- | --- | --- | --- |
| Pressure | `main_pressure_bad_wiring` | Critical | `main_pressure > 220` | `Main pressure sensor appears to be disconnected or miswired` |
| Pressure | `main_pressure_high` | Critical | `main_pressure > 150` | `Main pressure is high, please reduce pressure` |
| Pressure | `manifold_pressure_bad_wiring` | Critical | `manifold_pressure > 220` | `Manifold pressure sensor appears to be disconnected or miswired` |
| Pressure | `main_pressure_low` | Critical | `main_pressure < 60` | `Main pressure is low` |
| Pressure | `sensors_switched` | Critical | `manifold_pressure > main_pressure` | `The Main and Manifold sensor wiring appear to be swapped` |
| Network | `offline` | Critical | `network == "offline"` | `The controller does not have internet access` |
| Wireless | `poor_wireless_signal` | Warning | `network in ["cellular", "wifi"] and signal_level < 60` | `The cellular or wifi signal is poor` |
| Heartbeat | `no_heartbeat` | Critical | `last_status_at == nil` | `The controller has never communicated with the Frontline system` |
| Heartbeat / network freshness | `poor_network` | Warning | `last_status_at` exists but is older than 60 seconds | `Network conditions appear to be unstable` |
| Controller state | `unknown_state` | Critical | `current_state == "unknown"` | Intended text: `The controller is in an unknown state, it is either still booting up, or needs a firmware update` |
| Flow | `no_water_flow` | Critical | `status == "active" and rate_dlps == 0` | `The controller is not detecting water flow when active. Please ensure there is water pressure and the flow sensor is correctly wired.` |
| Satellite | `no_loopback` | Critical | `last_loopback == nil` | `A satellite loopback test has not been completed.` |
| Satellite | `old_loopback` | Warning | `last_loopback` older than approximately 6 months | `The last loopback test was over 6 months ago.` |
| Power | `low_voltage` | Critical | `power <= 13.0` | `Voltage is low, ensure outlet and UPS are properly wired and providing voltage.` |
| Firmware | `new_firmware` | Warning | parsed controller firmware version is lower than `LATEST_FIRMWARE_VERSION` | `There is a new version of the firmware available.` |

## Detailed Logic

### Pressure

Pressure rules use `main_pressure` and `manifold_pressure`.

- `main_pressure_bad_wiring`
  - fires when `main_pressure > 220`
  - severity: critical
- `main_pressure_high`
  - fires when `main_pressure > 150`
  - severity: critical
- `manifold_pressure_bad_wiring`
  - fires when `manifold_pressure > 220`
  - severity: critical
- `main_pressure_low`
  - fires when `main_pressure < 60`
  - severity: critical
- `sensors_switched`
  - fires when `manifold_pressure > main_pressure`
  - severity: critical

Notes:

- Pressure rules are independent; more than one can fire at once.
- The implementation does not suppress overlapping pressure findings.

### Network And Wireless

- `offline`
  - fires when `network == "offline"`
  - severity: critical
- `poor_wireless_signal`
  - fires when `network` is `"cellular"` or `"wifi"` and `signal_level < 60`
  - severity: warning

Notes:

- This app uses a single coarse wireless warning for both Wi-Fi and cellular.
- Ethernet-specific issues are not broken out separately.

### Heartbeat Freshness

- `no_heartbeat`
  - fires when `last_status_at == nil`
  - severity: critical
- `poor_network`
  - fires when `last_status_at` exists but is more than 60 seconds old
  - severity: warning

Notes:

- `last_status_at` is parsed as ISO-8601 and compared to current UTC time.
- The app treats stale status as a network-quality warning.

### Controller State

- `unknown_state`
  - fires when `current_state == "unknown"`
  - severity: critical

Important note:

- The rule emits `:unknown_state`
- The UI text helper defines `issue_text(:unknow_state)` without the second `n`
- That looks like a typo and may prevent the intended copy from being used unless another fallback exists

### Water Flow

- `no_water_flow`
  - fires when `status == "active"` and `rate_dlps == 0`
  - severity: critical

This is intended to catch controllers that are active but not detecting water flow.

### Satellite Loopback

- `no_loopback`
  - fires when `last_loopback == nil`
  - severity: critical
- `old_loopback`
  - fires when `last_loopback` exists but is older than `86_400 * 30 * 6` seconds
  - severity: warning

Notes:

- The threshold is approximately six 30-day months.
- The app distinguishes between never-run loopback and stale loopback.

### Power / Voltage

- `low_voltage`
  - fires when `power <= 13.0`
  - severity: critical

This is the app’s current low-voltage threshold.

### Firmware

- `new_firmware`
  - firmware version is taken from `firmware_version`
  - if it starts with `r`, the leading `r` is stripped before parsing
  - the parsed version is compared against `LATEST_FIRMWARE_VERSION`
  - default latest version is `3.0.7` if the environment variable is not set
  - fires when latest version is greater than current version
  - severity: warning

## Current Operator Text

These are the exact issue text strings currently defined:

- `There is a new version of the firmware available.`
- `Voltage is low, ensure outlet and UPS are properly wired and providing voltage.`
- `Main pressure sensor appears to be disconnected or miswired`
- `Manifold pressure sensor appears to be disconnected or miswired`
- `Main pressure is high, please reduce pressure`
- `Main pressure is low`
- `The Main and Manifold sensor wiring appear to be swapped`
- `The controller does not have internet access`
- `The cellular or wifi signal is poor`
- `The controller has never communicated with the Frontline system`
- `Network conditions appear to be unstable`
- `The controller is in an unknown state, it is either still booting up, or needs a firmware update`
- `The controller is not detecting water flow when active. Please ensure there is water pressure and the flow sensor is correctly wired.`
- `A satellite loopback test has not been completed.`
- `The last loopback test was over 6 months ago.`

## Implementation Notes

- Rules are assembled in order in `Installer.Controller.issues/1`.
- The UI drops `:ok` results and renders only triggered warnings and critical issues.
- There is no built-in action-generation layer in the current rule module; the operator-facing surface is severity plus issue text.
- Multiple issues can be shown simultaneously.

