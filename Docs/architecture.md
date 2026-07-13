# Architecture

The FWDS Controller Console is a local desktop application for connecting to,
configuring, and diagnosing Frontline Mark I controllers over OpenVPN and SSH.
Credential handling, process execution, and logs all stay on the operator's
machine.

## Why it runs locally

The workflow depends on resources that only exist on the operator's machine:

- Local VPN bundle files (config, certificates, keys)
- Local filesystem validation and permission fixes
- Local execution of `openvpn`, `connect.bin`, `ping`, `nc`, and `ssh`
- Local `~/.ssh/station` key preparation

This is deliberately **not** a hosted web application.

## Components

### Frontend (React + TypeScript)

- Single desktop layout with a sidebar shell and per-tab surfaces
  (`src/components/shell`, `src/components/tabs`)
- Parsing and presentation logic in `src/lib` (controller output parsers,
  report generation, LED decoder, command actions)
- FWD design tokens and self-hosted fonts in `src/styles` for offline field use

### Backend (Rust / Tauri v2)

The Tauri command layer (`src-tauri/src`) owns all process execution and holds
local app state: selected bundle folder, controller IP, SSH user, VPN status,
controller connection status, validation report, recent logs, and the last
command and diagnostics results.

Tauri plugins in use:

- `tauri-plugin-dialog` — native folder picking (`dialog:default` capability on
  the main window)
- `tauri-plugin-opener` — registered, not central to the workflow

## Runtime flow

1. The frontend opens the native folder picker.
2. The selected folder path is sent to the Rust backend.
3. The backend validates required files and `ovpn.conf` references.
4. The backend ensures `~/.ssh/station` exists and is permissioned correctly.
5. On request, the backend starts OpenVPN (see
   [`platform-notes.md`](platform-notes.md) for the macOS elevation path).
6. OpenVPN stdout/stderr is captured into an in-memory log buffer.
7. The frontend polls backend state and renders statuses and logs.
8. The backend runs diagnostics and controller commands on demand.
9. Remote SSH command output is appended to the shared log view.

## Process model

### OpenVPN

- Started as a child process from the selected bundle folder.
- Output is streamed into the log buffer.
- The VPN is marked connected when `Initialization Sequence Completed` appears.
- The app prevents starting a second managed OpenVPN process and warns about
  existing system `openvpn` processes.

### Controller connection

A controller session builds on an established OpenVPN session (or a local
network path — see below). The operator supplies the controller VPN IP; the
backend extracts the last octet and can run `connect.bin <last_octet>` from the
bundle folder.

`connect.bin` is a thin wrapper that removes the stale SSH host-key entry for
`10.9.0.<octet>`, then connects as `root` using `~/.ssh/station`. Because auth is
key-based, connecting does not prompt for a password. `connect.bin` is useful for
reproducing the legacy workflow and proving reachability, but it assumes a TTY
and exits immediately in a non-interactive context, so it is treated as a
**probe / compatibility** path rather than the primary interface.

The primary operator interface is a **persistent SSH shell**:

- opens SSH with `-tt` and keeps stdin open
- captures stdout/stderr and exposes shell state in the app snapshot
- lets the UI send commands into the live session

The app models three distinct connection states so the UI never looks connected
in one place and disconnected in another:

1. VPN connected
2. Controller probe (`connect.bin`) result
3. Controller shell connected

### Local network (SSH) — no VPN

The app can also reach a controller on the same LAN **without starting the VPN**
(Local mode → Network (SSH)).

- **Auth is identical to the VPN path:** it reuses the bundle's `~/.ssh/station`
  key as `root`, so it is passwordless. The VPN bundle still has to be loaded
  once to install the key — but the VPN itself does not have to run.
- **Host** can be a bare serial (e.g. `45230110`, auto-resolved to
  `45230110.local`), a full `.local` mDNS name, or a LAN IP.
- **Host-key churn is handled** with `UserKnownHostsFile=/dev/null`, so a
  controller whose host key changed after a firmware update still connects.
- macOS resolves `<serial>.local` natively via Bonjour; Windows needs Bonjour
  installed, or use the LAN IP.

### Remote command execution

The terminal pane is a command-input-plus-output-log model, executed over
`ssh -i ~/.ssh/station`. It is intentionally operator-in-the-loop, not a fully
automated setup runner.

## Controller transcript handling

Controller setup flows are prompt-driven and do not behave like clean,
newline-delimited logs. Treating controller output as line-based logs caused
prompt-driven flows (e.g. `setup`) to look hung, merged operator input with
prompts, and mixed transport-level SSH/OpenVPN noise into the operator's view.

The current model addresses this by:

- **Separating operator UI from debug UI.** The main controller view carries
  minimal connection state, the controller shell, command input, and quick
  commands; raw logs, validation, and diagnostics detail live in a separate
  debug surface.
- **Chunk-based transcript capture.** The shell reader does not depend on
  newline-delimited output, which preserves prompt timing and partial output for
  interactive flows.
- **Keeping transport noise out of the transcript.** SSH debug output, OpenVPN
  warnings, and process-lifecycle detail stay in the debug surface.

## Constraints and boundaries

- Secrets stay local; real secrets are never imported into source control.
- The app does not integrate directly with a controller dashboard.
- The transcript is stream-captured, not a true PTY/terminal emulator — complex
  interactive TUI behavior and cursor control sequences are not fully modeled.
- Destructive controller commands are not yet gated behind confirmation modals.

## Future direction

- A true privileged helper/daemon for VPN lifecycle management, replacing the
  macOS elevation wrapper (cleaner start/stop, fewer password prompts).
- PTY-backed terminal integration for higher-fidelity interactive flows.
- Event-driven state updates instead of polling.
- Structured session persistence for non-secret operator state.
