# Frontline Remote Controller Console - Workflows

## Overview

This document describes the workflows the current app supports and where the operator is still expected to drive the process manually.

## Workflow 1 - Prepare bundle and start VPN

### Goal

Validate local credential material and start a local OpenVPN session.

### Steps

1. Open the app.
2. Click `Select VPN Folder`.
3. Choose a local folder containing the required bundle files.
4. Review validation output for:
   - missing files
   - unreadable files
   - invalid `ovpn.conf` certificate references
   - station copy/permission issues
   - existing `openvpn` processes
5. Click `Start VPN`.
6. Watch the center log pane for OpenVPN startup output.
7. Wait for the connected state before moving to controller connection.

### Success criteria

- Validation reports no blocking errors
- `~/.ssh/station` is ready
- VPN status transitions to connected

### Failure states

- Missing bundle files
- Wrong paths inside `ovpn.conf`
- Duplicate `openvpn` processes
- OpenVPN startup failure

## Workflow 2 - Connect to a controller

### Goal

Connect to a target controller after the VPN is up.

### Steps

1. Enter the controller VPN IP, for example `10.9.0.14`.
2. Confirm the derived last octet shown in the UI.
3. Optionally run `Ping + Port 22`.
4. Click `Run connect.bin`.
5. Review logs for controller connection success or failure.

### Success criteria

- Ping and port checks pass when expected
- `connect.bin` returns successfully
- Controller connection status shows connected

### Failure states

- Invalid controller IP
- Controller unreachable
- SSH port closed
- `connect.bin` timeout or non-zero exit

## Workflow 3 - Operator-driven remote commands

### Goal

Run controller commands without leaving the app.

### Current behavior

- The app provides a command input box and send button
- The app also provides preset command buttons for common commands
- Commands are run over SSH using the prepared `~/.ssh/station` identity
- Output is appended to the shared log viewer

### Important limitation

This is not a PTY-backed embedded shell. It is a command execution model suitable for v1 operator workflows.

## Workflow 4 - Guided remote setup

### Goal

Support remote setup using intake data and operator judgment.

### Steps

1. Review intake details in the right-side panel.
2. Review the inferred zone mapping derived from codes such as `R1`, `E2`, or `C3`.
3. Edit zone types, names, and notes as needed.
4. Follow the runbook checklist while running commands manually.
5. Use preset commands and the command box to drive setup with operator review at each stage.

### Current implementation notes

- Intake data is mocked for development
- The runbook is generated in the frontend
- Prompt guidance is attached to preset commands as UX hints
- The app does not yet parse or automate interactive setup prompts

## Workflow 5 - Diagnostics export

### Goal

Capture enough local context to support troubleshooting.

### Steps

1. Run validation, VPN startup, diagnostics, and controller connect attempts as needed.
2. Click `Copy diagnostics`.
3. Paste the generated output into the support channel or ticket used by your team.

### Included data

- Selected folder path
- Validation summary
- VPN status
- Ping result
- Port 22 result
- Controller connect result
- Recent logs

## Workflow 6 - End session

### Goal

End the local session cleanly.

### Steps

1. Stop sending remote commands.
2. If needed, exit the remote controller shell context using your normal controller command.
3. Click `Stop VPN`.
4. Copy diagnostics first if the session ended in failure.

### Success criteria

- No managed OpenVPN session remains active
- Logs are still available for review or export

## Future workflow improvements

- Destructive-action confirmations for risky commands
- Better reboot and reconnect guidance
- Importing real intake JSON files instead of only using mocked development data
