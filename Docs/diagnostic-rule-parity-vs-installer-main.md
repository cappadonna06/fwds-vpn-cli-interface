# Diagnostic Rule Parity: `FWDS-VPN-CLI-INTERFACE` vs `installer-main`

This document compares the diagnostic rule set and operator-visible UI behavior between:

- `FWDS-VPN-CLI-INTERFACE`
- `installer-main`

The comparison is code-driven and normalized across both apps. For each issue or state, it records:

- subsystem
- trigger logic
- severity / color
- displayed issue text
- recommended action(s)
- source location
- alignment status

## Normalization Rules

### Severity / color mapping

`installer-main` uses an issue list with icon severity:

- `:critical` -> red
- `:warning` -> amber
- no issue -> no visible row

`FWDS-VPN-CLI-INTERFACE` uses a richer card model:

- parser statuses: `green`, `orange`, `red`, `grey`, `unknown`
- UI card tones: `healthy`, `warning`, `error`, `neutral`
- UI labels like `Issue`, `Warning`, `Inactive`, `Healthy`, `Verified`, `Not validated`

For parity, the comparison treats final rendered UI behavior as authoritative when it differs from parser severity.

### Source of truth used

`installer-main`

- rules: [controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:2)
- issue text: [app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:214)

`FWDS-VPN-CLI-INTERFACE`

- parser / backend rule layer: [parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3053)
- final card summary / color layer: [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1289)
- card recommended-action layer: [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:870)
- report-only escalations: [generateReport.ts](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/lib/generateReport.ts:463)

## Parity Matrix

| Subsystem | `installer-main` rule | Trigger in `installer-main` | `installer-main` severity / text | Closest `FWDS` equivalent | `FWDS` final UI / actions | Alignment |
| --- | --- | --- | --- | --- | --- | --- |
| Firmware | `:new_firmware` | firmware version lower than `LATEST_FIRMWARE_VERSION` via `Version.compare` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:33)) | amber, `There is a new version of the firmware available.` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:214)) | Firmware card update-available state ([DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1670)) | amber `Update available`; action `Update firmware` | Partial match: same intent, but `FWDS` adds a dedicated firmware card, exact current version, unreadable-version error path, and explicit action |
| Pressure | `:main_pressure_bad_wiring` | `main_pressure > 220` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:7)) | red, `Main pressure sensor appears to be disconnected or miswired` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:220)) | P3/P1-style high-invalid pressure sensor rules are split by sensor and platform in `FWDS` pressure parser ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3520)) | red `Potential bad P1/P2/P3 ... sensor reading`; action is sensor-specific wiring/scaling guidance | Partial match: same broad intent, but `FWDS` is more granular and sensor-model-specific |
| Pressure | `:main_pressure_high` | `main_pressure > 150` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:8)) | red, `Main pressure is high, please reduce pressure` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:226)) | High-pressure warnings in `FWDS` at `180-219 PSI` for P1/P2/P3 ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3539), [parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3591), [parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3630)) | amber `P1/P2/P3 ... high`; action is sensor-specific regulator / pressure-state guidance | Threshold mismatch: same concept, but `installer-main` alerts earlier and more severely |
| Pressure | `:manifold_pressure_bad_wiring` | `manifold_pressure > 220` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:9)) | red, `Manifold pressure sensor appears to be disconnected or miswired` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:223)) | `FWDS` P2 high-invalid / wiring anomalies ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3568)) | red `Potential bad P2 Distribution Pressure sensor reading`; action `Verify P2 transducer scaling and wiring.` | Partial match: same family, but `FWDS` distinguishes invalid sensor reading from generic miswire copy |
| Pressure | `:main_pressure_low` | `main_pressure < 60` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:10)) | red, `Main pressure is low` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:229)) | `FWDS` low-pressure warnings at `< 49 PSI` ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3557), [parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3639)) | amber `P1/P3 ... low`; action is upstream supply / source guidance | Threshold and severity mismatch: same concept, but `installer-main` is earlier and red; `FWDS` is later and amber |
| Pressure | `:sensors_switched` | `manifold > main` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:89)) | red, `The Main and Manifold sensor wiring appear to be swapped` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:232)) | `FWDS` miswire checks `P2 > P1` and `P2 > P3` ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3650)) | amber `P1/P2 likely miswired` or `P2/P3 likely miswired`; action verifies terminal wiring order | Partial match: same wiring-detection goal, but `FWDS` models three pressure channels and treats miswires as amber, not red |
| Network | `:offline` | `network == "offline"` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:43)) | red, `The controller does not have internet access` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:235)) | No single global offline rule; `FWDS` splits by Ethernet, Wi-Fi, Cellular, Satellite | multiple card-specific states: `Limited internet`, `No Ethernet link`, `No service`, `Not connected`, etc.; actions vary per transport | Mismatch: `installer-main` has one top-level offline issue, `FWDS` decomposes by transport and transport-specific remediation |
| Wireless | `:poor_wireless_signal` | `network in ["cellular","wifi"] and signal_level < 60` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:45)) | amber, `The cellular or wifi signal is poor` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:238)) | Wi-Fi and Cellular each have their own weak-signal logic in parser and UI ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:4136), [parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:5105), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1289), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1317)) | Wi-Fi weak signal is usually amber with `Improve Wi-Fi coverage...`; Cellular weak signal is amber with `Check antenna connection and placement`; very weak cellular can escalate red | Partial match: same intent, but `FWDS` splits Wi-Fi vs cellular, uses different thresholds, and has subsystem-specific actions |
| Heartbeat | `:no_heartbeat` | `last_status_at == nil` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:51)) | red, `The controller has never communicated with the Frontline system` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:241)) | No direct equivalent found in `FWDS` diagnostic cards, parser, or report actions | no dedicated card or action | Only in `installer-main` |
| Network freshness | `:poor_network` | `last_status_at` older than 60 seconds ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:53)) | amber, `Network conditions appear to be unstable` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:244)) | Closest equivalent is transport-specific unstable-link logic: Wi-Fi packet loss / tx failures; Ethernet flap count ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:4168), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1349)) | amber on specific cards, not global; actions `Inspect link stability...`, `Swap switch port`, or Wi-Fi coverage guidance | Partial match: `installer-main` measures stale status heartbeat globally; `FWDS` measures transport health locally |
| Controller state | `:unknown_state` | `current_state == "unknown"` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:65)) | intended red text is `The controller is in an unknown state...`, but `issue_text/1` is misspelled as `:unknow_state` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:247)) | No direct equivalent found in `FWDS` diagnostic model | no dedicated card or action | Only in `installer-main`; also appears to have a copy lookup bug |
| Flow / hydraulics | `:no_water_flow` | `status == "active" and rate_dlps == 0` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:68)) | red, `The controller is not detecting water flow when active...` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:251)) | No direct equivalent found in `FWDS` current diagnostics cards | no dedicated card or action | Only in `installer-main` |
| Satellite / loopback | `:no_loopback` | `last_loopback == nil` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:71)) | red, `A satellite loopback test has not been completed.` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:255)) | `FWDS` satellite-not-validated state ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3133), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1374)) | gray/neutral `Not validated`; action `Run full satellite loopback test` or `Run loopback for full verification` | Same intent, different severity and UX philosophy: `installer-main` treats missing loopback as red; `FWDS` treats it as not-yet-validated |
| Satellite / loopback age | `:old_loopback` | `last_loopback` older than ~6 months ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:73)) | amber, `The last loopback test was over 6 months ago.` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:258)) | No age-based loopback staleness rule found in `FWDS`; only run-state and pass/fail states exist | no dedicated card or action | Only in `installer-main` |
| Power | `:low_voltage` | `power <= 13.0` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:22)) | red, `Voltage is low...` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:217)) | No dedicated power / voltage diagnostic card found in current `FWDS` code | no dedicated card or action | Only in `installer-main` |

## Gaps Only In `installer-main`

These are issue families modeled in `installer-main` that do not currently have a direct equivalent in `FWDS-VPN-CLI-INTERFACE`.

| Subsystem | Rule / issue | Current behavior in `installer-main` | Gap in `FWDS` |
| --- | --- | --- | --- |
| Heartbeat | `:no_heartbeat` | hard red issue when a controller has never reported status | no dedicated heartbeat card, stale-session issue, or action |
| Network freshness | `:poor_network` | amber issue when controller status is stale by > 60 seconds | no global stale-heartbeat / stale-network rule |
| Controller state | `:unknown_state` | intended red controller-state issue | no controller-state diagnostic rule surfaced |
| Flow / hydraulics | `:no_water_flow` | red active-with-zero-flow issue | no flow-sensor / active-no-flow diagnostic |
| Satellite aging | `:old_loopback` | amber stale-loopback warning after ~6 months | no age-based loopback freshness rule |
| Power | `:low_voltage` | red low-voltage issue at `<= 13.0` | no power / UPS / outlet voltage diagnostic |

## Gaps Only In `FWDS-VPN-CLI-INTERFACE`

These are issue or state families that `FWDS` models explicitly but `installer-main` either collapses into one generic issue or does not model at all.

| Subsystem | `FWDS` issue / state | `FWDS` behavior | `installer-main` coverage |
| --- | --- | --- | --- |
| Wi-Fi | technology disabled | red parser, amber/Inactive UI; action `Enable Wi-Fi via setup-wifi` ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:4121), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:898), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1293)) | not modeled separately |
| Wi-Fi | association failed / not connected | red parser, neutral/Inactive UI; action `Run setup-wifi and verify AP/credentials` | partially covered only as generic poor wireless / offline concepts |
| Wi-Fi | weak signal / unstable link / no IP / limited data | separate thresholds and action paths | collapsed into one generic poor-wireless warning |
| Cellular | no modem detected | issue state with remediation and reboot guidance ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:5065)) | not modeled separately |
| Cellular | modem not responding | red issue with reboot / reseat guidance ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:5074)) | not modeled separately |
| Cellular | disabled / powered off | neutral `Inactive`; action `Enable via setup-cellular` ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:5089), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1330)) | not modeled separately |
| Cellular | no SIM detected | issue state with SIM-seat remediation ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:5139), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1321)) | not modeled separately |
| Cellular | no service / searching / registered-not-connected | separate card states and actions | partially covered only as generic offline / poor wireless |
| Cellular | carrier recommendation via SIM Picker | can recommend `Install <carrier> SIM` based on live scan ([generateReport.ts](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/lib/generateReport.ts:551)) | no carrier-swap recommendation flow |
| Ethernet | disabled / no link / unstable link / no IP / limited internet | transport-specific diagnosis and remediation ([DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1041), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1338), [generateReport.ts](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/lib/generateReport.ts:463)) | no Ethernet-specific issue decomposition |
| Satellite | no modem / manager unresponsive / blocked-in-use / quick-fail / no-satellites-visible | multiple distinct satellite issues and actions ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3053), [DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:976)) | only no-loopback and old-loopback |
| Pressure | sensor-missing vs invalid-high vs near-zero vs low vs pressurized vs miswired vs platform-wiring mismatch | detailed pressure rule family with sensor-specific actions ([parsers.rs](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src-tauri/src/parsers.rs:3491)) | much coarser pressure rule set |
| Firmware | unreadable version | red issue `Version unreadable`; action `Run version command again` ([DiagnosticsTab.tsx](/Users/marcsells/Developer/FWDS-VPN-CLI-INTERFACE/src/components/tabs/DiagnosticsTab.tsx:1682)) | not modeled |
| Neutral states | no data / inactive / not validated / backup vs primary transport | explicit UI states for incomplete or intentionally inactive subsystems | `installer-main` issue list shows only warnings / criticals |

## Recommended Follow-Up Priorities

If the goal is convergence, these are the highest-value alignment decisions to make first.

1. Decide whether `FWDS` should adopt any of `installer-main`’s controller-level health rules.
   - Candidate additions: `no_heartbeat`, `poor_network`, `unknown_state`, `no_water_flow`, `low_voltage`, and stale loopback age.
   - These are currently genuine product-surface gaps, not just wording differences.

2. Decide whether `installer-main` should stay coarse or move toward `FWDS` transport-specific diagnosis.
   - The biggest philosophical difference is global issue list vs per-transport diagnostics.
   - If `installer-main` stays coarse, parity should probably happen at the report layer, not the raw rule layer.

3. Normalize wireless thresholds and severity philosophy.
   - `installer-main` treats poor wireless as one amber issue below `60`.
   - `FWDS` uses transport-specific thresholds and sometimes escalates cellular to red for critically weak signal.

4. Normalize pressure thresholds.
   - `installer-main`: `main > 150` is already red-high; `main < 60` is red-low.
   - `FWDS`: most pressure deviations are amber until more extreme invalid conditions occur.
   - This is one of the largest behavior mismatches in the two apps.

5. Decide whether missing loopback is a hard issue or a validation gap.
   - `installer-main`: missing loopback is red.
   - `FWDS`: missing loopback is neutral / not validated with an explicit action.

## Validation Notes

- Every rule symbol returned by `Installer.Controller.issues/1` is represented in the parity matrix.
- The matrix uses final rendered `FWDS` card behavior where it differs from backend severity.
- `FWDS` report-only actions were included where they materially expand operator guidance, especially for Ethernet, Cellular, Satellite, and Pressure.
- `installer-main` appears to have a likely typo bug:
  - rule emits `:unknown_state` ([controller.ex](/Users/marcsells/Developer/installer-main/lib/installer/controller.ex:65))
  - copy function defines `issue_text(:unknow_state)` ([app_components.ex](/Users/marcsells/Developer/installer-main/lib/installer_web/components/app_components.ex:247))
