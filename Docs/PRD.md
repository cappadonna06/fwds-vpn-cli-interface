# Frontline Remote Controller Console - PRD

## Product summary

Frontline Remote Controller Console is a local desktop app for operators who need to connect to Frontline controllers over OpenVPN and SSH using locally stored credential bundles. The app replaces a fragile terminal-driven workflow with a guided local UI while keeping all secrets on the operator machine.

## Goals

- Let an operator select a local VPN bundle folder and validate it before use.
- Start and stop OpenVPN locally.
- Help the operator connect to a controller using `connect.bin <last_octet>`.
- Provide readable logs for VPN, diagnostics, controller connection, and remote commands.
- Support operator-in-the-loop setup through preset commands and a guided intake/runbook panel.
- Export useful diagnostics without uploading credentials or session material anywhere.

## Non-goals for v1

- Hosted or cloud-based access
- Credential syncing or secret storage services
- Fully automated setup prompt handling
- Dashboard integration or automatic controller discovery
- PTY-grade terminal emulation

## Primary user

- Frontline operator or support engineer working from a local laptop with approved VPN and SSH materials

## Required local inputs

The selected folder must contain:

- `ovpn.conf`
- `ovpn.crt`
- `ovpn-fwds-client.crt`
- `ovpn-fwds-client.key`
- `station`
- `connect.bin`

## Core user flow

1. Operator selects a VPN bundle folder.
2. App validates file presence and basic readiness.
3. App copies `station` to `~/.ssh/station` if needed and secures it with `600` permissions on Unix-like systems.
4. Operator starts OpenVPN from the selected folder.
5. App shows OpenVPN logs and waits for tunnel readiness.
6. Operator enters the controller VPN IP.
7. App derives the last octet and runs `connect.bin <last_octet>`.
8. Operator runs remote commands using the command input box or preset commands.
9. Operator uses the intake-driven setup panel to work through setup steps with human review at each stage.

## Functional requirements

### Session and VPN

- Native folder picker
- Remember the last selected folder locally
- File validation for required bundle files
- OpenVPN config path validation for `ca`, `cert`, and `key`
- Duplicate `openvpn` process detection
- Start and stop local OpenVPN
- Readable VPN logs in the UI

### Controller connection

- Controller VPN IP input
- Automatic last-octet extraction
- `connect.bin` execution from the selected folder
- Ping and TCP port 22 diagnostics
- Clear failure states for invalid IP, unreachable controller, and connect timeout/failure

### Remote command execution

- Command input box
- Send command button
- Preset command palette for common tasks
- Readable output log pane

### Remote setup guidance

- Mock intake JSON for development
- Intake viewer in the right-side panel
- Inferred zone mapping table
- Editable zone type/name/notes fields
- Runbook/checklist for semi-automated setup
- Expected prompt hints for preset commands

### Diagnostics export

- Copy diagnostics action
- Include selected folder path, validation results, VPN state, recent logs, ping result, port 22 result, and controller connect result

## Security requirements

- Never commit real VPN or SSH material
- Never upload VPN bundles, keys, or certificates
- Keep all process execution local to the operator machine
- Only remember non-secret local UI state such as the last selected folder path

## UX requirements

- Local desktop app, not a hosted web app
- Three-column layout:
  - left: session, validation, controller metadata
  - center: logs and terminal-style interaction
  - right: presets, intake, runbook
- Clear state badges for disconnected, connecting, connected, and failed states
- Errors must be explicit and actionable

## Future enhancements

- Stronger destructive-action guardrails for commands like `setup-system` and reset flows
- Better SSH session persistence
- True PTY integration
- Structured command history and saved runbooks
- Optional intake file import/export
