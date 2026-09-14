# RootRay

**Point at the UI. Reach the source.**

RootRay is a lightweight, local-first Windows developer tool that connects a
rendered web UI back to its editable source code. Open a local web project,
run it, inspect the UI, and jump from any visible element to the component,
file, and line that produced it — then open it in your editor of choice.

RootRay is not an IDE. It is the missing bridge between *what you see* and
*where it lives*.

## Current capability — Milestone 01 (Core Foundation)

- Select a local project directory through a Tauri desktop app
- Static project analysis: framework detection (React + Vite), package
  manager detection (pnpm / npm / yarn), dev-script resolution — all from
  real project files (`package.json`, lockfiles, `vite.config.*`)
- Managed dev-server lifecycle: start / stop / restart through narrow
  native commands — no arbitrary shell access
- Live stdout/stderr streaming into the desktop UI
- Automatic loopback URL detection (`http://localhost:5173/`,
  `127.0.0.1`, `[::1]`, alternate ports; remote URLs are rejected)
- Explicit runtime state machine: `idle → analyzing → ready → starting →
  running → stopping → stopped / failed`
- Editor detection: VS Code, Cursor, Windsurf (PATH + known install dirs)
- Local settings: recent projects, preferred editor, auto-open browser
- Filesystem boundary enforcement: no operation escapes the selected root
- Fixture projects + Rust & TypeScript test suites

## Prerequisites

- Windows 10/11 with **WebView2 Runtime** (preinstalled on most Windows 11)
- **Rust** (stable, MSVC toolchain) + **Visual Studio Build Tools** (C++
  workload — provides the linker)
- **Node.js** ≥ 20 and **pnpm** ≥ 9

## Install

```sh
pnpm install
```

## Run the desktop app (development)

```sh
pnpm dev:tauri
```

This starts the Vite dev server for the frontend and launches the Tauri
shell. Build a production bundle with:

```sh
pnpm build:tauri
```

## Tests

```sh
pnpm test            # Vitest (shared + desktop packages)
pnpm test:rust       # cargo test -p rootray-core
pnpm typecheck       # tsc --noEmit across the workspace
pnpm lint            # biome check .
```

## Supported projects (Milestone 01)

- **Framework:** React + Vite (plain Vite detected but not
  inspector-compatible yet)
- **Package managers:** pnpm, npm, yarn — detected via lockfiles or the
  `packageManager` field. Ambiguous or missing signals are reported, not
  guessed.
- A `"dev"` script must exist in `package.json`.

## Architecture

```
crates/rootray-core   Pure native core: detection, adapters, process
                      lifecycle, URL parsing, launchers, settings, fs
                      boundaries. No Tauri dependency → fully testable.
apps/desktop          React + TS frontend (Vite) and src-tauri thin
                      command layer. The UI can only call narrow commands.
packages/shared       Shared TS types + pure utils (loopback validation).
fixtures/             Real minimal projects used by tests and manual runs.
```

## Security model

- No generic `execute(command)` API — the frontend reaches only explicit
  commands: `analyze_project`, `start_dev_server`, `stop_dev_server`,
  `restart_dev_server`, `get_runtime_state`, `open_browser`,
  `detect_editors`, `open_in_editor`, `get_settings`, `update_settings`.
- Dev commands are derived from inspected `package.json` metadata and run
  as executable + argv — never shell strings.
- Project paths are canonicalized; anything escaping the selected root is
  rejected (`PROJECT_OUTSIDE_ALLOWED_ROOT`).
- `.env` files are never read; secrets are never logged.
- Child processes are killed as a tree (`taskkill /T /F`) — no orphan
  dev servers.

## Known limitations (Milestone 01)

- No click-to-source inspector yet (Milestone 02).
- Only React + Vite is supported.
- On non-Windows platforms process-tree kill uses `kill` on the direct
  child only; Windows is the supported target.
- Bun is not yet detected (adapter design allows adding it).
