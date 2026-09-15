# RootRay Status

## Overall Progress
80%

## Current Milestone
Milestone 04 — Project Intelligence & Styling

## Milestone Status
Complete

## Implemented

Everything from Milestones 01–03 (detection, lifecycle, inspector bridge,
instrumentation, safe Quick Edit — all preserved and passing), plus:

- **Lazy Project Explorer** (`crates/rootray-core/src/filesystem/nav.rs` +
  `features/explorer/ExplorerPanel.tsx`) — directory children are listed
  per expand only; deterministic sorting (dirs first, then
  case-insensitive name); generated dirs (`.git`, `node_modules`,
  `target`, `dist`, `build`, `coverage`, `.e2e-work`,
  `playwright-report`, `test-results`) and all secret-file deny rules
  applied; per-directory caps mark truncation instead of hanging.
  Actions: Quick Edit, Open External, Copy Relative Path — no
  delete/rename/move.
- **Quick Open (`Ctrl+P`)** (`features/nav/QuickOpen.tsx`) — fuzzy
  subsequence matching with basename-weighted ranking over a lazily
  fetched, capped file list (`list_project_files`, 5000-file cap);
  arrow/Enter/Escape keyboard navigation, 50-result cap; selection goes
  through the single Quick Edit session so the dirty-editor guard
  applies unchanged.
- **Workspace Search (`Ctrl+Shift+F`)** (`nav.rs::search_workspace` +
  `features/nav/SearchPanel.tsx`) — bounded text search over
  `.js/.jsx/.ts/.tsx/.css/.scss/.html/.json/.md` returning relative
  file + line + column + preview; CRLF-correct line numbering; secrets,
  binaries, oversized files and generated dirs skipped; file-count,
  byte and result caps enforced; disappearing files tolerated; a
  monotonic request id drops stale results. Results open at the exact
  location through Quick Edit.
- **Static React intelligence** (`packages/intelligence`) — Babel-based
  analysis of `.js/.jsx/.ts/.tsx` sources collected via the bounded
  native `collect_source_files` command (count/byte/file-size caps).
  Detects function, arrow and class component definitions with
  name/path/line/column/kind/export-type; resolves local JSX usages
  through relative imports including unambiguous `index` re-exports;
  labels unresolved relationships instead of guessing. Source is parsed
  as data — never executed.
- **Component panel** (`features/inspector/ComponentSection.tsx`) — for
  a selected element shows the owning component, its definition site,
  and every resolved caller (`Used by`), each navigable via Quick Edit.
- **Style intelligence** (`packages/inspector-runtime/src/styles.ts`) —
  on selection only (never on hover): class tokens, element id, box
  model (x/y/w/h + margin/border/padding per side), ~20 curated
  computed properties, and matched CSS rules (selector, bounded
  declarations, important flags) via accessible CSSOM. `SecurityError`
  stylesheets are skipped safely. Vite `data-vite-dev-id` hints are
  normalized to project-relative stylesheet paths and rejected if they
  escape the root; ambiguous line resolution is never fabricated.
- **Styles UI** (`features/inspector/StylesSection.tsx`) — Classes (with
  Copy and Search-in-Project per token), visual Box Model
  (margin ⊃ border ⊃ padding ⊃ content), Computed list, Matched Rules
  with per-rule stylesheet navigation (Quick Edit / Open External).
- **Copy Context** (`features/inspector/copyContext.ts`) — bounded
  (~4 KB cap) factual block: component, source location, tag, classes,
  resolved callers, matched style sources, small source snippet.
  Relative paths only; no secrets, no absolute paths, no file dumps.
- **Recent files** (`lib/recents.ts`) — per-project, project-relative,
  capped at 10, populated on Quick Edit opens, surfaced in the Explorer.
- **Lazy, invalidatable analysis** (`features/intelligence/controller.ts`)
  — the parser lives in a lazy chunk; the snapshot is cached per project
  and invalidated by every source change path (RootRay save, clean
  auto-reload, detected external edit). No watchers, no idle indexing.
- **Tauri command surface** — `list_project_dir`, `list_project_files`,
  `search_workspace`, `collect_source_files`. All re-validate against
  the canonicalized project root on every call.
- **Fixture** — `App → Navbar → Logo` and `App → Card → ActionButton ×2`
  with `styles/app.css`, `card.css`, `button.css`, named + default
  exports, local imports, nested elements and SVG (in Logo).

## Architecture

```
Explorer/Ctrl+P/Ctrl+Shift+F ─▶ filesystem/nav.rs
    (lazy dir listing, bounded walk, bounded search; relative-only,
     canonicalized, secrets/generated denied, caps on files/bytes/results)
Click-select ─▶ runtime styles.ts (classes/box/curated computed/CSSOM rules
    + vite-dev-id → relative stylesheet) ─▶ bridge (validated, bounded)
Component panel ─▶ collect_source_files (capped corpus)
    ─▶ @rootray/intelligence lazy chunk: Babel parse → defs/usages/imports
    ─▶ cached snapshot, invalidated on any source change
Any navigable location ─▶ Quick Edit (same Milestone 03 safe path)
```

Browser messages remain data only; styles ride the existing validated
selection message. All privileged actions are explicit commands. See
`docs/architecture.md` and `README.md`.

## Verification

### Automated
- `cargo test -p rootray-core`: **124 passed, 0 failed, 1 ignored** —
  adds the `project_nav` suite (16 tests): lazy listing, ignored dirs,
  denied secrets, traversal/absolute rejection, caps + truncation flags,
  disappeared files, search matches/line numbers/CRLF, binary skipping,
  bounded source collection.
- `pnpm -r test` (Vitest): **123 passed** — shared 7, source-protocol 14,
  inspector-runtime 14, vite-plugin 19, **intelligence 17** (component
  defs of all kinds, named/default exports, usage resolution, import +
  index re-export, unresolved labeling, malformed-source resilience,
  limits), **desktop 52** (fuzzy matching/ranking, recents, copy-context
  sanitization, plus all prior suites).
- `pnpm --filter @rootray/e2e test` (Playwright, real Chromium): **11
  passed** — all Milestone 02/03 suites plus the intelligence spec:
  classes + box + computed + matched rules on selection, stylesheet
  resolves to a real safe-openable relative path, and the full component
  tree derived from the real fixture with navigable caller locations.
- `pnpm -r typecheck` (tsc strict, `exactOptionalPropertyTypes`): clean.
- `pnpm exec biome check .`: clean.
- `cargo check -p rootray-core` / `-p rootray-desktop`: clean.
- `cargo build -p rootray-desktop`: clean.
- `pnpm --filter @rootray/desktop build`: clean.

### Manual / Live
- The inspect → styles → stylesheet-Quick-Edit loop, component tree and
  search/explorer paths were verified end-to-end in a real browser
  against a real Vite server via the E2E suite. The Tauri GUI itself was
  not click-driven in this environment.

## Performance

- Initial frontend bundle: **271 KB JS** (83 KB gzip) + 17 KB CSS —
  up ~16 KB from Milestone 03 for the new UI; `@babel/parser` and all
  intelligence code live in a separate lazy 313 KB chunk fetched on
  first intelligence request; CodeMirror remains a lazy 320 KB chunk.
- Fixture component analysis (5 source files): ~34 ms end-to-end.
- Explorer/Search/Quick-Open native calls return per-request bounded
  results (dirs ≤ 500 entries; files ≤ 5000; search ≤ 500 results over
  ≤ 500 files / ≤ 8 MiB); nothing is cached or watched project-wide.
- Style payload per selection: ~1–3 KB of validated data.

## Known Issues

- Smart App Control may still flag fresh unsigned binaries (environmental).
- Inspector unavailable for dev scripts beyond `vite` + supported flags —
  falls back to the plain runner rather than touching the project.
- Playwright E2E uses a protocol-faithful mock bridge; the Rust bridge
  itself is covered by the Rust suite, not browser automation.
- One Quick Edit session at a time — switching files with unsaved
  changes goes through the discard prompt rather than tabs.
- Import aliases (`@/…`), deeper re-export chains, and dynamic imports
  resolve as *unresolved* by design.
- Matched-rule navigation targets the stylesheet file, not the selector
  line — selector-level line resolution is intentionally not fabricated.
- A broken-then-fixed module occasionally needs a manual page reload for
  Vite to recover — the E2E documents this real-world fallback.
- Unix `stop` kills only the direct child — Windows is the target.

## Deferred

- Multi-file edit tabs; selector-line resolution; deeper import
  resolution (aliases, barrels).
- LSP/autocomplete, formatters, permanent file history.
- Non-React frameworks, production-build instrumentation.
- GUI-level automation of the Tauri shell (WebView2 driver).

## Next Milestone
Milestone 05 — Release Hardening, Windows Packaging & MVP Final Acceptance.

## Last Updated
2026-09-15
