# RootRay Status

## Overall Progress
60%

## Current Milestone
Milestone 03 — Safe Source Editing

## Milestone Status
Complete

## Implemented

Everything from Milestones 01–02 (detection, lifecycle, inspector bridge,
instrumentation, overlay, selection, preview — all preserved and passing),
plus:

- **Boundary-checked source access** (`crates/rootray-core/src/editor/file.rs`)
  — every operation takes a project-relative path, rejects absolute paths /
  traversal / `.git` / `node_modules` / `target` / `dist` / `build`, denies
  secret names (`.env*`, keys, `id_rsa`, `credentials*`, `secrets*`),
  sniffs NUL bytes for binaries, caps editable files at 2 MiB, UTF-8 only.
- **Encoding fidelity** — UTF-8 BOM detected and re-emitted on save;
  dominant line-ending convention (LF/CRLF) detected, normalized to LF in
  the editor buffer, and re-encoded on write; non-UTF-8 rejected rather
  than corrupted.
- **Optimistic-concurrency atomic writes** — SHA-256 of the raw on-disk
  bytes is the save token; the write path re-reads, compares, refuses with
  `SOURCE_EDIT_CONFLICT` on divergence, and writes via same-directory temp
  file + rename so a failed write never truncates the original. Temp files
  are cleaned up on both success and failure.
- **Editor session manager** (`editor/mod.rs`) — single Quick Edit session
  (YAGNI: no tabs), tracks base hash, revert snapshot (one in-memory
  previous-save copy), and a per-file `notify` watcher on the open file
  only. RootRay's own saves re-base and do not surface as external
  changes; foreign writes emit `rootray://editor-event`.
- **Revert Last Save** — restores pre-save bytes iff the disk still equals
  RootRay's last write; external divergence makes it a conflict, not a
  clobber.
- **Tauri command surface** — `open_source_editor`, `save_source_file`,
  `check_source_file`, `reload_source_file`, `peek_source_file` (read-only
  compare, no session rebase), `revert_source_save`, `close_source_editor`,
  `get_editor_state`. All re-validate against the analyzed project root.
- **Typed edit-session state** (`apps/desktop/src/state`) — `EditSession`
  (`loading/clean/dirty/saving/conflict/save_failed`) as a single typed
  slice; reducer covers open/refocus, dirty tracking, save lifecycle,
  external-change conflict, discard, revert, close prompts, and a
  deferred-open queue behind the unsaved-changes guard.
- **CodeMirror 6 editor** (`features/editor/CodeEditor.tsx`) — lazy-loaded
  chunk (104 KB gzip, none of it in the initial bundle); language support
  lazy-loaded per extension (JS/JSX/TS/TSX/CSS/SCSS/HTML/JSON + plain-text
  fallback); line numbers, active-line highlight, bracket matching,
  inspected-line marker, undo/redo, Ctrl+S save, Ctrl+F in-file search,
  dark theme matching RootRay.
- **Quick Edit panel** (`features/editor/EditorPanel.tsx`) — file header
  with dirty indicator and status badge, conflict banner
  (Reload Disk Version / Compare / keep editing), in-app line-diff view
  (own LCS implementation — no Git), Discard, Revert Last Save,
  Open External, Save; unsaved-close modal ("Keep Editing / Discard
  Changes"); dirty+switch-file requests park behind the same prompt.
- **Inspector integration** — `Quick Edit` button beside `Open Source` /
  `Copy Path`; selecting another element in the same file refocuses the
  editor marker without touching dirty content.

## Architecture

```
Inspector selection → open_source_editor (validate+read+hash+watch)
  → CodeMirror buffer (LF) → dirty/diff/search/undo
  → save_source_file(content, expectedHash)
  → re-read disk → SHA-256 compare → temp+rename atomic write
  → Vite HMR (natural filesystem watch) → browser re-renders instrumented
External write → notify watcher → hash != base → editor-event
  → clean session: auto-reload · dirty session: conflict UI (never clobbered)
```

The browser still cannot trigger any file operation — editing is an
explicit desktop command path, re-validated per call. See
`docs/architecture.md` and `README.md`.

## Verification

### Automated
- `cargo test -p rootray-core`: **108 passed, 0 failed, 1 ignored** —
  adds `source_edit` suite (26 tests): boundary/deny/binary/size/UTF-8
  reads, BOM+CRLF preservation, hash-checked writes, conflict refusal,
  atomic replace + temp cleanup, readonly-permission error, session
  save/revert, watcher fire + stop-on-drop, own-save-doesn't-notify.
- `cargo test -p rootray-core --test suite -- --ignored`: golden path
  real-Vite-server test — **passed**.
- `pnpm -r test` (Vitest): **88 passed** — shared 7, source-protocol 14,
  inspector-runtime 14, vite-plugin 19, desktop 34 (15 edit-session
  transitions, 6 diff, 2 language-detection, plus the Milestone 01/02
  reducer and format suites).
- `pnpm --filter @rootray/e2e test` (Playwright, real Chromium): **7
  passed** — Milestone 02 inspector suite (3) + new edit suite (4):
  safe save → HMR → re-inspect; line-shift re-resolution; external-edit
  conflict preserving both buffers; invalid-JSX recovery with runner
  still alive.
- `pnpm -r typecheck` (tsc strict, `exactOptionalPropertyTypes`): clean.
- `pnpm exec biome check .`: clean (0 errors, 0 warnings).
- `cargo check -p rootray-core` / `-p rootray-desktop`: clean.
- `cargo build -p rootray-desktop`: clean.
- `pnpm --filter @rootray/desktop build`: clean — main bundle 255 KB JS /
  12 KB CSS; CodeMirror isolated in a lazy 320 KB chunk (104 KB gzip)
  fetched on first Quick Edit.
- Project-integrity: E2E asserts a digest over every project file except
  the edit target is unchanged after a save — saves touch exactly one file.

### Manual / Live
- The edit→HMR→re-inspect loop, conflict rejection, and invalid-JSX
  recovery were verified end-to-end in a real browser against a real Vite
  server via the E2E suite. The save operation in-browser E2E mirrors the
  native contract (hash check + temp+rename); the native implementation is
  directly covered by the Rust suite. The Tauri GUI itself was not
  click-driven in this environment.

## Known Issues

- Smart App Control may still flag fresh unsigned binaries (environmental).
- Inspector unavailable for dev scripts beyond `vite` + supported flags —
  falls back to the plain runner rather than touching the project.
- Playwright E2E uses a protocol-faithful mock bridge; the Rust bridge and
  the real save path are covered by the Rust suite, not browser automation.
- One Quick Edit session at a time — switching files with unsaved changes
  goes through the discard prompt rather than tabs.
- No force-overwrite: after a conflict the safe resolutions are
  Reload / Compare / keep editing — by design.
- Unix `stop` kills only the direct child — Windows is the target.

## Deferred

- Multi-file edit tabs / project-wide search (Milestone 04+).
- LSP/autocomplete, formatters, permanent file history.
- Non-React frameworks, production-build instrumentation.
- GUI-level automation of the Tauri shell (WebView2 driver).

## Next Milestone
Milestone 04 — deeper project navigation, component relationships, styling
intelligence, and productivity tooling.

## Last Updated
2026-09-15
