# RootRay

**Point at the UI. Reach the source.**

RootRay is a lightweight, local-first Windows developer tool that connects a
rendered web UI back to its editable source code. Open a local React/Vite
project, run it, point at any element on the page, and RootRay shows you the
exact file, line, and component that produced it — plus its styles, its
usages, and a safe in-place editor when you just need a quick fix.

RootRay is not an IDE. It is the missing bridge between *what you see* and
*where it lives*. Bigger changes belong in your real editor — RootRay opens
VS Code, Cursor, or Windsurf at the exact location.

- **Status:** `0.1.0` — MVP release for Windows 10/11 x64
- **License:** MIT — see [LICENSE](LICENSE)

## What RootRay does

```
Open Project → Run → Inspect UI → point at an element
  → source file:line:col
  → owning component + definition + usages
  → classes, box model, computed styles, matched CSS rules
  → Quick Edit → safe save → Vite HMR → inspect again
```

- **Inspect Mode** — hover highlights elements and shows
  `ComponentName  src/file.tsx:line`; click to select. `Escape` cancels.
- **Component intelligence** — static analysis (Babel parse, never executed)
  resolves the owning component, its definition site, and every resolved
  caller. Unresolvable relationships are labeled, never guessed.
- **Style intelligence** — class tokens, box model, curated computed styles,
  and matched CSSOM rules mapped back to real project stylesheets.
- **Project Explorer** — lazy file tree, navigation-only (Quick Edit,
  Open External, Copy Path). No delete/rename/move.
- **Quick Open (`Ctrl+P`)** and **Workspace Search (`Ctrl+Shift+F`)** —
  bounded, keyboard-first, both land in the same guarded Quick Edit session.
- **Quick Edit** — CodeMirror 6, `Ctrl+S` saves with SHA-256 optimistic
  concurrency + atomic writes; external changes raise a conflict banner
  instead of clobbering either side.
- **Copy Context** — a ≤4 KB block describing the selected element for
  pasting into issues or chat. Relative paths only.

## Install (Windows)

1. Download `RootRay_0.1.0_x64-setup.exe` and its `.sha256` file.
2. Verify the checksum (optional but recommended):

   ```powershell
   Get-FileHash .\RootRay_0.1.0_x64-setup.exe
   # compare with the hash inside the .sha256 file
   ```

3. Run the installer. It installs per-user to
   `%LOCALAPPDATA%\RootRay` — no admin required.
4. Launch **RootRay** from the Start Menu.

**Unsigned build:** this MVP is not code-signed. Windows SmartScreen or
Smart App Control may warn on first launch — choose *More info → Run
anyway* if you trust the source. Signing is planned post-MVP.

**WebView2:** required. It is preinstalled on most Windows 11 and recent
Windows 10. If missing, the installer downloads Microsoft's official
bootstrapper automatically.

## Using RootRay

1. **Open Project** — pick a folder containing a React/Vite project.
   RootRay detects the framework, package manager (pnpm/npm/yarn via
   lockfile or `packageManager` field), and `dev` script.
2. **Run Project** — launches your own Vite dev server through a Node
   runner that injects a development-only instrumentation plugin.
   Your `vite.config.*`, `package.json`, and sources are never modified.
   Live server logs stream into the Runner panel.
3. **Open the printed localhost URL** — your app loads with a
   `data-rootray-*` instrumented DOM and the inspector runtime connected.
4. **Enable Inspect Mode** and point at the UI.
5. **Quick Edit** or **Open Source** at the exact location.
6. **Save** — Vite's own watcher hot-reloads; instrumentation survives
   HMR. Inspect again.

RootRay never starts a dev server on its own — not on launch, not on
project restore. You press Run.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+P` | Quick Open — fuzzy file navigation |
| `Ctrl+Shift+F` | Workspace Search |
| `Ctrl+S` | Quick Edit — save (hash-checked, atomic) |
| `Ctrl+F` | Quick Edit — find in current file |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Quick Edit — undo / redo |
| `Escape` | Cancel Inspect Mode / close palettes |

All views, palettes, the explorer tree, and editor controls are fully
keyboard reachable; focus is always visible.

## Supported projects

- **Framework:** React + Vite (JSX/TSX, including JSX in `.js`)
- **Package managers:** pnpm, npm, yarn
- A `"dev"` script must exist; inspector launch handles `vite` plus simple
  flags (`--host`, `--port`, `--strictPort`, `--mode`, `--force`,
  `--clearScreen`, `--root`). Anything else runs without the inspector and
  says so.
- Unsupported projects (plain Node, Next.js, broken `package.json`,
  missing `dev` script, Vite without React) are detected and reported —
  never silently modified or converted.

**Runtime requirements for inspected projects:** the project's own Node.js
and package manager must be on `PATH` (you need them to run `pnpm dev`
yourself anyway). RootRay itself needs no global Node/Rust to run.

## External editors

RootRay detects VS Code, Cursor, and Windsurf and can open them at an
exact file:line:column. Pick your preferred editor in **Settings**. A
missing/uninstalled editor is reported, never a crash.

## Security & privacy

RootRay is **local-first**:

- No account, no cloud backend, no telemetry, no AI provider. Your source
  never leaves the machine — the only network listener RootRay opens is a
  `ws://127.0.0.1` loopback bridge on a dynamic port with an ephemeral
  per-session token.
- No generic command API. The UI can only call a narrow set of audited
  Tauri commands; browser messages are data only and cannot spawn
  processes, write files, or open editors.
- Filesystem access is project-relative only: absolute paths, `..`
  traversal, symlinks escaping the root, `.env*`, keys, credentials,
  `.git`, `node_modules`, `target`, `dist`, and non-text/oversized files
  are all refused.
- Saves use SHA-256 optimistic concurrency and same-directory atomic
  rename; an external edit is never silently overwritten.
- Your dev server runs inside a Windows Job Object
  (`KILL_ON_JOB_CLOSE`): if RootRay dies unexpectedly, the server and its
  descendants are terminated — no orphaned processes.
- Copy Diagnostics produces a bounded, secret-free report (version, OS,
  component states, error codes) — never tokens, paths, or source.

RootRay does *not* claim zero network activity: your own dev server,
package managers, and the app you are developing may access the network
normally — RootRay doesn't intercept or proxy any of it.

## Troubleshooting

| Problem | What to try |
|---|---|
| SmartScreen / Smart App Control warning | Expected — the MVP is unsigned. *More info → Run anyway*. |
| Blank window / "WebView2 missing" | Install [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (the installer normally does this automatically). |
| "unsupported project" | RootRay supports React + Vite only. Next.js, plain Node, and other frameworks are detected and refused. |
| "no dev script" | Add a `"dev": "vite"` script to `package.json`. |
| "dependencies appear to be missing" | Run your package manager's install (`pnpm install` / `npm install` / `yarn`) in the project, then Run again. RootRay never installs for you. |
| Dev server exits immediately | Check the Runner panel log — the project's own output is shown verbatim. Common causes: missing deps, port in use, unsupported dev command flags. |
| Browser didn't connect / inspector unavailable | Open the exact `localhost` URL RootRay printed (a different port or `127.0.0.1` vs `localhost` mix won't reach the bridge). Re-run with a plain `vite` dev script if yours uses unusual flags. |
| HMR error overlay after a bad save | Fix the syntax error and save again — Vite recovers on the next write. Rarely, a full browser reload is needed. |
| "file changed outside RootRay" | Someone (or your editor) wrote the file while you had unsaved edits. Choose Reload Disk Version, Compare, or keep editing — nothing is silently lost. |
| "editor not available" | The selected launcher isn't on PATH anymore. Pick another in Settings, or re-install it. |
| Source location missing on an element | Only intrinsic DOM elements carry metadata; custom components resolve through their rendered children. Deeply dynamic/portal UI may show the nearest instrumented ancestor. |

Copy Diagnostics (Settings → Diagnostics, or the crash screen) produces a
bounded report you can paste into an issue.

## Development

### Prerequisites

- Windows 10/11, Rust stable (MSVC) + Visual Studio Build Tools (C++
  workload), Node.js ≥ 20, pnpm ≥ 9
- E2E: `pnpm --filter @rootray/e2e exec playwright install chromium`

### Setup and run

```sh
pnpm install
pnpm -r --if-present build   # inspector runtime + plugin bundles
pnpm dev:tauri               # dev build of the desktop app
```

### Test

```sh
pnpm test            # Vitest suites + Playwright E2E
pnpm test:rust       # cargo test -p rootray-core
pnpm typecheck
pnpm lint
```

### Release build (unsigned)

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present build
pnpm build:tauri
```

Outputs:

- `target/release/rootray-desktop.exe`
- `target/release/bundle/nsis/RootRay_<version>_x64-setup.exe`

Then verify with the installer smoke test:

```powershell
pwsh -File scripts/installer-smoke.ps1
```

It installs silently (current user), verifies files + bundled resources,
launches the app, confirms no dev server auto-starts, terminates, and
uninstalls — printing `INSTALLER SMOKE: PASS` at the end.

## Architecture

```
crates/rootray-core        Native core: detection, process lifecycle
                           (Windows Job Object containment), inspector
                           bridge/session, source preview, safe edit
                           sessions (hash-checked atomic writes, watcher),
                           lazy nav + bounded search + source collection.
apps/desktop               React 19 UI + thin src-tauri command layer;
                           lazy-loaded CodeMirror + intelligence chunks.
packages/source-protocol   Versioned wire contract (validated both ways).
packages/inspector-runtime Browser client: WS auth/reconnect, Shadow-DOM
                           overlay, hover/select, on-select style details.
packages/vite-plugin       Babel JSX/TSX instrumentation + dev-server
                           runner merged into the project's own Vite.
packages/intelligence      Bounded static React analysis (Babel).
fixtures/                  Real React/Vite test projects.
tests/e2e                  Playwright: golden-path, edit, a11y.
scripts/installer-smoke.ps1  Repeatable install/launch/uninstall test.
```

### Data flow

```
Vite transform stamps data-rootray-* on JSX ──▶ rendered DOM
hover/click ─▶ runtime reads metadata ─▶ WS + token ─▶ Rust bridge
validates ─▶ desktop resolves file:line ─▶ Quick Edit / Open Source

save ─▶ SHA-256 check ─▶ temp-file + rename ─▶ Vite watcher ─▶ HMR
```

## Known limitations

- React + Vite only; only intrinsic (lowercase DOM) elements carry
  metadata — a custom component's position comes from its rendered DOM.
- Static analysis resolves common import shapes — aliased paths (`@/…`),
  barrel cycles, `React.lazy`, and re-export chains deeper than one
  unambiguous `index` hop report *unresolved*, never a guess.
- Matched CSS rules link to the stylesheet file, not the selector's line.
- One Quick Edit session at a time; switching files with unsaved changes
  prompts to discard.
- The installer and executable are unsigned (SmartScreen warning).
- Windows is the only supported target.

See [STATUS.md](STATUS.md) for the factual milestone/release state.

## License

RootRay is open-source software released under the MIT License.

Copyright (c) 2026 Abdallah — ABUD FUN.

See [LICENSE](LICENSE).
