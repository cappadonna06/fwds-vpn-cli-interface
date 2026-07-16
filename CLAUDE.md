# Project context for Claude Code

## Local documentation (Docs/_local)

The `Docs/_local/` folder contains work-in-progress and release assets — files kept locally that are not tracked in Git.

### Release assets
- **User Guide (release asset/)** — published user guide (`.pptx`) and embedded fonts. Attach to GitHub/GitLab releases.
- **FWDS Controller Console - Release Notes (vX.Y.Z).docx** — field-facing release notes (versioned). Update this with each release, matching the changelog in `CHANGELOG.md`. Attach to releases.

### Product documentation
- **fwds-controller-console-prd.docx** and **fwds-controller-console-prd.md** — Product Requirements Document. **Maintain both formats** — the `.docx` is the canonical source (owned by product), and the `.md` is the Git-friendly export for easy diffing. When updating the PRD:
  1. Edit the `.docx` in Word (styles, formatting, embedded images).
  2. Export/convert the `.docx` to `.md` so Git can track changes.
  3. Commit both files together.

### Reference documentation (_archive/ and root)
- Controller notes, platform-specific setup, diagnostic rules, design handoff. See `_archive/README.md` for details.

## Release process

See [`RELEASING.md`](RELEASING.md) for cutting releases, updating the changelog, and tagging.
