# FWDS Controller Console — UI Overhaul Handoff

_Two passes: **(1)** migrate the app to the Frontline Wildfire Defense (FWD) design
system — **done, in this change**; **(2)** an exploratory backlog of broader UI/UX
level-ups for a future design session — **below.**_

Source of truth for the brand: `/Users/marcsells/Developer/Frontline Design System`
(`CLAUDE.md` + `FWD_BrandBook_LowRes_2026 (1).pdf`). Navy `#002855` is the ground,
Frontline Blue `#69B3E7` is water/clarity/info, ember Orange `#FA4616` is an accent
**only**. Headlines serif (IvyPresto → Playfair), body sans (Gotham → Montserrat).

---

## Pass 1 — what shipped

The console was already **fully token-driven** (almost every color in the 4,500-line
`tabs.css` resolves through a handful of CSS custom properties). So the migration is a
**token remap** plus a shell rebuild — it cascades to every tab with almost no
per-component edits.

**New files**
- `src/styles/frontline-tokens.css` — self-contained FWD tokens (navy/blue/orange/grey
  ramps, status colors, radii, navy-tinted shadows, `--glow-data`/`--glow-ember`, motion).
- `src/styles/frontline-fonts.css` — **self-hosted** Montserrat + Playfair Display
  (latin variable woff2, in `public/brand/fonts/`). Works offline in the field — no
  Google Fonts CDN dependency at runtime.
- `public/brand/` — approved logos (`secondary-white`, `primary-onnavy`,
  `primary-fullcolor`, `icon-*`) and the Technical Topo Map (`topo-map`, `topo-map-50`,
  downscaled to ~1.4 MB each).
- `src/dev/browserTauriShim.ts` — **dev-only** shim so the UI boots in a plain browser
  for design review when the Tauri runtime is absent. Tree-shaken out of production
  builds (guarded by `import.meta.env.DEV`). This is what let me screenshot every tab.

**Changed files**
- `src/index.css` — imports the token layer, then **remaps** the app's vars
  (`--bg-*`, `--accent`, `--text-*`, `--success/--warning/--danger`, `--sans`, …) onto
  FWD tokens. Also: Montserrat base, Frontline-Blue focus rings, navy-tinted scrollbars,
  DS input styling. **This file is the single brand knob** — change brand behavior here.
- `src/App.css` — shell rebuilt: navy **topo-mapped** top bar + left rail forming a
  brand frame around light content; on-navy nav (blue active state + glowing accent bar,
  overline section labels); brand buttons (navy primary, ember `.btn-accent`, blue focus);
  12px cards with navy-tinted shadow; overline card titles; serif display headings; and a
  **dark-navy terminal** log pane.
- `src/components/shell/SidebarHeader.tsx` — uses the approved **`secondary-white`**
  horizontal lockup on the navy bar (correct on-dark version — never `*-fullcolor` on
  navy), a divider, and the "Controller Console / Field Diagnostics" product label.
- `index.html` — favicon now the brand icon (was a 404 `vite.svg`).
- `tabs.css` — one cohesion tweak (a "done" ring → `var(--success)`). **Left intentionally
  untouched:** the LED-decoder blink colors (`#27d965` green ↔ `#f7a911` amber) are
  verbatim **real hardware LED colors** — fidelity matters more than brand there.

**Verified** in-browser via the dev shim: Connect, Commands, Diagnostics, LED Decoder,
Report all render cleanly and on-brand. `npm run build` (tsc + vite) passes.

### How to change the brand later
- **Recolor / re-token:** edit the remap block at the top of `src/index.css`.
- **Swap in licensed fonts:** drop IvyPresto/Gotham woff2 into `public/brand/fonts/`,
  update `src/styles/frontline-fonts.css`, and point `--fwd-font-display`/`--fwd-font-sans`
  in `frontline-tokens.css` at them. Everything else follows.
- **Logos:** all approved lockups live in `public/brand/logos/`. On dark use
  `*-onnavy`/`*-white`; on light use `*-fullcolor`. Never recolor or distort.

---

## Pass 2 — exploratory level-ups (backlog for the next design session)

Ordered roughly by impact-to-effort. None of these are required for Pass 1 to stand on
its own.

### A. Brand-compliance follow-ups (should-do)
1. **Replace emoji with Lucide icons.** Commands, Diagnostics, Report, and the Slack
   preview use emoji as category glyphs (📶 🛰 💧 💾 …). The brand book says **no emoji**;
   its sanctioned substitute is **Lucide** (`lucide.dev`, ~1.5–2px stroke). Map each
   category to a Lucide glyph (wifi, satellite-dish, droplet, hard-drive, …) and render
   inline SVGs so it stays offline. This is the single biggest remaining brand gap.
2. **License the real fonts.** Playfair/Montserrat are the brand-book-approved
   *substitutes*. Swap to **IvyPresto + Gotham** for exact fidelity (one-file change, see
   above).
3. **Bundle a mono for the console.** `--mono` asks for JetBrains Mono but it isn't
   shipped, so it falls back to SF Mono/Menlo. Self-host JetBrains Mono (or commit to the
   system stack) so the terminal/command type is identical on every machine.

### B. Componentization & consistency
4. **Unify the status vocabulary.** There are ~5 near-duplicate pill/badge styles
   (`.badge`, `.status-pill`, `.sd-pill`, `.nav-beta-pill`, `--led-*` badges). Extract one
   `Badge` component with tones `neutral | info | success | warning | danger` and sizes.
   Keep hardware-LED colors (green/amber/red) as a **separate literal set** from UI
   semantics so the two never drift.
5. **Extract shared primitives** the tabs already re-implement: `SegmentedControl`
   (mode toggles appear in Connect, Diagnostics, Commands), `Card`/`CardHeader`,
   `IconButton` (the many Copy/Send pairs → icon + tooltip to cut visual noise), and a
   `SectionLabel` overline. Mirror the DS `components/core` API so it's portable.
6. **A type scale utility set.** Pass 1 applies serif to page titles by class list; a
   small set of `.t-display / .t-h1 / .t-h2 / .t-overline` helpers (from the DS type
   tokens) would replace ad-hoc inline `font-size` and keep hierarchy consistent.

### C. Experience polish
7. **Designed empty states.** "No data yet" / "Diagnostics not collected" repeat across
   Diagnostics and Report. Give them an icon, one line of guidance, and the exact next
   action (e.g. a "Run quick diagnostics" button) — turns dead space into wayfinding.
8. **Live-state motion.** The DS ships a calm **status pulse ring** (`--glow-data`) and a
   reduced-motion guard. Use it on "connecting"/"running" states (header pill, diagnostics
   cards) instead of static dots. Add skeleton shimmer to diagnostics cards while a block
   runs.
9. **Connection-aware header accent.** A thin top hairline on the navy header that shifts
   neutral → Frontline-Blue (connected) → ember (alert) gives an at-a-glance system state
   without new chrome. Keep ember strictly for genuine alerts.
10. **Toast/notification channel.** Command results and copy confirmations currently have
    only the top alert band. A lightweight toaster (bottom-right, navy surface) would
    confirm Copy/Send and surface non-fatal errors without stealing the header.
11. **Terminal pane affordances.** The new dark console is a highlight — add a small
    header strip with a copy-all button and an optional wrap/scroll-lock toggle.

### D. Bigger bets
12. **Native dark mode.** Field technicians work at night. The palette is already
    navy-native — a true dark theme (navy surfaces, blue/ember accents) would be
    compelling and is mostly a second token map behind `prefers-color-scheme` / a toggle.
13. **Custom Tauri titlebar.** A navy custom titlebar (window `decorations: false`) would
    extend the brand frame to the OS chrome and unify Mac/Windows. Align the app/window
    icon (`app-icon.png`) to the brand shield.
14. **Setup Wizard as a proper stepper.** Lots of room to make onboarding shine with the
    DS spacing rhythm, serif step titles, and a progress rail.

### E. Accessibility & housekeeping
15. **Contrast audit.** Pass 1 deepened `--accent` to ~AA on white and added
    Frontline-Blue `:focus-visible` rings everywhere. Do a full pass at AA — especially
    small mono text in blue, muted-grey secondary text, and status pills on the navy header.
16. **Remove the now-unused `public/logo.png`** (538 KB; the header no longer references
    it — left in place only to avoid touching packaging).
17. **Keyboard & reduced-motion review.** Reduced-motion is honored for the LED animation;
    extend the same guard to any new pulse/skeleton motion.

---

_Prepared as a follow-up to the design-system migration. The migration itself is complete,
builds clean, and is verified across all tabs; everything in Pass 2 is optional and
additive._
