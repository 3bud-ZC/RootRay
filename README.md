# RootRay

**Point at the UI. Reach the source.**

RootRay is a lightweight, local-first Windows developer tool that connects a
rendered web UI back to its editable source code. Open a local web project,
run it, inspect the UI, and jump from any visible element to the component,
file, and line that produced it — then open it in your editor of choice.

RootRay is not an IDE. It is the missing bridge between *what you see* and
*where it lives*.

## Current capability — Milestone 04 (Project Intelligence & Styling)

Everything from Milestones 01–03, plus a project-wide intelligence and
navigation layer:

- **Project Explorer** — a lazy, project-root-bounded file tree.
  Directories load only when expanded (no recursive full-tree load),
  generated folders (`node_modules`, `dist`, `target`, `build`,
  `coverage`, `.e2e-work`, `playwright-report`, `test-results`, `.git`)
  are hidden, and secret-file rules still apply. Actions are
  navigation-only: Quick Edit, Open External, Copy Relative Path — no
  delete/rename/move. A small **Recent files** list (per project,
  capped at 10, paths only) sits on top.
- **Quick Open (`Ctrl+P`)** — fuzzy file/path palette over a lazily
  fetched, bounded project file list. Keyboard navigable, 50-result
  cap, ignored paths excluded; selection routes through the same safe
  Quick Edit session (dirty-editor guard included).
- **Workspace Search (`Ctrl+Shift+F`)** — bounded text search across
  source files (`.js/.jsx/.ts/.tsx/.css/.scss/.html/.json/.md`).
  Returns relative path + line + column + preview; skips secrets,
  binaries, generated dirs; enforces file/size/result caps; results
  navigate to the exact source location. A monotonic request id drops
  stale results so a slower earlier search can never clobber a newer
  one.
- **Component intelligence** — `Ctrl` is not required: selecting an
  element now shows its owning component, the definition site, and every
  resolved caller (`Used by src/…:line`), each clickable into Quick
  Edit. Analysis is static Babel parsing of `.js/.jsx/.ts/.tsx` sources
  collected through the bounded native layer — project code is never
  executed — and covers function / arrow / class components, named +
  default exports, and relative imports including unambiguous `index`
  re-exports. Unresolvable relationships are labeled, never guessed.
- **Style intelligence** — selection now carries the element's class
  tokens, a full box model (margin/border/padding/size), a curated set
  of computed styles, and the matched CSS rules discovered through
  CSSOM. Vite dev hints (`data-vite-dev-id`) map matched rules back to
  project-relative stylesheet paths, so `src/styles/button.css` opens
  in Quick Edit or externally. Cross-origin/inaccessible stylesheets
  are skipped safely; ambiguous selector locations are reported as
  unresolved, never fabricated. Style data is collected on click only —
  hover sends nothing extra.
- **Copy Context** — copies a bounded developer-context block for the
  selected element: component, source location, tag, classes, resolved
  callers, matched style sources, and a small source snippet. Relative
  paths only; capped at ~4 KB.
- **Invalidation-aware** — a RootRay save, a clean auto-reload, or a
  detected external change invalidates the cached analysis; the next
  request rebuilds lazily. Nothing watches or indexes the project
  continuously.

## Previous capability — Milestone 03 (Safe Source Editing)

Everything from Milestones 01–02, plus an in-app **Quick Edit** path:

- **Quick Edit** — from any inspected element, open its source inside
  RootRay at the exact line/column. Selecting another element in the same
  file just refocuses the marker; unsaved edits are never disturbed.
- **CodeMirror 6 editor** — lazy-loaded (zero cost until first use);
  JS/JSX/TS/TSX, CSS/SCSS, HTML, JSON, and plain-text fallback. Line
  numbers, active-line + inspected-line highlight, bracket matching,
  undo/redo, `Ctrl+S` save, `Ctrl+F` in-file search, dark theme.
- **Dirty state + review** — `● Modified` indicator, in-app line-diff
  view ("Changes"), Discard restores the last disk snapshot.
- **Safe save** — SHA-256 optimistic concurrency: RootRay re-reads the
  file, compares hashes, and refuses to overwrite anything that changed
  since you loaded it. Writes go through a same-directory temp file +
  rename so a failed save can't truncate your source.
- **External-change protection** — the open file is watched; a foreign
  write while you have unsaved edits raises a conflict banner
  (*Reload Disk Version / Compare / keep editing*) instead of clobbering
  either side. A clean file auto-reloads.
- **Encoding fidelity** — LF/CRLF convention and UTF-8 BOM are preserved;
  non-UTF-8 and binary files are refused, not corrupted.
- **Revert Last Save** — restores the file to before RootRay's last save
  while the disk still matches that write (refuses otherwise).
- **Boundaries enforced on every call** — project-relative paths only;
  `.env*`, keys, `id_rsa`, `credentials*`, `secrets*`, `.git`,
  `node_modules`, `target`, `dist`, `build` are denied; binary and >2 MiB
  files are rejected with an actionable message.
- **Save → HMR → inspect again** — a save is a normal filesystem write,
  so Vite's own watcher hot-reloads the page with instrumentation intact.
  A syntax error shows Vite's overlay; RootRay stays fully operational
  and the next save recovers the app.

## Previous capability — Milestone 02 (Inspector Engine)

Everything from Milestone 01 (project detection, managed dev-server
lifecycle, live logs, editor detection, filesystem boundaries), plus:

- **Inspector-enabled run** — RootRay launches the project's own Vite dev
  server through a Node runner that merges a development-only
  instrumentation plugin. No edits to `vite.config.*`, `package.json`, or
  any source file.
- **JSX/TSX source instrumentation** — a Babel-based transform stamps
  `data-rootray-*` source metadata (project-relative file, line, column,
  component name) onto intrinsic DOM elements during Vite's transform —
  production builds are never touched.
- **Browser inspector runtime** — a ~9 KB framework-free client injected
  via `transformIndexHtml`. Shadow-DOM overlay, `pointer-events: none`,
  zero layout impact.
- **Authenticated loopback bridge** — `ws://127.0.0.1:<dynamic-port>/rootray`
  with a per-session random token and a versioned protocol
  (`ROOTRAY_PROTOCOL_VERSION = 1`). Wrong tokens, malformed messages, and
  version mismatches are rejected.
- **Inspect Mode** — hover highlights the element and shows
  `ComponentName  src/file.tsx:line`; click selects it, suppresses the
  app's own click handlers/navigation, and sends the selection to the
  desktop. `Escape` cancels. Disabling restores normal behavior.
- **Desktop Inspector panel** — connection state, inspect toggle, selected
  element card (file + line + column + component), read-only source
  preview (~13 lines, highlighted target line), and **Open Source** which
  launches the preferred editor at the exact location (VS Code, Cursor,
  Windsurf).
- **HMR preserved** — instrumentation rides Vite's transform pipeline;
  hot updates keep working and stay instrumented.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+P` | Quick Open — fuzzy file navigation |
| `Ctrl+Shift+F` | Workspace Search |
| `Ctrl+S` | Quick Edit — save (hash-checked, atomic) |
| `Ctrl+F` | Quick Edit — find in current file |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Quick Edit — undo / redo |
| `Escape` | Cancel Inspect Mode / close palettes |

## Prerequisites

- Windows 10/11 with **WebView2 Runtime** (preinstalled on most Windows 11)
- **Rust** (stable, MSVC toolchain) + **Visual Studio Build Tools** (C++
  workload — provides the linker)
- **Node.js** ≥ 20 and **pnpm** ≥ 9
- For the E2E suite: Playwright Chromium (`pnpm --filter @rootray/e2e exec
  playwright install chromium`)

## Install

```sh
pnpm install
pnpm -r --if-present build   # builds the inspector runtime + plugin bundles
```

## Run the desktop app (development)

```sh
pnpm dev:tauri
```

Then: Open Project → pick a React/Vite project → Run Project. When the dev
server is up, open the printed localhost URL — the inspector runtime
connects automatically and the Inspector panel shows the live state.

## Tests

```sh
pnpm test            # Vitest suites + Playwright inspector E2E
pnpm test:rust       # cargo test -p rootray-core (incl. bridge/auth/preview)
pnpm typecheck       # tsc --noEmit across the workspace
pnpm lint            # biome check .
pnpm --filter @rootray/e2e test   # inspector E2E only (needs Chromium)
```

## Supported projects (Milestone 02)

- **Framework:** React + Vite (JSX/TSX, including JSX in `.js`)
- **Package managers:** pnpm, npm, yarn — detected via lockfiles or the
  `packageManager` field.
- A `"dev"` script must exist; inspector launch handles `vite` plus simple
  flags (`--host`, `--port`, `--strictPort`, `--mode`, `--force`,
  `--clearScreen`, `--root`). Anything else falls back to the plain runner
  with the inspector marked unavailable.

## Architecture

```
crates/rootray-core        Native core: detection, process lifecycle,
                           inspector bridge/session, source preview,
                           editor launch-at-location, safe edit sessions
                           (hash-checked atomic writes, file watcher),
                           lazy project tree listing, bounded workspace
                           search, bounded source collection, fs boundaries.
apps/desktop               React UI + thin src-tauri command layer;
                           lazy-loaded CodeMirror Quick Edit panel;
                           explorer, palettes, intelligence views.
packages/source-protocol   Versioned wire contract between browser
                           runtime and the Rust bridge (validated both ways).
packages/inspector-runtime Browser client: WS auth/reconnect, Shadow-DOM
                           overlay, hover/select, click suppression,
                           on-select style details (classes, box model,
                           curated computed styles, matched CSS rules).
packages/vite-plugin       Babel JSX/TSX instrumentation + dev-server
                           runner that merges the plugin into the project's
                           own Vite instance.
packages/intelligence      Bounded static React source analysis (Babel):
                           component definitions, JSX usages, local import
                           resolution. Source is data — never executed.
fixtures/                  Real projects incl. a multi-file inspector app
                           with components, local imports and stylesheets.
tests/e2e                  Playwright suite driving the real fixture.
```

### Inspector data flow

```
Vite transform stamps data-rootray-* on JSX ──▶ rendered DOM
hover/click ─▶ browser runtime reads metadata ─▶ WS + token
──▶ Rust bridge validates (version, token, shape, path safety)
──▶ desktop shows file:line:col ─▶ Open Source launches editor
```

### Safe-edit data flow

```
Quick Edit ─▶ open_source_editor (validate + read + SHA-256 + watch)
──▶ CodeMirror buffer ─▶ save_source_file(content, expectedHash)
──▶ disk hash compare → conflict? refuse : temp-file + rename
──▶ Vite watcher → HMR → updated DOM stays instrumented
```

### Intelligence data flow

```
Explorer        list_project_dir(dir)      lazy, per-expanded-dir only
Ctrl+P          list_project_files()       bounded file list, cached
Ctrl+Shift+F    search_workspace(query)    capped files/bytes/results
Click select    element:selected + styles  CSSOM matched rules + curated
                                           computed styles + box model
Component panel collect_source_files()     capped count/bytes, then
                → @rootray/intelligence    Babel parse, defs + usages,
                (lazy chunk, cached)       import resolution; invalidated
                                           by any source change
CSS source      data-vite-dev-id hint → project-relative stylesheet path
                → Quick Edit / Open External (same safe file layer)
```

All of it flows through the same boundary-checked native layer — relative
paths only, secrets and generated directories denied, hard caps on files,
bytes and results.

## Security model

- No generic `execute(command)` API — only narrow Tauri commands.
- Browser messages are **data only**: the bridge accepts `runtime:hello`,
  `runtime:ready`, `inspect:set`, `element:selected`. Nothing a browser
  sends can spawn a process, write a file, or open an editor.
- Bridge binds `127.0.0.1` only, on a dynamic port, with an ephemeral
  per-session token — never persisted, never exposed to the page except
  through the injected bootstrap.
- Source metadata uses project-relative forward-slash paths; absolute
  paths, `..`, and drive letters are rejected at the protocol layer.
- Preview/open/edit operations re-validate against the canonicalized
  project root on every call; `.env*`, keys, credentials, `.git`,
  `node_modules`, `target`, `dist`, `build` and non-text files are refused.
- Saves are optimistic-concurrency checked (SHA-256) and atomic
  (temp file + rename) — an external edit is never silently overwritten.
- Instrumentation never writes to the project — the integrity E2E hashes
  all source files before and after a session to prove it, and the edit
  E2E asserts a save changes exactly the intended file.

## Known limitations (Milestone 04)

- Only React + Vite; only intrinsic (lowercase DOM) elements carry
  metadata — a custom component's position comes from its rendered DOM.
- Component names are inferred from function/arrow/class declarations;
  ambiguous ownership reports no name rather than a guess.
- Static analysis resolves common import shapes only — aliased paths
  (`@/…`), barrel cycles, `React.lazy`/dynamic imports, and re-export
  chains deeper than one unambiguous `index` hop stay *unresolved*
  (labeled, never guessed).
- CSS source mapping relies on Vite dev `data-vite-dev-id` hints; rules
  from runtime-injected or cross-origin stylesheets report a stylesheet
  hint only when reliable, otherwise "source unresolved".
- Selector *line* numbers inside a stylesheet are not resolved — matched
  rules link to the stylesheet file, not a specific line.
- Playwright E2E drives a protocol-faithful mock bridge; the Rust bridge
  itself is covered by unit/integration tests, not browser automation.
  The in-browser edit path mirrors the native save contract — the real
  `editor::file` implementation is covered by the Rust suite.
- One Quick Edit session at a time — switching files with unsaved changes
  prompts instead of offering tabs.
- No force-overwrite: after a conflict the safe resolutions are
  Reload Disk Version, Compare, or keep editing.
- On non-Windows platforms process-tree kill uses `kill` on the direct
  child only; Windows is the supported target.
