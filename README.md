# FWDS Controller Console

A local desktop application for Frontline Wildfire Defense field technicians and
support engineers. It provides a single guided surface to **connect to, configure,
and diagnose** Mark I (WFDS) controllers — replacing the fragile
terminal + Slack + spreadsheet workflow with one tool.

All credential handling and process execution stay **local to the operator's
machine**. This is a desktop app, not a hosted service.

> **Proprietary & Confidential.** Internal Frontline Wildfire Defense software.
> See [`LICENSE`](LICENSE).

---

## Highlights

- **Connect three ways** — over OpenVPN (macOS), on the local network via SSH with
  no VPN (macOS), or over local serial/USB (Windows).
- **Guided setup & commands** — run controller command blocks and read the results
  back, with a setup wizard and a preset command palette.
- **Live diagnostics** — parsed status cards for Wi-Fi, cellular, ethernet,
  satellite, pressure, and firmware, with severity and recommended actions.
- **Additional tools** — an SD Card Maker for writing controller images and an
  LED Decoder for the front-panel indicator lights.
- **Session reports** — shareable summaries, including Slack-formatted output.

See [`CHANGELOG.md`](CHANGELOG.md) for what shipped in each release.

## Platform support

| Platform | Connection method | Notes |
| --- | --- | --- |
| macOS | OpenVPN, or local network (SSH) | VPN startup uses an elevated launch path; see [`Docs/platform-notes.md`](Docs/platform-notes.md). |
| Windows | OpenVPN, local network (SSH), or local serial (USB/COM) | SSH and serial open in PuTTY; the app sends commands to that real terminal and parses its session log for diagnostics. |

## Tech stack

- **Shell:** [Tauri v2](https://tauri.app) (Rust backend, native desktop window)
- **Frontend:** React 18 + TypeScript, built with Vite 6
- **Backend:** Rust (Tauri command layer); orchestrates `openvpn`, `ssh`,
  `connect.bin`, and controller command execution
- **Design system:** Frontline Wildfire Defense (FWD) brand tokens, self-hosted
  fonts for offline field use

---

## Getting started

### Prerequisites

- **Node.js** 18+ and npm
- **Rust** stable toolchain (via [rustup](https://rustup.rs))
- **Tauri prerequisites** for your OS — see the
  [Tauri setup guide](https://tauri.app/start/prerequisites/)
- Platform tools used at runtime: `openvpn`, `ssh`, `nc`/`ping` (macOS);
  PuTTY (Windows)

### Install

```bash
npm install
```

### Develop

Run the app with hot-reloading frontend and the Tauri shell:

```bash
npm run tauri dev
```

To iterate on the UI alone in a browser (no controller/native features), a dev
shim stands in for the Tauri bridge:

```bash
npm run dev
```

### Type-check & build the frontend

```bash
npm run build      # tsc type-check + vite build
```

### Build a distributable app bundle

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`.

---

## Repository layout

```
.
├── src/                # React + TypeScript frontend
│   ├── components/      # Shell and per-tab UI
│   ├── lib/             # Parsers, report generation, LED decoder, command actions
│   ├── styles/          # FWD design tokens and self-hosted fonts
│   └── types/           # Shared TypeScript types
├── src-tauri/          # Rust backend (Tauri v2)
│   └── src/             # Command layer, controller output parsers
├── public/brand/       # Brand assets (logos, fonts, topo map)
├── Docs/               # Architecture, commands, workflows, PRD, user guide
├── CHANGELOG.md        # Field-facing release notes (Keep a Changelog)
├── RELEASING.md        # Release + changelog process
└── CONTRIBUTING.md     # Branching, commits, and merge request conventions
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [`Docs/architecture.md`](Docs/architecture.md) | System design, process model, controller connection & transcript handling |
| [`Docs/platform-notes.md`](Docs/platform-notes.md) | macOS OpenVPN elevation path and Windows local-serial setup |
| [`Docs/commands.md`](Docs/commands.md) | Controller command catalog exposed in the app |
| [`Docs/workflows.md`](Docs/workflows.md) | End-to-end operator workflows |
| [`Docs/PRD.md`](Docs/PRD.md) | Product requirements |
| [`Docs/reference/`](Docs/reference) | Field process guides (PDF) |

The **end-user guide** (PowerPoint) is published as a **release asset** on each
`vX.Y.Z` tag — see the project's Releases page — rather than tracked in the repo.

## Contributing & releasing

- Development conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Cutting a release and keeping the changelog: [`RELEASING.md`](RELEASING.md)
