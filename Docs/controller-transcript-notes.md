# Controller Transcript Notes

## Purpose

This note explains why controller output looked wrong in the app, what was changed to improve it, and what limitations still remain.

## Original problem

The first version of the controller experience treated controller output like ordinary logs.

That caused several problems:

- prompt-driven controller flows looked hung
- operator input and controller prompts got visually merged
- output only updated cleanly when a newline appeared
- raw SSH/debug noise mixed with the controller interaction
- it was not obvious what belonged in the operator UI versus what belonged in diagnostics

Example of the bad behavior:

- operator runs `setup`
- UI shows `Running station setup...`
- controller is actually waiting for input
- operator types a response
- the response appears jammed into the previous prompt text

## Why that happened

### 1. The output was treated as line-based logs

The initial implementation read shell output line by line.

That is a poor fit for interactive shells because prompts often:

- do not end with a newline
- update incrementally
- expect immediate operator input

### 2. The shell was mixed with debug output

The app originally leaned too heavily on raw process logs. That made the operator view noisy and hard to trust because low-level SSH/OpenVPN details were mixed into the same experience as the controller workflow.

### 3. `connect.bin` output is inherently noisy

The legacy `connect.bin` wrapper uses verbose SSH behavior, so if its output is shown directly as part of the operator flow it brings in a lot of transport-level detail that is not useful for day-to-day controller work.

## What was changed

### Separate operator UI from debug UI

The app was restructured into:

- `Controller` view:
  - minimal connection state
  - controller shell
  - command input
  - quick commands
- `Debug` view:
  - raw logs
  - validation
  - diagnostics
  - intake/runbook detail

This was the biggest usability improvement because it stopped making operators work inside a diagnostics console.

### Add a persistent controller shell session

Instead of only proving connectivity with `connect.bin`, the backend now opens a persistent SSH session for actual controller interaction.

That session:

- keeps stdin open
- captures stdout/stderr
- exposes shell connection state separately from VPN state

### Move transcript handling toward chunk-based capture

The shell reader was changed so it does not depend on newline-delimited output in the same way as the earlier log-oriented approach.

That matters because interactive controller prompts are not normal log lines.

The goal of this change was:

- preserve prompt timing better
- preserve partial output better
- avoid forcing everything into a log-line model

### Keep raw debugging details out of the main controller transcript

The main controller transcript should be where the operator works.

Low-level details such as:

- SSH debug noise
- OpenVPN warnings
- process lifecycle details

belong in the `Debug` view instead.

## What this fixed

- The controller view became the main working surface instead of the raw log viewer.
- Prompt-driven flows behave more like a live session and less like delayed logs.
- The operator no longer has to read through OpenVPN and SSH transport detail just to interact with the controller.
- Connection state is clearer because VPN state, probe state, and shell state are distinct.

## What still is not perfect

This is still not a full PTY-backed terminal emulator.

That means:

- very complex interactive TUI behavior may still render awkwardly
- cursor movement and richer terminal control sequences are not fully modeled
- some prompt formatting may still look less polished than a native terminal

## Current recommendation

For normal controller command work:

- use the `Controller` view
- treat the transcript there as the primary workspace

For troubleshooting:

- switch to `Debug`

## Likely next improvement

If controller interaction becomes more complex or prompt fidelity still feels off, the next real step is PTY-backed terminal support rather than continuing to simulate terminal behavior with plain stream capture.

## Files to read

- [src/App.tsx](/Users/marcsells/Developer/frontline-vpn-console/src/App.tsx)
- [src/App.css](/Users/marcsells/Developer/frontline-vpn-console/src/App.css)
- [src-tauri/src/backend.rs](/Users/marcsells/Developer/frontline-vpn-console/src-tauri/src/backend.rs)
- [docs/controller-connection-notes.md](/Users/marcsells/Developer/frontline-vpn-console/docs/controller-connection-notes.md)
