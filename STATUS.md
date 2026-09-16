# RootRay Status

## Current Development
**v0.2.0-dev** — Universal Project Workspace

**Milestone:** 02 — Next.js Runtime & Visual Source Inspection
**Progress:** 40% of the v0.2.0 track

### Milestone 02 — Next.js Runtime & Visual Source Inspection

- **Inspector adapter abstraction** — `InspectorAdapter::for_framework`
  dispatches per-framework launch/instrumentation: `ViteReact` (unchanged
  runner path) and `NextJs` (new). Unsupported frameworks get honest
  capability states, never a dead-end.
- **`@rootray/jsx-instrument`** — the Babel JSX/TSX stamping logic
  extracted from vite-plugin into a shared package; both adapters use it.
- **`@rootray/next-adapter`** — `next-shim.cjs` is loaded into the
  `next dev` process via `node --require` (argv form — no NODE_OPTIONS
  whitespace issues, scoped to the bundler process). It hooks
  `Module._load` so every importer of `next/dist/server/config.js`
  receives a wrapped `loadConfig` that merges RootRay's loader into
  `turbopack.rules` and wraps `config.webpack` for the `--webpack` path.
  The loader emits directive-aware code (injected entry import lands
  *after* `"use client"`) and a relative import to a session entry written
  under `node_modules/.cache/rootray-<sid>/` — inside the Turbopack root,
  outside volatile `.next/`, removed on session end (stale dirs swept on
  next launch; only `rootray-*` names are ever removed).
- **React 19** — `_debugSource` is gone; `_debugOwner`/`_debugStack`
  exist in dev builds. The runtime treats them as a bounded, failure-
  silent *hint layer* (`fiber.ts`) that can enrich a selection's
  `componentName` when instrumentation did not carry one. Location always
  comes from stamped DOM attributes; `source.confidence` ("exact" |
  "approximate" | "component") is now part of the wire protocol.
- **Coverage proven** — Next 16.3.5 Turbopack: App Router page/layout/
  server+client components, Pages Router `/legacy`, CSS Modules,
  Tailwind v4, repeated siblings (each keeps its own JSX site), client-
  side navigation, hard navigation re-authentication, Fast Refresh after
  Quick Edit save. Next 16 `--webpack` and Next 15.5.12 webpack:
  instrumented render + bridge handshake.
- **Capabilities** — Next.js targets report dom-inspect/style-inspect/
  source-mapping/hmr **available** when the dev script is safely
  reconstructable (`next dev` + plain flags); component-intelligence is
  **partial** (server-component ownership is static). Complex/wrapped
  scripts still run — inspection reports the reason instead.
- **Installed-app verification — PASS**
  (`tests/e2e/installed-golden-next.mjs`, real `rootray-desktop.exe`):
  analyze → `Next.js 16.2.12 · npm · npm run dev` → Run → real
  `next dev` (Turbopack) → `http://localhost:3000/` → bridge connected →
  Inspect UI → select → `components/ActionButton.tsx` L9 C5,
  `ActionButton` → component + style intelligence → Quick Edit → Saved →
  Fast Refresh applied in the page → re-inspection resolves the same
  source → About-link navigation stays instrumented → Stop → owned
  process tree exited, URL dead. Vite installed golden path re-run: PASS.

### What changed (v0.2.0, Milestone 01)

- **Universal workspace model** — `crates/rootray-core/src/project/workspace/`
  replaces the single-project `supported: bool` analysis with an
  authoritative `WorkspaceAnalysis`: workspace kind, package manager,
  manifests, technologies, targets, capability matrix, findings, warnings
  and real discovery metrics.
- **Three roots kept distinct** — `workspace.root` (selected directory =
  workspace root = filesystem security root), `target.absoluteRoot`
  (nested package the runtime acts on), and the unchanged security
  boundary all filesystem features enforce.
- **Bounded discovery** — depth ≤ 4, ≤ 400 dirs, ≤ 64 manifests, ≤ 256 KB
  metadata; generated dirs (`node_modules`, `.git`, `dist`, `build`,
  `.next`, `.turbo`, `target`, `coverage`, `out`, `playwright-report`,
  `test-results`, `.e2e-work`, caches) are never entered; nothing is
  executed; secret files are never read.
- **Capability engine** — per-target `CapabilityMatrix` with
  available / partial / unavailable(+reason) / not-applicable states for
  browse, search, quick-open, quick-edit, safe-write, open-external, run,
  browser-open, dom-inspect, style-inspect, source-mapping,
  component-intelligence and HMR awareness. The global "Unsupported"
  dead-end is gone.
- **Detection** — Next.js (with declared version), React+Vite, Vite
  (non-React), static web (`index.html`), Node web (Express/NestJS…),
  Node CLI tools, libraries; pnpm/npm/yarn workspaces, Turborepo,
  package-manager inheritance, runner candidates (`dev` > `serve` >
  `start`, argv-only `pm run <script>`).
- **Active target** — `set_active_target` Tauri command; a single
  unambiguous web-app target is auto-selected, a `<select>` appears when
  multiple targets exist; run cwd is the target root while Explorer/Search
  stay workspace-rooted.
- **UI** — ProjectView shows workspace kind, target selector, framework +
  version, technology chips, grouped capability rows with reasons, and no
  global dead-end.
- **New error codes** — `WORKSPACE_TARGET_NOT_FOUND`,
  `TARGET_RUNNER_UNAVAILABLE`.

### Real-repository read-only validation (measured, not claimed)

| Repository | Result |
|---|---|
| ClientFlow-CRM | Next.js 16.2.12 · npm · `npm run dev` · all runtime caps available · 24ms · **live shimmed `next dev` → `/login` SSR carries `data-rootray-*` on real sources** |
| ELHABAK-Construction-System-V1 | pnpm workspace · 8 targets · `apps/web` Next.js 16.0.3 auto-selected, runtime caps available · `apps/api` Node server · libs classified · 71ms |
| workfolw (video-factory-monorepo) | pnpm workspace · Next.js 15.1.7 web target · 104ms |
| Shadow Runner | Vite 6.2.0 (non-React, Phaser) · run available · 26ms |
| Egyptian-Russian-University-master | nested manifest discovered → React+Vite 5.1.0 · 15ms |
| natega (bsnu-result-portal) | React+Vite 8.2.0 · npm · 17ms |
| camera (gesturefx) | React+Vite 8.1.1 · npm · 14ms |
| short (abud-shorts-engine-v2) | pnpm workspace · truncated at 400-dir cap (real bound) · 214ms |
| PoseMeme | no manifests → usable workspace, 0 targets · <1ms |

### Deferred to later milestones

- Milestone 03 — Generic Browser Runtime, Static Web & Non-React
  Inspection.
- Built-in static server for `index.html`-only projects.
- Vue/Svelte/Astro/Nuxt/Angular runtime adapters.

### v0.2.0 verification

- `cargo test -p rootray-core` — 163 passed, 0 failed, 1 ignored
  (`golden_path_real_vite_server` — real `npm run dev` run, passes with
  `--ignored`).
- `pnpm -r test` — Vitest 133 green (shared 7, source-protocol 14,
  intelligence 17, jsx-instrument 19, vite-plugin 3, inspector-runtime
  16, next-adapter 5, desktop 52).
- `pnpm --filter @rootray/e2e test` — Playwright 31 e2e green (22 prior
  + 9 Next: turbopack full flow 7, webpack 16+15 fallback 2).
- `pnpm -r typecheck`, `pnpm exec biome check .`, `cargo check` (both
  crates), `cargo build -p rootray-desktop` — green.
- `pnpm build:tauri` — release build + NSIS bundle green;
  `scripts/installer-smoke.ps1` — PASS (all five inspector assets ship).
- **Installed-app golden paths — PASS** (`installed-golden.mjs` Vite,
  `installed-golden-next.mjs` Next.js — both drive the real installed
  `rootray-desktop.exe` via WebView2 CDP + a controlled Chromium page).
- Real-repo validation: `ClientFlow-CRM` live shimmed `next dev` renders
  `data-rootray-*` on real SSR output (`/login`, 200);
  `ELHABAK-Construction-System-V1` monorepo → 8 targets, `apps/web`
  Next.js 16.0.3 auto-selected with runtime caps available.

---

## Release History (published — do not alter)

## Overall Progress (v0.1.x)
100% — MVP complete

## Milestone 05
Release Hardening, Windows Packaging & MVP Final Acceptance — **Complete**

## Release Status
MVP READY — **v0.1.1 published**

- Published patch: `v0.1.1` —
  https://github.com/3bud-ZC/RootRay/releases/tag/v0.1.1
- Tag: `v0.1.1` → `7fba49a43321f1c2cb167bdaf32edf0ad3097040`
  (annotated, immutable)
- Release workflow: run `35039871780` (tag push, `v0.1.1`) — **success**
- Actions artifact: `rootray-v0.1.1-windows-x64`
- Installer: `RootRay_0.1.1_x64-setup.exe` — `2,570,550 bytes`
- SHA-256: `6660d62b9bfd576c47e3800ab558d660378cbf987a774af04ba1c25fe19f919c`
- Checksum manifest: `RootRay_0.1.1_x64-setup.exe.sha256` (verified
  matching)
- Prior release: `v0.1.0` —
  https://github.com/3bud-ZC/RootRay/releases/tag/v0.1.0
- Tag: `v0.1.0` → `62d05f23b05c063aa6f1a93c4d2f1c8971c34302` (annotated,
  immutable)
- License: **MIT**
- Copyright: `Copyright (c) 2026 Abdallah — ABUD FUN`

## Patch — v0.1.1 (published)

A release-blocking bug was found during first-user testing of the
published v0.1.0 build:

- **Bug:** `Open Project` → pick a valid React + Vite directory → picker
  closes → UI stays on "Open a project".
- **Root cause:** `AppCore::analyze` correctly updated the native
  `RuntimeState` (`analyzing` → `ready`, `project = Some(..)`), but the
  `analyze_project` Tauri command never emitted `rootray://state`, so the
  frontend kept seeing `runtime.project === null`. Same path affected
  `Change…` in ProjectView.
- **Fix:** `AppCore` gained a narrow `set_state_notify` hook (same
  pattern as the existing inspector/editor notifies); `analyze` fires it
  after its synchronous state mutation, and the Tauri shell wires it to
  emit `rootray://state` on both success and failure.
- **Regression tests:** Rust test proves the host notification fires on
  both success and failure with the correct phase/error state; Playwright
  tests prove the stubbed `analyze_project` emit drives HomeView →
  ProjectView and that `Change…` re-analysis updates the view.
- **Audit:** other synchronous state mutations checked — `stop_dev_server`
  state reaches the frontend through the process-event sink; no other
  command had the same missing-emission bug.
- **Installed-app verification: PASS** — the real `0.1.1` NSIS installer
  was installed and the exact reported flow exercised: Open Project →
  native picker → React + Vite fixture → picker closed → ProjectView
  with name, framework, package manager, and dev command.
- **CI:** run `35038504057` on `1beff63` — **success**.
- **Status:** published — `v0.1.0` history preserved below; `v0.1.1` tag
  and GitHub Release are live with the verified Actions artifact.

## Release Version
Working tree is **0.2.0-dev** — consistent across root `package.json`,
all `packages/*`, `apps/desktop/package.json`, `tauri.conf.json`, and both
`Cargo.toml` manifests. Latest published release: `v0.1.1` (above).

## Implemented (Milestone 05 additions)

Everything from Milestones 01–04, plus release hardening:

- **Windows Job Object containment** (`crates/rootray-core/src/process/job.rs`)
  — every spawned dev server is assigned to a RootRay-owned job with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Descendants join automatically;
  if RootRay dies unexpectedly, Windows terminates the whole tree. Graceful
  Stop/Restart paths are unchanged. Covered by a real-process integration
  test (`tests/suite/process_containment.rs`).
- **Session recovery** — the last project is re-analyzed on startup
  (read-only; the dev server is *never* auto-started). Settings persist
  recents, preferred editor, browser preference and `lastProject`; a
  deleted project produces a notice, not a crash.
- **React error boundary** (`components/ErrorBoundary.tsx`) — a render
  failure swaps to a compact recovery view (Reload Interface / Copy
  Diagnostics) instead of a blank window.
- **Copy Diagnostics** (`lib/diagnostics.ts` + `get_diagnostics` command)
  — bounded (≤3 KB) report: version, OS/arch, project basename +
  framework/package manager, runner/inspector/editor phases, error codes.
  No tokens, env vars, source, logs or absolute paths.
- **Missing-dependency hint** — an unclean dev-server exit with no
  `node_modules` logs `run "<pm> install"` guidance; RootRay never
  installs silently.
- **Tauri production config** — `productName: RootRay`, identifier
  `dev.rootray.app`, NSIS target, currentUser install (no admin), real
  RootRay icons, publisher/category/description metadata, tight CSP,
  minimum window 820×560, `webviewInstallMode: downloadBootstrapper`
  (official Tauri v2 strategy — silent, skips when present).
- **Bundled inspector assets** — `runner.cjs`/`plugin.cjs`/`runtime.js`
  ship as Tauri resources under `inspector-assets/`; resolution order is
  per-file `ROOTRAY_*_PATH` env overrides → `ROOTRAY_INSPECTOR_ASSETS_DIR`
  (set by the shell to the bundle resource dir) → workspace `packages/`
  fallback for dev.
- **Capabilities trimmed** — `core:default` + `dialog:allow-open` only
  (unused message/ask/confirm permissions removed).
- **Installer smoke script** (`scripts/installer-smoke.ps1`) — silent
  install → file + resource verification → launch → confirms no dev
  server auto-starts → clean terminate → silent uninstall → binary-gone
  check. Prints `INSTALLER SMOKE: PASS`.
- **Release workflow** (`.github/workflows/release.yml`) — separate from
  CI; `workflow_dispatch` + `v*` tag triggers; full quality gate → Tauri
  bundle → SHA-256 manifest → installer smoke → artifact upload. Never
  creates a GitHub Release.
- **Accessibility** — visible `:focus-visible` ring, `prefers-reduced-motion`
  honored, palette focus styles; axe pass + keyboard-flow E2E
  (`tests/e2e/a11y.spec.ts`) covering axe serious/critical on both views,
  Ctrl+P / Ctrl+Shift+F flows, explorer keyboard navigation and malformed
  payload resilience.
- **Large-project caps test** — generated 8,300-file corpus proves file
  listing, workspace search and intel collection all truncate at their
  caps instead of walking unbounded.
- **README rewritten for end users** — install, usage, shortcuts,
  supported projects, security/privacy statement, troubleshooting table,
  unsigned-build disclosure.

## Architecture

Unchanged in shape (see `docs/architecture.md`): rootray-core holds all
logic with zero Tauri deps; the frontend receives events only. New in M5:
`process/job.rs` containment and `ROOTRAY_INSPECTOR_ASSETS_DIR`-based
asset resolution for packaged builds.

## Installer

- **Artifact:** `RootRay_0.1.0_x64-setup.exe` (NSIS, per-user install into
  `%LOCALAPPDATA%\RootRay` — no admin)
- **Authoritative remote artifact:** GitHub Actions artifact
  `rootray-main-windows-x64` — installer `2,569,430 bytes` (~2.45 MB),
  SHA-256 `01c9840003285c3d98e17077e39f402163d200042f0aba87a8640020a0e6a4ce`,
  matching manifest `RootRay_0.1.0_x64-setup.exe.sha256`.
- **Local build (dev machine):** `target/release/bundle/nsis/RootRay_0.1.0_x64-setup.exe`,
  2,569,034 bytes, SHA-256
  `f41becb1e4e9e3bec4847f49ac325b07bc768e9a840082715aeb9f715d314e4b` —
  differs from the remote artifact (different build machine/time); the
  Actions artifact is authoritative.
- **Unsigned** — SmartScreen/Smart App Control may warn; documented.

## Verification

### Automated (final counts)

- `cargo test -p rootray-core`: **129 passed, 0 failed, 1 ignored**
  (+5 vs M4: process containment, large-project caps).
- `cargo test -p rootray-core --test suite -- --ignored`: **golden path
  real-Vite-server test passed**.
- `pnpm -r test` (Vitest): **123 passed**.
- `pnpm --filter @rootray/e2e test` (Playwright, real Chromium): **17
  passed** (+6 a11y/keyboard/resilience spec vs M4).
- `pnpm -r typecheck`: clean. `pnpm exec biome check .`: clean.
- `cargo check -p rootray-core` / `-p rootray-desktop`: clean.
- `cargo build -p rootray-desktop`: clean (debug + release).
- `pnpm --filter @rootray/desktop build`: clean.

### Release Build

`pnpm build:tauri` → release `rootray-desktop.exe` (10,604,032 bytes,
10.1 MB, local measurement) + the NSIS installer above. The Release
workflow ran the identical command remotely.

### Installer Smoke Test

- **Local:** `scripts/installer-smoke.ps1` on the locally built artifact —
  silent install OK → exe + all three `inspector-assets` present → app
  launched and initialized (pid verified) → no dev server spawned on
  launch → clean terminate → silent uninstall → binary removed.
  `INSTALLER SMOKE: PASS`.
- **Remote:** the same script ran inside Release run #1 on
  `windows-latest` and passed.

### End-to-End Acceptance

Browser-driven golden path is covered by Playwright against real Vite:
inspect → source → component intelligence → style intelligence →
Quick Edit → safe save → HMR → re-inspect — plus palettes, explorer and
a11y flows against the production-built UI (Tauri internals stubbed for
the DOM-level pass only). Installed-app launch verified by the smoke
script both locally and in Actions. Driving every GUI step inside
WebView2 remains environment-limited (no WebView2 test driver).

### Security Audit

- **IPC/capabilities:** `core:default` + `dialog:allow-open`; commands are
  narrow and re-validate the canonical root on every call.
- **Bridge:** 127.0.0.1-only, dynamic port, ephemeral token; wrong
  token/session/version and malformed messages are rejected — all covered
  by `inspector_bridge` tests (still green).
- **Filesystem/editor:** traversal, `..\`, absolute, symlink escape,
  secrets, binary, oversized, encoding, hash-conflict, external-edit and
  read-only cases covered by `source_edit`/`project_nav` suites (green).
- **Process:** owned trees in a kill-on-close job; unrelated processes
  never touched; nothing killed by port.

### Dependency Audit

- `pnpm audit --prod`: **0 vulnerabilities**.
- `cargo audit` (474 crates): **0 vulnerabilities**; 7 warnings, all
  transitive/unreachable-in-product: `proc-macro-error` + `unic-*`
  unmaintained (build/proc-macro path via Tauri), `glib` iterator
  unsoundness (Linux-only Tauri dep, not called on Windows).
- Secret scan of tracked files: clean — no `.env`, keys, tokens,
  credentials, or machine paths committed.

### Performance (measured, local build)

- Frontend entry: **274 KB JS** (84 KB gzip) + 18 KB CSS — +3 KB vs the
  M4 baseline for diagnostics/boundary code.
- CodeMirror chunk: 321 KB lazy · intelligence/Babel chunk: 313 KB lazy —
  both still off the startup path.
- Inspector runtime payload: 12 KB; runner 5 KB; plugin bundle 601 KB
  (dev-time only).
- Release exe: 10.1 MB · installer: ~2.45 MB.
- 8,300-file synthetic project: listing/search/intel all capped and
  flag `truncated` in ~1 s.
- No startup scan, no idle watcher, no auto-run — by design and by test.

## Known Issues

- **Unsigned Windows binary** — SmartScreen/Smart App Control may warn
  (documented; signing deferred — no cert provided).
- ~~No LICENSE selected yet~~ — **resolved: MIT**, published with v0.1.0.
- ~~No public `v0.1.0` tag~~ — **resolved: published** at
  `github.com/3bud-ZC/RootRay/releases/tag/v0.1.0` with the verified
  Actions installer + checksum manifest attached.
- Playwright drives a protocol-faithful mock bridge plus a stubbed-IPC
  DOM pass; the Rust bridge itself is covered by the Rust suite.
- Vite occasionally needs a manual page reload after a broken-then-fixed
  module (E2E documents the fallback).
- Import aliases/deep barrels → `unresolved` by design; matched CSS rules
  navigate to the stylesheet file, not the selector line.
- One Quick Edit session at a time; Unix `stop` kills only the direct
  child (Windows is the target).
- `cargo audit` warnings listed above — unmaintained transitive crates,
  no reachable vuln; tracked upstream via Tauri.

## Deferred

- Code signing + auto-updater (needs cert + key infra — out of MVP scope).
- GUI-level WebView2 automation; multi-file tabs; selector-line CSS
  resolution; deeper import resolution; non-React frameworks.

## Release Artifacts

| Artifact | Location | Notes |
|---|---|---|
| Actions artifact | `rootray-main-windows-x64` (Release run #1) | authoritative |
| NSIS installer | `RootRay_0.1.0_x64-setup.exe` | 2,569,430 bytes |
| Checksum manifest | `RootRay_0.1.0_x64-setup.exe.sha256` | matches installer |
| Executable | `target/release/rootray-desktop.exe` | 10.1 MB, local |

## Remote Release Verification

- Workflow: `Release` (`.github/workflows/release.yml`)
- Trigger: `workflow_dispatch`
- Run: `#1` — Run ID `34982355585`
- Source branch: `main`
- Release source SHA: `eedfee2f0da19665d1089e30b82d76013e3e70c3`
- Conclusion: **success** — every step green: dependency install, lint,
  typecheck, workspace builds, Vitest, Playwright, Rust tests, Tauri
  release build, NSIS packaging, SHA-256 generation, installer smoke
  test, artifact upload.

### GitHub Actions Artifact

- Artifact: `rootray-main-windows-x64`
- Installer: `RootRay_0.1.0_x64-setup.exe` — `2,569,430 bytes`
- SHA-256: `01c9840003285c3d98e17077e39f402163d200042f0aba87a8640020a0e6a4ce`
- Checksum manifest: `RootRay_0.1.0_x64-setup.exe.sha256`
- Manifest checksum verified to match the installer.

## Release Source SHA
`eedfee2f0da19665d1089e30b82d76013e3e70c3` — the commit Release run #1
built the installer from.

## Final Repository SHA
See `git log` on `main` — the tip after this documentation-only commit.
It is newer than the release source SHA by documentation changes only;
the installer was NOT built from it.

## Last Updated
2026-09-16
