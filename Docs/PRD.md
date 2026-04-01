# FWDS Controller Console
## Product Requirements Document · v2.0

**Status:** In Development
**Last updated:** March 2026
**Platform:** macOS Desktop (Tauri + React)
**Audience:** Internal — Field Technicians, Support Engineers

---

## Product Overview

FWDS Controller Console is a local desktop application for field technicians and support engineers who connect to, configure, and diagnose Frontline wildfire defense controllers over OpenVPN and SSH.

The app replaces a fragile multi-tool workflow — terminal, Slack, spreadsheet, memory — with a single guided surface. All credential handling and process execution remain local to the operator machine.

Version 2 expands from basic VPN and command execution into a full technician workflow platform covering: connection management, guided setup, command tooling, live diagnostics, intelligent troubleshooting, and session history.

---

## Goals

### Primary
- Reduce time-to-connected for controller sessions
- Eliminate setup errors caused by manual prompt entry
- Surface diagnostic findings automatically without requiring terminal expertise
- Give technicians actionable troubleshooting guidance based on known issue patterns
- Build an institutional knowledge base from every session automatically

### Non-Goals
- Full automation of controller setup — operator-in-the-loop is intentional
- Cloud-hosted execution or credential syncing
- Multi-user concurrent sessions
- Public-facing or customer-accessible interface

---

## Users

### Field Technician
Performs new installs and on-site troubleshooting. Needs fast, guided workflows with clear prompts and copyable answers. Less likely to interpret raw terminal output.

### Support Engineer
Handles remote diagnostics and escalations. Needs deep diagnostic output, session history, and the ability to identify patterns across sites.

---

## Features

---

### 01 · Connect
**VPN management, controller access, and terminal launch**

- Select local VPN bundle folder with file validation and permission fixing
- Start / stop OpenVPN with live status — detects "Initialization Sequence Completed"
- Enter controller VPN IP with automatic last-octet extraction
- Ping + port 22 pre-flight diagnostics
- Clear status indicators in header: VPN ● Controller ● SID
- **Launch Controller Terminal** button — opens macOS Terminal.app with script-wrapped SSH command
- SSH command includes session logging to `~/Desktop/fwds-{IP}-{date}.txt` automatically
- `ServerAliveInterval` set to prevent silent timeout disconnects
- Status badges persist across all tabs in the app header

---

### 02 · Commands
**Searchable command palette with grouped diagnostic blocks**

- Pinned favorites for the commands used on every session
- Full searchable list with descriptions and reboot/destructive warnings
- Commands grouped by category: Config, Diagnostic, Info, System
- **Grouped diagnostic blocks** — one-click to copy a full block of related commands:
  - **Ethernet block:** `ethernet-check`, `ethtool eth0`, `ifconfig eth0`
  - **Wi-Fi block:** `wifi-check`, `wifi-signal`
  - **Cellular block:** `cellular-check`, `cell-signal`, `cell-provider`, `cell-ccid`, `cell-imei`
  - **Satellite block:** `satellite-check -m`
  - **System block:** `version`, `sid`, `release`
- Destructive commands (`factory-reset`, `setup-system`) require confirmation before copy
- Guard levels: `none` / `confirm` / `hard` — hard-guarded commands require typed confirmation

---

### 03 · Diagnostics
**Live cards populated from session log output**

- App watches the `script` session log file written by the terminal in real time
- Parses output from diagnostic commands and populates structured cards automatically
- **Cards:** Ethernet, Wi-Fi, Cellular, Satellite, Power, Manifold Pressure, Source Pressure, Cloud Sync, Firmware
- Each card shows: status dot (green / orange / red), summary line, expandable detail rows
- **Ethernet card** detects: connected, no-link, DNS failure, flapping (dmesg pattern)
  - Flap detection: counts Up/Down events, interval analysis, speed fallback detection
- **Wi-Fi card:** SSID, signal strength, channel, frequency, latency, wifi-check result
- **Cellular card:** provider, signal, IMEI, ICCID, packet loss, latency
- **Satellite card:** enabled status, IMEI, last contact, offline/online
- **Firmware card:** current version, update available flag
- Status rules defined in external JSON rulebook — no code changes needed to add rules

---

### 04 · Troubleshooting
**Findings summary and recommended action plan**

- Aggregates all diagnostic card results into a single findings view
- Each finding shows: severity, plain-language description, recommended action
- Findings matched against a JSON knowledge base of known issue patterns
- **Ethernet issues:** not enabled, no link (bad port/cable), DNS failure, link flapping, DHCP failure
- **Wi-Fi issues:** not configured, weak signal, wrong SSID, not connected
- **Cellular issues:** no SIM, registration failure, weak signal, APN misconfiguration
- **Satellite issues:** offline, never contacted, IMEI not registered
- **Copy Action Plan** button generates a plain-text summary for Slack/email
- Action plan includes: site, SID, date, findings list, recommended steps
- Knowledge base is a separate JSON file — engineering can add patterns without app changes

---

### 05 · Setup Wizard
**Intake-driven step-by-step install guide**

- Paste PM intake row (tab-separated from Slack/Sheets) to populate all fields automatically
- Review and edit: customer name, location, install date, HHC type, zones, network config
- Zone map editor: type (Roof/Eave/Perimeter), name, add/remove zones
- Preflight checklist: operator checks off pre-conditions before starting
- **Step-by-step run view:** each step shows the command to run and expected controller prompts
- Every prompt answer is pre-filled from intake data with a one-click **Copy** button
- Steps: `setup-station` → `setup-system` → `setup-network` (Wi-Fi, cellular, preferred) → reboot → diagnostics
- Operator marks each step done before advancing — no automation, full operator control
- Wi-Fi password shown with reveal toggle — never visible in plain text by default

---

### 06 · Session History
**Automatic session records with search and export**

- Every session is recorded automatically: site, SID, VPN IP, date/time, commands run
- Diagnostic card results saved with each session — no manual entry required
- Operator adds two fields: **what action was taken** (free text) and **outcome** (Resolved / Escalated / Follow-up)
- Session list view: most recent first, searchable by site, SID, date, or outcome
- Session detail view: full findings, actions taken, diagnostic snapshot
- **Copy for Slack** generates a formatted summary: site, SID, findings, action, outcome
- Storage: local SQLite database via Tauri — no cloud sync, no credentials stored
- History enables pattern detection: recurring sites, common issue types, escalation rates

---

## Terminal Strategy

The app uses a native terminal window rather than an embedded terminal emulator. This is a deliberate architectural decision.

### Why not embed the terminal

Interactive controller setup flows (`setup-wifi`, `setup-network`, etc.) rely on readline-based prompts, PTY behavior, and real-time input echo. Emulating this correctly in a web view requires a full PTY-backed xterm.js integration, which is a significant engineering investment and the source of most v1 reliability issues.

### Current approach — Native Terminal Launch

- App generates a `script`-wrapped SSH command when the controller is connected
- Operator clicks **Launch Controller Terminal** — macOS Terminal.app opens with the full command
- Session output is logged automatically to `~/Desktop/fwds-{IP}-{date}.txt` via `script(1)`
- App watches the log file and populates diagnostic cards from output in real time
- Operator gets a real terminal with perfect interactive behavior
- App stays open alongside as the command palette, wizard, and diagnostics surface

### Future — xterm.js Embedded Terminal

Once the diagnostic card system is stable, the preferred long-term direction is a PTY-backed xterm.js terminal embedded in the app. This would unify the terminal and diagnostic surfaces into a single window. The script-based approach is the correct interim solution.

---

## Diagnostic System Detail

### Session Log Listener

The Tauri backend watches the `script` session log file using kqueue (macOS file events). As new bytes are appended, the backend runs them through the diagnostic parser and emits updated card state to the frontend via polling.

### Parser Architecture

- Each diagnostic subsystem has a dedicated parser function
- Parsers extract structured fields using line-by-line regex matching
- Parsed data is compared against the rulebook to determine status and findings
- Rulebook is a JSON file at a known path — no recompile needed to add rules

### Ethernet Status Rules

| Status | Trigger Conditions | Recommended Action |
|---|---|---|
| 🟢 Connected | `Done: Success`, link detected: yes | None |
| 🟠 DNS Failure | `Done: Failure`, link: yes, DHCP IP present | Check router upstream connectivity |
| 🔴 No Link | Link detected: no, RX errors > 0, no DHCP IP | Swap switch port, then cable |
| 🔴 Flapping | dmesg: Up/Down > 3 events, interval < 30s | Force switch port speed or swap port |

---

## Architecture

### Frontend
- React + TypeScript
- 6 tabs: Connect, Commands, Diagnostics, Troubleshooting, Setup Wizard, History
- xterm.js (future embedded terminal)
- Polling-based state updates from Tauri backend

### Backend (Rust / Tauri)
- OpenVPN process management
- SSH session with PTY
- File watcher for session log (kqueue)
- Diagnostic parser pipeline
- SQLite session history (`tauri-plugin-sql`)

### Data Files (editable without recompile)
- `src/data/rulebook.json` — diagnostic status rules and thresholds
- `src/data/issues.json` — known issue patterns and recommended actions
- `src/types/commands.ts` — command catalog with descriptions and guard levels

### Security Model
- All credential material stays on the operator machine
- No VPN keys, SSH keys, or session material uploaded anywhere
- SQLite stores only non-secret session metadata
- Wi-Fi passwords shown only on explicit reveal — never logged to session history

---

## Recommended Build Order

Features are ordered by dependency and operator impact. Complete each before starting the next.

1. **Connect tab polish** — Launch Controller Terminal button, script-wrapped SSH, ServerAliveInterval, status header badges
2. **Commands tab — diagnostic blocks** — Grouped multi-command blocks with single copy, guard levels wired
3. **Setup Wizard run view** — Step-by-step copyable playbook from intake data, replaces current placeholder
4. **Session log file watcher** — Tauri backend kqueue watcher, pipes new bytes to parser pipeline
5. **Diagnostic parsers** — Ethernet first (most data collected), then Wi-Fi, Cellular, Satellite, Power, Pressure
6. **Diagnostics tab — cards UI** — Card components consuming parsed state, expand/collapse, color-coded status
7. **Rulebook + issue JSON** — External files for status rules and known issue patterns
8. **Troubleshooting tab** — Findings aggregation, action plan, Copy for Slack
9. **Session History — SQLite** — Auto-capture session records, list/detail view, search, Slack export
10. **xterm.js embedded terminal (future)** — PTY-backed Rust backend, replaces native terminal launch when ready

---

## What You Need to Provide

The following inputs are needed to complete the build. Items marked **BLOCKING** must be provided before the relevant feature can be built.

---

### Diagnostic Command Outputs · BLOCKING (Diagnostics tab)

- `wifi-check` raw terminal output — connected and disconnected examples
- `cellular-check` raw terminal output — connected, no SIM, weak signal examples
- `satellite-check` output — online and offline examples
- `cell-signal` and `wifi-signal` output format
- `version` and `sid` output format
- Manifold pressure and source pressure output format (if separate commands exist)

---

### Rulebook — Status Thresholds · BLOCKING (Diagnostics + Troubleshooting)

- **Wi-Fi:** what signal score is green / orange / red? (e.g. >70 green, 40–70 orange, <40 red)
- **Cellular:** signal thresholds and what constitutes a passing `cellular-check`
- **Satellite:** what does a healthy `satellite-check -m` result look like vs unhealthy
- **Power:** voltage range for green (12.0–15.0V shown in mock — confirm)
- **Manifold pressure:** expected PSI range for normal operation
- **Source pressure:** expected PSI range for normal operation

---

### Known Issues Knowledge Base · BLOCKING (Troubleshooting tab)

For each subsystem (Ethernet, Wi-Fi, Cellular, Satellite, Power, Pressure):
- What are the failure modes you see most in the field?
- What commands confirm the diagnosis?
- What is the recommended fix?

> Ethernet is already partially documented from this conversation. Needs Wi-Fi, Cellular, Satellite. Start with the 3 most common issues per subsystem.

---

### Intake Form Column Mapping (Setup Wizard)

- Confirm current tab-separated column order matches `parseIntake.ts` (or provide updated sheet headers)
- Confirm whether `customer_name` comes from the intake or is entered separately
- List any new fields added to the intake form since the parser was written

---

### Setup Command Prompt Sequences (Setup Wizard run view)

- `setup-station`: confirm exact prompts and expected field order
- `setup-system`: confirm all prompts for MP3, HP6, Legacy, LV2 — they differ per HHC type
- `setup-wifi`: confirm the full Add / Replace / Use prompt flow
- `setup-cellular`: confirm prompts
- `setup-preferred-network`: confirm prompts and valid values

---

### Nice to Have

- Example of a completed session you'd want in session history — helps nail the Slack export format
- Any existing runbook or checklist used during installs — can be imported into the wizard

---

## Success Metrics

### Efficiency
- Time to connected controller session
- Time to complete new install
- Commands run per session (fewer = better guided)

### Quality
- Setup errors requiring redo
- Escalations to engineering
- Sites with recurring issues (tracked via history)

---

*FWDS Controller Console · Internal PRD · March 2026 · Confidential*
