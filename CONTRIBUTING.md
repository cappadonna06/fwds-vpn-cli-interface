# Contributing

Internal development guide for the FWDS Controller Console. For the product
overview and setup steps, see [`README.md`](README.md).

## Local development

```bash
npm install
npm run tauri dev     # full app (native shell + controller features)
npm run dev           # UI-only in a browser, via the Tauri dev shim
npm run build         # tsc type-check + vite build (run before opening an MR)
```

See [`Docs/architecture.md`](Docs/architecture.md) for how the frontend, Rust
backend, and controller connection paths fit together.

## Branching

- `main` is the integration branch and should always build.
- Branch off `main` using a descriptive prefix:
  - `feat/<short-name>` — new capability
  - `fix/<short-name>` — bug fix
  - `docs/<short-name>` — documentation only
  - `chore/<short-name>` — tooling, refactor, no user-visible change
  - `release/vX.Y.Z` — release preparation (see [`RELEASING.md`](RELEASING.md))

## Commits

- Write clear, imperative commit subjects (e.g. `fix: cellular card false hardware fault`).
- Prefer a [Conventional Commits](https://www.conventionalcommits.org) prefix
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`) — it keeps history scannable.
- Keep commits focused; avoid mixing unrelated changes.

## Merge requests

Open a merge request into `main` and fill in the template. A change is ready when:

- [ ] The frontend builds and type-checks (`npm run build`).
- [ ] The change was exercised in the running app where it has a runtime surface.
- [ ] A changelog entry was added under `## [Unreleased]` **if** the change is
      user-visible (see below).
- [ ] No secrets, VPN bundles, credentials, or personal paths are included.

Keep at least one reviewer from `CODEOWNERS`.

## Changelog discipline

Every **user-visible** change adds a bullet under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), in the right group (**New** / **Improved** /
**Fixed**), written in plain language for a field user. Internal-only changes
(refactors, tooling, tests) need no entry. Full rules and the release process
are in [`RELEASING.md`](RELEASING.md).

## What must never be committed

- VPN bundles, `ovpn.conf`, certificates, keys, or any `~/.ssh` material
- Real controller credentials, station keys, or customer data
- Machine-specific absolute paths (e.g. `/Users/<name>/...`)
- Personal working notes or handoff documents — keep those local

The [`.gitignore`](.gitignore) covers the common cases, but treat this as the
rule regardless of what the ignore file catches.
