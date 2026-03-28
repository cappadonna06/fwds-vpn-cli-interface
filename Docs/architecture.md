# Frontline Remote Controller Console - Architecture

## Purpose

This app is a local desktop application for connecting to, configuring, and diagnosing Frontline controllers over OpenVPN and SSH. It keeps credential handling, process execution, and logs on the operator machine.

## Why it must be local

The workflow depends on:

- Local VPN bundle files
- Local filesystem validation and permission fixes
- Local execution of `openvpn`, `connect.bin`, `ping`, `nc`, and `ssh`
- Local `~/.ssh/station` preparation

This is not a hosted web application architecture.

## Current implementation

### Frontend

- React + TypeScript
- Single three-panel desktop layout
- Reusable components for:
  - status badges
  - file validation checks
  - controller connect form
  - process log viewer
  - preset command palette
  - intake form viewer
  - setup checklist and editable zone mapping

### Backend

- Tauri v2 command layer in Rust
- Local app state for:
  - selected folder
  - controller IP
  - SSH user
  - VPN status
  - controller connect status
  - validation report
  - recent logs
  - last command and diagnostics results

### Tauri plugins and permissions

- `tauri-plugin-dialog` for native folder picking
- `tauri-plugin-opener` still registered but not central to the workflow
- `dialog:default` capability permission on the main window

## Runtime flow

1. Frontend opens the native folder picker.
2. Frontend sends the selected folder path to Rust.
3. Rust validates required files and `ovpn.conf` references.
4. Rust ensures `~/.ssh/station` exists and is permissioned correctly.
5. Rust starts `openvpn --config ovpn.conf` when requested.
6. Rust captures stdout and stderr from OpenVPN into the in-memory log buffer.
7. Frontend polls backend state and renders statuses and logs.
8. Rust runs diagnostics and controller connection commands on demand.
9. Rust runs remote SSH commands on demand and appends output to the shared log view.

## Process model

### OpenVPN

- Started as a child process from the selected bundle folder
- Output is streamed into the log buffer
- The app marks the VPN as connected when it sees `Initialization Sequence Completed`
- The app prevents starting a second managed OpenVPN process and warns about existing system `openvpn` processes

### Controller connection

- The operator enters the controller VPN IP manually
- The backend extracts the last octet
- The backend runs `connect.bin <last_octet>` from the selected bundle folder
- This is modeled as a command execution step with logs and status, not a persistent embedded shell session

### Remote command execution

- The terminal pane is a command input plus output log model
- Commands are executed over `ssh -i ~/.ssh/station`
- This is intentionally operator-in-the-loop and not a fully automated setup runner

## Current UX shape

### Left panel

- Session state
- Selected folder
- Controller connection controls
- Validation results
- Current metadata and diagnostics summary

### Center panel

- Process log viewer
- Terminal-style command box

### Right panel

- Preset commands
- Intake viewer
- Runbook/checklist and editable zone mapping

## Constraints and boundaries

- Secrets stay local
- The app does not import real secrets into source control
- The app does not integrate directly with a controller dashboard
- The app does not yet implement a true PTY or persistent SSH shell
- The app does not yet enforce confirmation modals for destructive controller commands

## Future architecture candidates

- Event-driven state updates instead of polling
- PTY-backed terminal integration
- Safer guarded-command execution model
- Structured session persistence for non-secret operator state
