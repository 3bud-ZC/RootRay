# RootRay Status

## Overall Progress
20%

## Current Milestone
Milestone 01 — Core Foundation

## Milestone Status
Complete

## Implemented

- **Tauri 2 desktop shell** — `apps/desktop` (React 19 + TypeScript strict +
  Vite 7) with `src-tauri` thin command layer. Builds (`cargo check` +
  `cargo build`, debug and release) on Windows/MSVC.
- **Project detection** (`crates/rootray-core/src/project`) — real-file
  analysis of `package.json`, lockfiles, `vite.config.*`; adapter-based
  (`ProjectAdapter` trait + `ViteAdapter`); package-manager detection for
  pnpm/npm/yarn via lockfiles and `packageManager` field, with ambiguity
  reporting; dev-script resolution into `DevCommand` (executable + argv).
- **Managed dev-server lifecycle** (`process/`) — spawn through `cmd` shim
  resolution on Windows, piped stdout/stderr streamed line-by-line,
  `taskkill /T /F` tree-kill, duplicate-start rejection, clean-vs-crash
  exit classification, URL watchdog with configurable timeout,
  generation-guarded events.
- **Runtime state machine** (`state/`) — `idle / analyzing / ready /
  starting / running / stopping / stopped / failed`, legal-transition
  table, metadata (project, pid, command, url, port, startedAt, error),
  bounded 500-line log tail.
- **Loopback URL detection** (`process/url_detect.rs`) — ANSI-aware,
  parses real Vite output, accepts only `localhost`/`*.localhost`/
  `127.0.0.0/8`/`[::1]`/`0.0.0.0`, rejects remote URLs.
- **Editor detection** (`launcher/`) — registry-driven; detects VS Code,
  Cursor, Windsurf via known install dirs + PATH; opens the project root.
- **Settings** (`settings/`) — JSON file under app-config dir: recent
  projects (deduped, capped at 10), preferred launcher, auto-open-browser.
  Corrupt file → backed up + defaults.
- **Filesystem boundaries** (`filesystem/`) — canonicalization, `../`
  traversal rejection, absolute-outside-root rejection, symlink escape
  rejection, lexical validation for not-yet-existing paths.
- **Desktop UI** — compact dark dev-tool: home + recents, project facts
  (framework/PM/dev-command/compatibility), unsupported-reasons view,
  running panel (URL chip, PID, elapsed, Open Browser/Restart/Stop),
  live log panel, settings drawer.
- **Fixtures** — `vite-react-basic` (npm), `vite-react-typescript` (pnpm),
  `unsupported-project` (yarn, express).

## Architecture

`rootray-core` holds every piece of logic with zero Tauri deps; the
`src-tauri` crate only maps commands + forwards events. Frontend subscribes
to `rootray://process-event` / `rootray://state`. See `docs/architecture.md`.

## Verification

### Automated
- `cargo test -p rootray-core`: **63 tests pass** (61 integration in
  `tests/suite.rs` + 2 unit), covering detection, PM ambiguity, malformed
  inputs, URL parsing, state transitions, fs boundaries, settings,
  launcher registry, and full process lifecycle via a fixture binary.
- `pnpm test` (Vitest): **18 tests pass** (shared url validation + desktop
  reducer/format).
- `pnpm typecheck` (tsc strict): clean.
- `pnpm lint` (biome): clean.
- `cargo check -p rootray-desktop` + `cargo build -p rootray-desktop`
  (debug **and** `--release`): clean (MSVC toolchain).
- `pnpm build` (frontend prod bundle): clean — 237 KB JS / 7 KB CSS.
- Golden-path integration test (`golden_path_real_vite_server`, runs with
  `--ignored`): analyzes the real fixture, starts real `npm run dev`
  (Vite), detects the real `http://localhost:5173/` URL from stdout,
  stops and restarts the process — **verified green**.

### Manual / Live
- `rootray-desktop.exe` (debug) launched and stays resident — Tauri shell
  process verified running on Windows. GUI interaction was not
  click-verified in this environment.
- `cmd /c npm.cmd run dev` on the fixture verified to emit real Vite
  `Local: http://localhost:5173/` output.
- Editor detection verified: VS Code is installed on this machine and is
  detected as `available` (covered by registry-structure test + real
  machine state).

## Known Issues

- **Smart App Control intermittently blocks freshly-built unsigned
  binaries** on this machine (os error 4551). Mitigated by retry/rebuild;
  occasionally a given artifact hash is permanently flagged and requires
  a content change to clear. This is an environment limitation, not a
  code defect — signed CI builds are unaffected.
- Unix `stop` uses `kill` on the direct child only (no process-group
  kill) — Windows is the supported target; noted for portability.
- `tauri build` bundling (NSIS installer) not exercised — the release
  binary itself builds.

## Deferred

- Click-to-source inspector, element instrumentation — Milestone 02.
- Bun detection, Next.js/Vue/Svelte/Astro adapters.
- `packages/source-protocol`, `packages/project-adapters` — intentionally
  not created; the adapter contract lives in `rootray-core` and there was
  no TS-side responsibility for them yet (per "no packages without a
  clear responsibility").
- Playwright e2e — deferred; no real value until the inspector UI exists.

## Next Milestone
Milestone 02 — Inspector Engine

## Last Updated
2026-09-15
