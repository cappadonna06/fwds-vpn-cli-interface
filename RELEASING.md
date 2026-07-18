# Releasing & the changelog

We keep a human-readable changelog in [`CHANGELOG.md`](CHANGELOG.md), following the
[Keep a Changelog](https://keepachangelog.com) format. It is written for the people who
use the console in the field, not for engineers.

## Keeping the changelog

Every user-visible change adds a bullet under the **`## [Unreleased]`** section at the top
of `CHANGELOG.md`, in the right group:

- **New** — a new feature or capability (Keep a Changelog's *Added*)
- **Improved** — a change to existing behavior or look (*Changed*)
- **Fixed** — a bug fix (*Fixed*)

Write each entry for a field user: say what changed **for them**, in plain language, not how
the code changed. Internal detail belongs in the pull request, not here.

If a change has no user-visible effect (refactor, tooling, tests), it needs no changelog entry.

## Cutting a release

Releases go out through a **release PR**. It should:

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] — <Month Year>`, then add a
   fresh empty `## [Unreleased]` section above it.
2. Bump the version to `X.Y.Z` in:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`

   (`package-lock.json` and `Cargo.lock` update to match.)

After the release PR merges to `main`, tag the release:

```bash
git fetch
git tag -a vX.Y.Z origin/main -m "vX.Y.Z"
git push origin vX.Y.Z
```

Then create a **GitLab Release** for the tag and attach the field-facing
deliverables as release assets (they are intentionally not tracked in the repo):

- the end-user guide (`FWDS Controller Console - User Guide (vX.Y).pptx`, and a
  PDF export if available)
- the built app bundles, if you are distributing them through GitLab

The current guide and its rebuild fonts are kept locally under
`Docs/_local/` for re-export between releases.

## Versioning

We use [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **PATCH** — bug fixes, no new features.
- **MINOR** — new features, backward compatible.
- **MAJOR** — breaking changes.

## History

`v0.1.2` was the first shipped release (macOS Apr 24 2026 / Windows Apr 27 2026) and was
tagged retroactively; every release since goes through the process above.

`0.2.0` was prepared in the repo (changelog entry and version bump) but never tagged or
distributed. `v0.2.1` was tagged and a GitHub release was cut (Jul 14 2026), but it was
superseded before any field use by `v0.2.2` — the Windows connection workflow was not yet
working in it. `v0.2.2` is therefore the first distributed release after `v0.1.2`, which is
why the changelog jumps from `0.1.2` straight to `0.2.2`: neither `0.2.0` nor `0.2.1` reached
the field.
