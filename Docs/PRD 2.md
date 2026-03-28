# Frontline Remote Controller Console (Local App)

## Overview

A local desktop application that simplifies connecting to and configuring Frontline wildfire defense controllers via VPN and SSH.

The app replaces a complex terminal workflow with a guided UI for:

* VPN connection
* Controller access
* Remote setup and diagnostics

---

## Goals

### Primary Goals

* Reduce friction in VPN + SSH controller access
* Standardize remote setup workflows
* Reduce operator errors
* Provide clear diagnostics and logs

### Non-Goals (v1)

* Full automation of controller setup (operator-in-the-loop only)
* Cloud-hosted execution
* Credential storage or syncing

---

## Users

### Primary User

* Internal operator / technician
* Running remote controller setup and diagnostics

---

## Core Workflows

### 1. Connect to VPN + Controller

1. Select VPN folder
2. Validate required files:

   * ovpn.conf
   * ovpn.crt
   * ovpn-fwds-client.crt
   * ovpn-fwds-client.key
   * station
   * connect.bin
3. Start OpenVPN
4. Detect "Initialization Sequence Completed"
5. Enter controller VPN IP (e.g. 10.9.0.14)
6. Run `connect.bin <last_octet>`
7. Open interactive shell

---

### 2. Remote Setup (Guided)

Driven by intake form data:

* property
* structure name
* controller ID
* system type
* features installed
* drain type
* zones + zone map
* Wi-Fi credentials (secure source)
* additional instructions

Steps:

1. Preflight checks
2. Run setup commands
3. Provide expected answers
4. Assist with zone mapping
5. Configure network
6. Reboot controller
7. Run diagnostics

---

### 3. Diagnostics

Provide:

* VPN logs
* SSH/connect logs
* ping results
* port 22 check
* command transcript

Export via:

* "Copy diagnostics"

---

## Key Features

### Session Management

* Folder picker
* File validation
* Permission fixing (station key)
* Start/stop OpenVPN
* VPN status indicator

### Controller Access

* Input VPN IP
* Auto-extract last octet
* Run connect.bin
* Terminal UI

### Terminal / Console

* Interactive shell (or command input + output pane in v1)
* Command history

### Preset Commands

* setup
* setup-network
* setup-system
* setup-station
* wifi-check
* cellular-check
* ethernet-check
* satellite-check -m
* cell-signal
* wifi-signal
* sid
* version
* release
* reboot

### Remote Setup Assistant

* Intake form viewer
* Zone mapping helper
* Runbook checklist
* Expected answers panel

---

## Architecture

### App Type

* Local desktop app (Tauri)

### Frontend

* React + TypeScript

### Backend (local)

* Tauri (Rust)
* Executes:

  * openvpn
  * connect.bin
  * ping / nc

### Security Model

* All credentials remain local
* No uploading of keys
* No secrets in repo

---

## MVP Scope (v1)

### Included

* Folder selection
* File validation
* VPN start/stop
* Controller connect
* Log viewer
* Preset commands

### Not Included

* Full automation of setup
* Cloud sync
* Multi-user support

---

## Future Enhancements

* Remote job ingestion from dashboard
* Session recording
* Auto-reconnect flows
* Role-based UI (field vs engineering)
* Secure credential integration (1Password, etc.)

---

## Success Metrics

* Time to connect to controller ↓
* Setup errors ↓
* Support/debug time ↓
* Operator satisfaction ↑

---

## Risks

* Credential handling mistakes
* Over-automation of fragile setup flows
* Platform-specific issues (macOS networking)

---
