# Controller Connection Notes

## Purpose

This note explains how controller connection works in this app, what had to be implemented to support it, and what limitations still remain.

## Core workflow

The controller connection flow depends on an already-established OpenVPN session.

Operationally, the sequence is:

1. Start OpenVPN and wait for `Initialization Sequence Completed`.
2. Get the controller VPN IP from the dashboard, for example `10.9.0.6`.
3. Extract the last octet, for example `6`.
4. Connect to the controller.

Historically, operators did this manually:

```sh
cd ~/Downloads/vpn_info
./connect.bin 6
```

## What `connect.bin` actually does

In the provided bundle, `connect.bin` is a thin wrapper:

- removes the old SSH host key entry for `10.9.0.<octet>`
- runs SSH as `root`
- uses `~/.ssh/station` as the key

So `connect.bin 6` is effectively:

- target host: `10.9.0.6`
- username: `root`
- auth method: SSH key, not password

That is why the app may connect without showing a password prompt.

## What had to be implemented in the app

### 1. Controller IP handling

The app needed to accept the full controller VPN IP while still supporting the legacy `connect.bin <last_octet>` contract.

So the backend and UI now:

- accept the full controller VPN IP
- validate it as IPv4
- extract the last octet automatically
- use that last octet for `connect.bin`

### 2. `connect.bin` execution

The backend had to run `connect.bin` locally from the selected bundle folder and capture:

- exit status
- stdout
- stderr
- timing

This became the app’s “probe” / compatibility connection path.

### 3. SSH-based controller shell

`connect.bin` alone is not enough for an embedded app workflow because it assumes a terminal/TTY and exits immediately in a non-interactive context.

To make the app usable, the backend also needed a persistent shell path:

- open SSH with `-tt`
- keep stdin open
- capture stdout/stderr
- expose shell state in the app snapshot
- let the UI send commands into the live session

That shell path is the real operator-facing controller workflow in the app.

### 4. Transcript handling

A line-based transcript was not sufficient because controller setup flows are prompt-driven and often do not behave like clean newline-delimited logs.

So shell output handling had to move toward chunk-based transcript capture so prompts and operator input stay visually coherent.

### 5. Connection-state clarity

The app needed separate concepts for:

- VPN connected
- controller probe/`connect.bin` result
- controller shell connected

Without that split, the UI looked connected in one place and disconnected in another, which was confusing.

## Important implementation notes

### `connect.bin` is useful but limited

`connect.bin` is still helpful for:

- reproducing the legacy workflow
- proving basic reachability/authentication
- matching what operators already know

But it is not the best embedded app interface by itself.

### The shell path is the real app workflow

For actual operator use, the more important feature is:

- open controller shell
- type commands
- read prompts and responses

That is closer to what operators expect after a successful connection.

## Bugs and issues encountered

### 1. Controller IP field was being cleared

The frontend polling loop was overwriting locally typed form state with backend snapshot state before the backend had been updated.

This made the controller VPN IP field clear itself shortly after paste/type.

### 2. Shell transcript looked hung or incomplete

The initial shell transcript handling was too log-oriented and line-based.

Prompt-driven flows like `setup` could appear visually stuck even though the controller was waiting for input.

### 3. Connection success was not obvious enough

An operator could be genuinely connected to the controller while the UI still did not make that state sufficiently obvious.

This is why the app was reoriented toward:

- a main `Controller` view
- a separate `Debug` view

## Current behavior

The app now supports:

- entering the full controller VPN IP
- automatic last-octet extraction
- running `connect.bin <last_octet>`
- opening a persistent SSH shell to the controller
- sending commands into that shell
- keeping raw logs and debugging detail out of the main controller view

## Remaining limitations

- prompt rendering may still need polish for long interactive setup flows
- the shell transcript is better than before but still not a true terminal emulator
- `connect.bin` output can still be noisy because it uses verbose SSH behavior
- the app does not yet provide a styled login/auth status explanation in the controller UI

## Recommended follow-up work

- add a small UI hint explaining:
  - controller auth uses `~/.ssh/station`
  - password entry may not be needed because SSH key auth is succeeding
- continue improving the transcript so prompt/response flows are easier to follow
- consider eventually moving to a PTY-backed terminal if controller interaction becomes more complex

## Files to read

- [src-tauri/src/backend.rs](/Users/marcsells/Developer/frontline-vpn-console/src-tauri/src/backend.rs)
- [src/App.tsx](/Users/marcsells/Developer/frontline-vpn-console/src/App.tsx)
- [src/services/backend.ts](/Users/marcsells/Developer/frontline-vpn-console/src/services/backend.ts)
- [docs/macos-openvpn-notes.md](/Users/marcsells/Developer/frontline-vpn-console/docs/macos-openvpn-notes.md)
