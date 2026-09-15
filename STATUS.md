# RootRay Status

## Overall Progress
100%

## Current Milestone
Milestone 05 — Release Hardening, Windows Packaging & MVP Final Acceptance

## Milestone Status
Complete

## Release Status
MVP READY

## Release Version
RootRay **0.1.0** — consistent across root `package.json`, all
`packages/*`, `apps/desktop/package.json`, `tauri.conf.json`, and both
`Cargo.toml` manifests. No tag or public GitHub Release has been created;
publishing `v0.1.0` is a human decision.

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
- **No LICENSE selected yet** — owner decision required.
- **No public `v0.1.0` tag, no GitHub Release yet** — publish is a human
  decision; everything needed is verified and packaged.
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
2026-09-15
