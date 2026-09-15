# RootRay Status

## Overall Progress
40%

## Current Milestone
Milestone 02 — Inspector Engine

## Milestone Status
Complete

## Implemented

Everything from Milestone 01 (detection, lifecycle, logs, editors, fs
boundaries — all preserved and passing), plus:

- **Versioned source protocol** (`packages/source-protocol`) —
  `ROOTRAY_PROTOCOL_VERSION = 1`, typed messages in both directions
  (`runtime:hello`/`ready`, `inspect:set`, `element:selected`,
  `session:accepted`/`rejected`), field-by-field validation at the trust
  boundary, project-relative path safety (`..`, absolute paths, drive
  letters rejected). Mirrored in Rust (`inspector/protocol.rs`).
- **Authenticated loopback bridge** (`crates/rootray-core/src/inspector`)
  — tungstenite WebSocket on `127.0.0.1` with a dynamically assigned port,
  32-byte per-session random token (never persisted), hello-auth →
  accepted/rejected handshake, malformed/unknown/mis-versioned messages
  dropped, reconnect tolerated, clean shutdown on session end.
- **Inspector session model** — `inactive / starting / waiting_for_browser
  / connected / inspecting / disconnected / failed` with session id, port,
  page URL, last selection, error; pushed to the frontend as
  `rootray://inspector-state` snapshots.
- **Vite instrumentation** (`packages/vite-plugin`) — dev-only Babel
  transform stamping `data-rootray-file/line/column/component` on
  intrinsic JSX elements (`.jsx`, `.tsx`, JSX-in-`.js`); skips
  node_modules/generated/virtual modules; never duplicates attributes;
  nearest owning component inferred for function/arrow/class components;
  source maps preserved; production builds untouched.
- **Inspector runner** — Node entry point resolving the project's *own*
  Vite via `createRequire`, loading the project's config normally, merging
  RootRay's plugin, supporting `vite` + safe flags; `printUrls()` keeps
  the Milestone 01 URL detector working unchanged.
- **Browser inspector runtime** (`packages/inspector-runtime`) — ~9.2 KB
  framework-free client: WS auth, bounded reconnect, Shadow-DOM overlay
  (`position: fixed`, `pointer-events: none`, max z-index), hover label
  `ComponentName src/file.tsx:line`, capture-phase click suppression,
  Escape to exit inspect mode, full teardown on destroy.
- **Desktop Inspector UI** — Inspector section in the running view:
  bridge/connection status, Inspect/Stop-Inspecting toggle, selected
  element card (tag, component, file, line, column), read-only ~13-line
  source preview with the selected line highlighted, **Open Source**
  launching VS Code/Cursor/Windsurf at the exact line:column.
- **Rust preview + editor-at-location** — `filesystem/preview.rs`
  (canonicalized, root-bounded, `.env`-rejected, size-capped text read)
  and launcher argument arrays for `file:line:column`.
- **Fixture** — `fixtures/vite-react-inspector`: multi-file React app
  (App, Navbar, Card, ActionButton, input, links, SVG) for cross-file
  resolution.
- **CI** — `.github/workflows/ci.yml` on windows-latest: install, lint,
  typecheck, package builds, Vitest, Playwright E2E, `cargo test`,
  `cargo check`, frontend prod build. Verified green on the milestone
  head commit.

## Architecture

Browser DOM metadata (`data-rootray-*`, relative paths only) → browser
runtime → WS+token → Rust bridge validation → `AppCore` → Tauri events →
React panel. Browser messages are data only — they can never spawn
processes, write files, or open editors. Privileged actions (preview,
editor launch) are explicit commands re-validated against the project
root. See `docs/architecture.md` and `README.md`.

## Verification

### Automated
- `cargo test -p rootray-core`: **82 passed, 0 failed, 1 ignored**
  (adds inspector bridge auth/protocol/path tests + preview + launch).
- `cargo test -p rootray-core --test suite -- --ignored`: golden path
  real-Vite-server test — **passed**.
- `pnpm -r test` (Vitest): **65 passed** — shared 7, source-protocol 14,
  inspector-runtime 14, vite-plugin 19, desktop 11.
- `pnpm --filter @rootray/e2e test` (Playwright, real Chromium): **3
  passed** — runtime injection + bridge auth/ready; hover overlay +
  click → real `src/components/ActionButton.tsx` line/column selection +
  click suppression + project-integrity digest; HMR edit stays live +
  instrumented.
- `pnpm -r typecheck` (tsc strict, `exactOptionalPropertyTypes`): clean.
- `pnpm exec biome check .`: clean (0 errors, 0 warnings).
- `cargo check -p rootray-core` / `-p rootray-desktop`: clean.
- `pnpm --filter @rootray/desktop build`: clean — 241 KB JS / 9.6 KB CSS.
- Project-integrity: SHA-256 digest of all project-owned files identical
  before/after an inspect session — proven inside the E2E.

### Manual / Live
- Real React/Vite fixture served through the RootRay runner in a real
  browser: runtime injected, authenticated to the bridge, hover
  highlighted the button, selection reported the true file/line/column,
  inspected click suppressed, normal behavior restored, HMR edits
  re-rendered instrumented. (Automated via Playwright — the Tauri GUI
  itself was not click-driven in this environment.)

## Known Issues

- Smart App Control may still flag fresh unsigned binaries (environmental).
- Inspector unavailable for dev scripts beyond `vite` + supported flags —
  falls back to the plain runner rather than touching the project.
- Playwright E2E uses a protocol-faithful mock bridge; the Rust bridge is
  covered by its own test suite, not browser automation.
- Unix `stop` kills only the direct child — Windows is the target.

## Deferred

- In-app source editing (CodeMirror/Monaco intentionally avoided).
- Non-React frameworks, production-build instrumentation.
- GUI-level automation of the Tauri shell (WebView2 driver).

## Next Milestone
Milestone 03 — Source editing / deeper inspector features (TBD by user).

## Last Updated
2026-09-15
