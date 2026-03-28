# macOS OpenVPN Notes

## Purpose

This note explains the macOS-specific work required to make OpenVPN start from inside the Tauri app, and why that path is more complicated than a normal local process launch.

## Summary

The app can start OpenVPN from inside the UI on macOS, but only because it uses an elevated launch path. A normal app process can run the `openvpn` binary, but it cannot create the `utun` tunnel device without administrator privileges.

The core symptom that drove this work was:

- OpenVPN launched successfully
- TLS handshake succeeded
- tunnel creation failed with `Operation not permitted`
- session exited before `Initialization Sequence Completed`

## Why this was hard

### 1. OpenVPN needs elevation on macOS

Launching:

```sh
openvpn --config ovpn.conf
```

from a normal app process is not enough on macOS. The tunnel device creation step requires elevated privileges.

### 2. Protected user folders were unreliable for the elevated path

The selected VPN bundle often lives in places like `~/Downloads`. The elevated OpenVPN launch path was not reliable when reading config and key material directly from protected user directories.

### 3. Relative paths inside `ovpn.conf` mattered

The config uses relative references such as:

- `ca ovpn.crt`
- `cert ovpn-fwds-client.crt`
- `key ovpn-fwds-client.key`

So the launch working directory and config path handling had to match what OpenVPN expected.

### 4. Root-owned process tracking was different

Once OpenVPN was started with elevation, the app had to track a root-owned process correctly without assuming it had died just because a normal-user liveness check failed.

## What finally worked

### Native app flow

1. User selects a local VPN bundle folder.
2. The backend validates the bundle.
3. On macOS, the app stages the bundle into a temp directory under `/private/tmp`.
4. The app writes a launcher script into that staged directory.
5. The app requests administrator privileges from macOS.
6. The launcher script starts OpenVPN using the staged config and staged working directory.
7. OpenVPN logs are written to a temp log file and streamed back into the app.
8. The app treats the VPN as connected when it sees:

```text
Initialization Sequence Completed
```

### Important implementation details

- The staged bundle exists so the elevated process does not depend on protected user-folder access.
- The launcher uses the staged directory as the OpenVPN working directory.
- The app tracks the elevated OpenVPN process and does not clean up the staged directory while the process is still alive.
- Existing OpenVPN sessions are stopped before starting a new one.

## What broke along the way

These are the main failure modes encountered during implementation:

- dialog/capability wiring was missing early on, so the folder picker itself could fail
- plain in-app OpenVPN startup failed with `utun` permission errors
- stale existing `openvpn` processes blocked new startup attempts
- macOS elevation wrappers based on shell quoting were brittle
- reading config directly from `~/Downloads` was unreliable in the elevated path
- staged config files were initially launched from the wrong working directory
- the app briefly cleaned up staged files too early because process liveness detection for the root-owned process was wrong

## User-facing behavior now

From the app, the operator can:

- select the VPN bundle folder
- click `Start VPN`
- approve the macOS admin password prompt
- wait for the VPN to connect
- continue into controller connectivity and shell access

In practice, the operator should not need to open a second terminal window just to establish the VPN.

## Current limitations

- This is not a fully packaged privileged helper architecture.
- The app still relies on a macOS elevation path rather than a long-lived privileged daemon.
- The VPN startup path is currently macOS-specific in its elevated behavior.
- There may still be polish issues around noisy OpenVPN warnings and prompt UX.

## Recommended future improvement

The clean long-term direction is a true privileged helper or daemon for VPN lifecycle management. That would:

- avoid fragile elevation wrappers
- provide a cleaner start/stop API
- reduce repeated password prompts further
- make the VPN lifecycle easier to reason about and support

## Files to read

- [src-tauri/src/backend.rs](/Users/marcsells/Developer/frontline-vpn-console/src-tauri/src/backend.rs)
- [src-tauri/src/lib.rs](/Users/marcsells/Developer/frontline-vpn-console/src-tauri/src/lib.rs)
- [src-tauri/capabilities/default.json](/Users/marcsells/Developer/frontline-vpn-console/src-tauri/capabilities/default.json)
- [src/App.tsx](/Users/marcsells/Developer/frontline-vpn-console/src/App.tsx)
- [src/services/backend.ts](/Users/marcsells/Developer/frontline-vpn-console/src/services/backend.ts)
