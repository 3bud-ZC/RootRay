# RootRay Status

## In Development — v0.3.0-dev (UNPUBLISHED, UNTAGGED)

### Full Product Identity + Inspect-to-Code Reliability Pass

- **Stable Release Baseline**: v0.2.0 remains immutable and published. v0.3.0 remains UNPUBLISHED and UNTAGGED.
- **Inspect-to-Code Reliability**:
  - **Root Cause Diagnosed**: In `CodeEditor.tsx`, language syntax highlighting extensions load asynchronously. The initial editor build closed over the empty string `""` from when `ed.status === "loading"`. When `build()` completed, it initialized CodeMirror `EditorState` with `doc: ""` and dropped line focus. Rapid selection also lacked monotonic sequence numbers, allowing stale read responses to overwrite newer selections. In `useAutoReveal.ts`, same-file reselection returned early before switching `workspaceTab` to `"split"`.
  - **Pipeline Fix**:
    1. Added monotonic request sequencing `seq` to `EditSession` and reducer actions (`edit-open`, `edit-opened`). Stale read completions with older sequence numbers are discarded.
    2. `EditorPanel.tsx` directly renders `.qe-loading` while `ed.status === "loading"`, mounting `LazyCodeEditor` with `key={ed.relativePath}` only when document text is ready.
    3. `CodeEditor.tsx` tracks document text and focus position with `valueRef` and `focusRef` so `build()` always creates `EditorState` with the actual file text and immediately focuses the inspected line.
    4. `useAutoReveal.ts` no longer returns early on same-file selections, guaranteeing that re-clicking elements in the same file re-centers line focus and switches from `preview` to `split` view.
- **Brand Inspection Overlay**:
  - `packages/inspector-runtime/src/overlay.ts` redesigned to use RootRay glowing orange `#ff6b0c` (`border: 1.5px solid #ff6b0c`, glowing ray box shadow).
  - Dark translucent chip with `backdrop-filter: blur(8px)`.
  - Glowing orange ray indicator dot before component/tag name.
  - High-contrast hierarchy: orange component name (`#ff9d5c`), muted path and line location (`#9aa4b8`).
- **Unified Product Visual Language**:
  - Centralized SVG icon system (`apps/desktop/src/components/icons.tsx`) replacing ad-hoc unicode glyphs (`×`, `⤢`, `◧`, `◨`, `▤`, `⟲`, `←`, `→`, `⟳`, `⌕`, `⧉`, `↗`, `▸`, `⌃`, `⌄`, `⌫`).
  - Dark scrollbars now use the centralized brand border token (`var(--rr-border)`) rather than a hard-coded legacy gray.
  - Clean neutral styling for workbench view tabs (`Preview` | `Code` | `Split`) and `Interact`; glowing RootRay orange badge for active `Inspect`.
  - Inspector confidence badges with high-contrast distinct styles (`EXACT SOURCE`, `APPROXIMATE`, `COMPONENT`, `UNRESOLVED`).
  - Active file row highlighting in Explorer (`background: rgba(255, 107, 12, 0.09)`, `inset 2px 0 var(--accent)`).
  - Error boundary asset updated to canonical `/brand/error.png`.
- **Quality Gates & Verification**:
  - Rust: **213 passed** / 1 ignored (`cargo test`)
  - Vitest: **204 passed** across all packages (`pnpm -r test`)
  - Playwright E2E: **64 passed**
  - Biome: 0 errors (`pnpm exec biome check .`)
  - TypeScript: 0 errors across 10 workspace projects (`pnpm -r typecheck`)
  - Installer smoke: **PASS** (`scripts/installer-smoke.ps1`)
  - ClientFlow-CRM verification: `login-form.tsx` line 46 verified.

## Current Release
**v0.2.0** — Universal Project Workspace — **published, 100%**

- Tag: `v0.2.0` → `29b9b6751a12893a027a1db4ed956398946e675b`
  (annotated, immutable — pushed once, never moved)
- GitHub Release: https://github.com/3bud-ZC/RootRay/releases/tag/v0.2.0
  (non-draft, non-prerelease)
- Pre-tag main CI: run `35220278389` on the release SHA — **success**
- Release workflow: run `35221296320` (tag-triggered) — **success**
- Authoritative installer: `RootRay_0.2.0_x64-setup.exe` —
  `2,937,342 bytes`, SHA-256
  `d0381b680187ab824541451ec2073215aef5b9a362cdabd19b3fd25e445005c7`,
  attached to the release with its `.sha256` manifest
- Public download re-verified: unauthenticated fetch of the release
  asset → checksum match → `scripts/installer-smoke.ps1` PASS on the
  exact public binary
- Installer lifecycle: fresh silent install → launch (no auto-run) →
  clean terminate → silent uninstall PASS; upgrade 0.1.1 → 0.2.0
  in-place PASS
- Version sync: `0.2.0` across root `package.json`, all `packages/*`,
  `apps/desktop/package.json`, `tauri.conf.json`, and both `Cargo.toml`
  manifests
- Current test counts: Rust **195 passed** / 1 ignored · Vitest **162
  passed** · Playwright **40 passed**

### Framework compatibility & capability tiers

- **Evidence-based framework detection** — the `Framework` enum gains
  `VueVite`, `SvelteVite`, `SvelteKit`, `Astro`, `Nuxt`, `Angular` and
  `Remotion`, detected from real manifest dependencies and framework
  config files (never directory names). The TypeScript `Framework` union
  in `packages/shared` mirrors the Rust serialization.
- **Generic Vite adapter reused honestly** — `InspectorAdapter::
  ViteGeneric` now serves `Framework::Vite`, `VueVite` and `SvelteVite`:
  any project whose dev script reconstructs to a plain `vite` invocation
  runs under RootRay's in-memory plugin with `generic-dom` mode. Authored
  `index.html` elements map exactly; framework-rendered DOM reports
  facts + styles with no fabricated source; component intelligence is
  `not-applicable` with a framework-named reason.
- **SvelteKit / Astro / Nuxt / Angular / Remotion = detect & run** —
  these servers render outside Vite's `transformIndexHtml` pipeline
  (SvelteKit sets `appType: "custom"`), so no adapter injects. They are
  detected with versions, run via their declared script, and open the
  printed loopback URL — inspection capabilities report `unavailable`
  with the factual reason instead of a dead-end or a false promise.
- **Authored-bytes stamping guard** — `transformIndexHtml` now stamps
  only when the served HTML is byte-identical to the authored file on
  disk; if anything upstream has already transformed the document,
  stamping is skipped rather than emitting fabricated coordinates.
- **Fixtures** — `fixtures/vue-vite`, `fixtures/svelte-vite` (real deps,
  real e2e through the inspector runner), plus detection-only manifests
  for `sveltekit-basic`, `astro-basic`, `nuxt-basic`, `angular-basic`.
- **`examples/serve.rs`** — a live static-server smoke: starts the real
  loopback server with inspector injection on any directory and reports
  stamping/runtime delivery over real HTTP. Used to validate
  One-Bullet-Arena (real static site): `GET /` 200, authored HTML
  stamped, runtime + bootstrap injected, `runtime.js` served, clean
  shutdown.

### Milestone 03 — Generic Browser Runtime, Static Web & Non-React Inspection

The enduring objective: **RootRay stays useful when the page is not
React.** This milestone delivers framework-free DOM inspection on every
supported runtime, exact authored-HTML source mapping, a native static
server for `index.html` projects, and honest source-less selections for
runtime-created DOM.

- **Source-optional protocol** — `element:selected.source` is now
  optional in `@rootray/source-protocol`, `packages/shared`, and the Rust
  mirror. Validation stays strict whenever a source IS present; a
  runtime-created element reports facts and styles with no fabricated
  location.
- **`@rootray/html-instrument`** — parser-based (parse5 + magic-string)
  HTML stamping: every authored renderable element gets
  `data-rootray-file/line/column` from real parse locations. Structural
  tags (`html/head/body/meta/script/…`) are skipped; template contents
  are traversed; authored `data-rootray-*` is stripped before trusted
  stamps — spoofing can't survive. The Rust mirror
  (`html_instrument.rs`, lol_html) implements the identical contract for
  the static server.
- **Generic DOM runtime mode** — `inspector-runtime` gains
  `mode: "generic-dom" | "jsx-meta"` plus `reloadUrl`. generic-dom picks
  the element itself (every DOM node is inspectable, `<canvas>` included)
  and reports source only when the element itself carries a valid stamp.
  jsx-meta keeps the legacy nearest-instrumented-ancestor contract —
  React/Next behavior is unchanged. The overlay shows "no source" instead
  of hiding. An `EventSource` client on `reloadUrl` reloads the page on
  save-driven notifications.
- **Vite generic path** — `InspectorAdapter::ViteGeneric` for
  `Framework::Vite`; the runner forwards `ROOTRAY_INSPECTOR_MODE`. The
  plugin's `transformIndexHtml` now runs with `order: "pre"` — Vite's
  internal `devHtmlHook` injects `/@vite/client` *before* normal hooks,
  which had silently offset stamped lines by +2 on the first e2e run.
  Stamping raw authored HTML keeps positions factual.
- **Native static server** (`static_server.rs`) — loopback-only HTTP
  for projects with no dev script: traversal/junction/host-header safe,
  GET+HEAD, nested-target subdirectory support, Rust-side HTML
  instrumentation + runtime/bootstrap injection, and an SSE endpoint
  (`/__rootray/events`) that reloads connected pages after RootRay saves.
  AppCore owns its lifecycle; Stop/Restart treat it like any other
  server. Event ordering is fixed so `UrlDetected` reaches the UI with
  the Running state already applied (the installed app previously sat
  at "starting" — a stale state snapshot raced the URL event).
- **Instrumentation idempotency** — `jsx-instrument` now keeps a
  previous pass's stamp when `data-rootray-file` already names the real
  module: bundler chains may run the loader twice, and recomputing on
  transformed code had silently shifted the Next golden path by one line
  (the injected entry import). Mismatched/absent stamps are still
  stripped and restamped.
- **Frontend** — every source-dependent action guards on `sel.source`:
  Open Source / Quick Edit / Copy Path / Copy Context / component
  intelligence / source preview / editor sync. Source-less selections
  show DOM facts and styles and are marked "No authored source".
- **Fixtures** — `fixtures/vite-vanilla` (TS, no framework) and
  `fixtures/nested-static/app` (subdirectory static site).

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
- **Protocol v1 backward compatibility — PASS**:
  `ROOTRAY_PROTOCOL_VERSION` remains 1. The additive `source.confidence` field
  ("exact" | "approximate" | "component") is backward-compatible. Deterministic
  tests in TypeScript (`@rootray/source-protocol`) and Rust (`rootray-core`)
  prove: (a) old v1 payloads without confidence are accepted, (b) new v1 payloads
  with valid confidence levels are accepted, (c) unknown levels like "guessed"
  and `null` values are rejected, and (d) serialization omits `confidence` when
  absent.
- **Installed-app verification — PASS**:
  - **ClientFlow-CRM (real Next.js 16.2.12 application)**:
    Real installed `rootray-desktop.exe` → auto-analyze → `Next.js 16.2.12 · npm · npm run dev` →
    Run → `http://localhost:3000/` → bridge connected → 4 real authored elements mapped:
    `<h1>` → `src/app/(auth)/login/page.tsx:41:13` (`LoginPage`),
    `<div>` → `src/components/ui/card.tsx:11:5` (`Card`),
    `<form>` → `src/components/ui/label.tsx:9:5` (`Label`),
    `<input>` → `src/components/auth/login-form.tsx:46:11` (`LoginForm`).
    Style intelligence (box model) rendered for all selections. Stop confirmed via direct
    network probe. ClientFlow's git status remained identical to the pre-test
    baseline; pre-existing repository state was not created or changed by RootRay.
    *Discovered test issue*: `page.goto(appUrl)` was an invalid server-death check on PWA apps because
    ClientFlow's Service Worker (`public/sw.js`) served offline fallback content even after the Next
    server was dead. All installed tests now use direct loopback network probes outside the browser context.
  - **Nested Next Monorepo (`fixtures/pnpm-monorepo`)**:
    Demonstrates `workspaceRoot != activeTargetRoot`. Workspace root = `fixtures/pnpm-monorepo`,
    active target = `fixtures/pnpm-monorepo/apps/web` (cwd = target root).
    Open monorepo root → detected as `pnpm workspace` → `apps/web` active (`pnpm run dev`) →
    Run → URL detected → bridge connected → click `<h1>` in `Banner.tsx` →
    selection reports workspace-relative `apps/web/components/Banner.tsx:4:10` (never `src/...` or absolute `C:\...`).
    Quick Edit opens `apps/web/components/Banner.tsx` without saving.
    Explorer remains rooted at workspace root (`apps/` + `packages/` visible).
    Workspace Search covers entire workspace (finds `apps/api/src/index.js` outside active target;
    opening it verifies security root = workspace root). Stop verified via direct network probe;
    stable entry stubbed; zero scratch dirs left behind.
  - **Next.js Fixture (`tests/e2e/installed-golden-next.mjs`)**: PASS.
  - **React+Vite Fixture (`tests/e2e/installed-golden.mjs`)**: PASS.

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

Re-scanned this cycle with `cargo run -p rootray-core --example scan`:

| Repository | Result |
|---|---|
| ClientFlow-CRM | Next.js 16.2.12 · npm · `npm run dev` · all runtime caps available · 20ms · **live shimmed `next dev` → `/login` SSR carries `data-rootray-*` on real sources** |
| ELHABAK-Construction-System-V1 | pnpm workspace · 8 targets · `apps/web` Next.js 16.0.3 auto-selected, runtime caps available · `apps/api` Node server (n/a caps) · libs classified · 130ms |
| workfolw (video-factory-monorepo) | pnpm workspace · 8 targets · `apps/web` Next.js 15.1.7 full caps · Remotion render-worker honestly unavailable · 91ms |
| ThreadForm | pnpm workspace · 13 targets · `apps/web` Next.js 15.1.4 full caps · 11 libraries classified · 142ms |
| Shadow Runner | Vite 6.2.0 (non-React, Phaser) · generic-dom caps: inspect ✓ · srcmap partial (authored HTML exact) · hmr ✓ · 21ms |
| One-Bullet-Arena | static-web · inspect ✓ · srcmap partial (authored exact) · live `serve` smoke: stamped + runtime injected · 15ms |
| Beni-Suef-National | React+Vite 8.2.0 · npm · full caps · 12ms |
| Egyptian-Russian-University-master | nested manifest discovered → React+Vite 5.1.0 · 14ms |
| natega (bsnu-result-portal) | React+Vite 8.2.0 · npm · full caps · 14ms |
| camera (gesturefx) | React+Vite 8.1.1 · npm · full caps · 17ms |
| short-studio-server | pnpm workspace · Remotion root (unavailable, honest reason) + 2 nested static-web targets (inspect ✓) · 39ms |
| short (abud-shorts-engine-v2) | pnpm workspace · truncated at 400-dir cap (real bound) · Remotion + nested static targets · 222ms |
| PoseMeme | no manifests → usable workspace, 0 targets · 2ms |
| RepoRadar-Ai | not found on the user's GitHub account or local disks — excluded from the matrix |

### Deferred to later milestones

- Framework-specific runtime adapters for SvelteKit, Astro, Nuxt,
  Angular, Remotion (they render outside Vite's `transformIndexHtml`;
  each needs its own server-side injection point).
- Component-level intelligence for Vue/Svelte (generic DOM inspection
  already covers every element; component-tree mapping is the gap).

### v0.2.0 verification

- `cargo test -p rootray-core` — 195 passed, 0 failed, 1 ignored
  (`golden_path_real_vite_server` — real `npm run dev` run, passes with
  `--ignored`). Coverage includes `static_server` (14 tests — serving,
  traversal/host-header/junction safety, HTML stamping, SSE reload,
  nested targets, AppCore run/stop, event-ordering contract),
  `html_instrument` units, and the new framework-detection/capability
  matrix + adapter-dispatch cases.
- `pnpm -r test` — Vitest 162 green (shared 7, source-protocol 21,
  intelligence 17, jsx-instrument 20, html-instrument 11, vite-plugin 8,
  inspector-runtime 21, next-adapter 5, desktop 52).
- `pnpm --filter @rootray/e2e test` — Playwright 40 e2e green
  (generic-dom connect/auth, exact authored HTML mapping, source-less
  runtime-DOM selection, canvas mapping + click suppression, Escape-off;
  + Vue+Vite and Svelte+Vite real-server specs: bridge handshake, exact
  authored mapping, honest no-source on framework-rendered DOM).
- `pnpm -r typecheck`, `pnpm exec biome check .`, `cargo check` (both
  crates), `cargo build -p rootray-desktop` — green.
- `pnpm build:tauri` — release build + NSIS bundle green
  (`RootRay_0.2.0_x64-setup.exe`); `scripts/installer-smoke.ps1` — PASS.
- **Installed-app golden paths — ALL PASS** (all drive the real installed
  `rootray-desktop.exe` via WebView2 CDP + a controlled Chromium page with
  direct network probes for server shutdown):
  - `installed-golden-static.mjs` (static-web fixture — native server,
    authored `<canvas>` → `index.html:8:5`, unmapped runtime element,
    Quick Edit → SSE reload, clean stop): PASS
  - `installed-verify-shadow-runner.mjs` (real Vite 6.2.0 + Phaser game —
    authored `#game-container` → `index.html:24:5`, runtime canvas
    honestly unmapped): PASS
  - `installed-verify-clientflow.mjs` (ClientFlow-CRM, Next.js 16.2.12): PASS
  - `installed-golden-monorepo.mjs` (pnpm monorepo nested Next target): PASS
  - `installed-golden-next.mjs` (Next.js fixture): PASS
  - `installed-golden.mjs` (React+Vite fixture): PASS
- Real-repo validation: `ClientFlow-CRM` live shimmed `next dev` renders
  `data-rootray-*` on real SSR output (`/login`, 200) and passes 4-element
  source mapping with style intelligence; `ELHABAK-Construction-System-V1`
  monorepo → 8 targets, `apps/web` Next.js 16.0.3 auto-selected with runtime
  caps available; Shadow Runner runs under the generic Vite adapter with
  honest source-less selection on runtime-created DOM.

---

## In development — v0.3.0 (unpublished, not tagged)

### Visual Identity Reconstruction from Approved Artwork — 2026-09-20

This pass corrects the previous brand implementation that had
reinterpreted RootRay's identity instead of deriving it from the supplied
approved artwork.

- **Previous reinterpretation rejected:** removed the hand-authored
  small robot maps and obsolete previous-pass masters
  (`board.jpg`, `icon-src.png`, `lockup-src.png`, `wordmark-src.png`).
  The orange ring/simple mark is not used as the application icon.
- **Canonical artwork established:** committed the supplied approved
  boards under `docs/brand/source/` and rewrote
  `scripts/build_brand_assets.py` so generated assets are crops/resizes
  from those images, not redraws.
- **Production extraction:** regenerated mascot, wordmark, lockup,
  splash, empty/success/error state art, hero/social preview, runtime
  public brand assets, and Windows icon frames.
- **App icon validation:** final installed verification confirms the
  executable, Start Menu shortcut, title bar and taskbar all contain the
  approved robot icon signature.
- **Home validation:** installed Home uses the approved empty-state
  mascot artwork and the extracted header wordmark/tagline.
- **Header validation:** header uses `mascot-head.png` plus the extracted
  `wordmark.png`; CSS-built Root/Ray wordmark text was removed from the
  prominent header brand.
- **Ready-state layout correction:** analyzed-but-not-running state now
  uses the desktop width as a workspace: Explorer on the left, Ready/run
  action panel in the center, project details/capabilities on the right.
  It no longer collapses into a narrow centered dashboard.
- **README hero correction:** README hero and GitHub social preview
  derive from the supplied wide artwork. README explicitly separates
  brand artwork from real product screenshots.
- **Installed visual acceptance:** final installed build captured Home,
  Ready, Waiting for dev server, Running workbench, Inspect-to-Code
  split, Preview Focus, Settings/About, taskbar, title-bar, Start Menu
  and executable icon verification. Screenshots live under
  `target/installed-verify-brand/`; selected real product screenshots
  were refreshed in `docs/media/`.
- **Fresh installer:** `RootRay_0.3.0_x64-setup.exe` —
  **4,036,371 bytes**, SHA-256
  `D841E659599C01F48FADC8D9100694A567404E7F5B6CE0699467C27CF2C26350`.
- **Verification:** `cargo test -p rootray-core` — 213 passed, 1 ignored;
  `cargo test -p rootray-core --test suite -- --ignored` — 1 passed;
  `pnpm -r test` — all workspace tests passed including desktop Vitest
  92, package Vitest suites for 204 Vitest tests total, and Playwright
  64; `pnpm --filter @rootray/e2e test` — 64 passed;
  `pnpm -r typecheck` —
  pass; `pnpm exec biome check .` — pass with 8 existing CSS specificity
  warnings; `cargo check -p rootray-core`, `cargo check -p
  rootray-desktop`, `cargo build -p rootray-desktop`, `pnpm -r build`,
  `pnpm build:tauri` — pass; `scripts/installer-smoke.ps1` — PASS;
  `node tests/e2e/installed-verify-brand.mjs` — PASS on the final
  installed build.

**v0.3.0 remains unpublished and untagged.**

**Integrated browser workbench.** The project now runs *inside* RootRay:
Run → the dev-server URL opens in an embedded WebView2 child surface →
normal app interaction → Inspect → click an element → source opens
beside the preview → edit + save → HMR/Fast Refresh applies in place →
stop tears the surface down with the process tree. External browser
opening remains an explicit fallback action, never the default.

### Architecture

- **Native child webview** — a second WebView2 (`project-preview`)
  parented to the main window, created via `Window::add_child` (Tauri
  `unstable` feature). The React `.preview-host` div is only a
  measurement rect; a `ResizeObserver`/rAF loop pushes bounds via
  `preview_set_bounds`, and the surface is hidden while modals, palettes
  or pane drags cover its pixels.
- **Privilege isolation** — capabilities scope every privilege to
  `webviews: ["main"]`; the preview gets zero command access (verified
  by an in-page IPC probe — every invoke denied by ACL). All preview
  commands additionally reject non-`main` callers natively.
- **Navigation policy** — main-frame navigation is loopback-only;
  `window.open`/`target=_blank` is denied, local URLs re-navigate the
  preview, remote http(s) goes to the system browser unprivileged.
- **Preview state** — `hidden → waiting → loading → ready → stopped →
  error` with a monotonic generation; `rootray://preview-state` pushes
  snapshots and the reducer drops stale ones (including across dispose).
- **Workbench layout** — Preview/Code/Split tabs; inspect selections
  auto-reveal the mapped source beside the preview; Ctrl+Shift+C and
  Escape toggle Inspect from *inside* the preview (runtime keydown);
  canvas/runtime-created DOM stays honestly source-unresolved.
- **Resizable, collapsible workbench** — Explorer and Inspector panes
  collapse to the rail (Ctrl+B) and drag-resize; the Output console
  collapses to a bar and drags vertically (Ctrl+J); the preview/code
  split drags over a wide range and double-click resets. Layout state
  (visibility, widths, split ratio, focus mode) persists under
  `rootray.layout.v1` with clamping, and **Reset Layout** in Settings
  restores defaults. Preview Focus and Code Focus maximize a single
  area; an inspect click inside Preview Focus offers Show Source
  instead of breaking focus. Hidden panes stay mounted so their state
  survives, and native preview bounds track every layout change.
- **Change Project while running** — the new `change_project` command
  stops any live server and analyzes the selected directory as *one*
  operation under a lifecycle mutex that serializes
  analyze/start/stop/restart. The earlier flow (frontend check → stop
  → analyze across three IPCs) could slip a `starting → running`
  transition between the check and the analysis, producing
  `illegal runtime state transition: running -> analyzing`.
- **Snapshot ordering** — `RuntimeState` now carries a monotonic `seq`
  stamped per snapshot; concurrent emit paths (IPC thread vs. process
  watcher) can deliver `rootray://state` out of order, and the reducer
  drops any snapshot older than the last applied — the same guard the
  preview channel already had. Found by installed verification: a late
  `stopped` event was overwriting the `ready` snapshot and leaving the
  UI showing the previous project.
- **Settings** — `openPreviewAutomatically` (default on) migrates the
  legacy `openBrowserAutomatically` value when unset.

### Installed-app fixes found by golden-path verification

- **`preview_create` must be `async`** — synchronous commands run inside
  WebView2's IPC dispatch, where `add_child`'s controller creation never
  receives its completion callback (tauri#4121 / wry#583): the app
  deadlocked with all IPC wedged. Async commands run on the runtime, so
  the build posts to the event loop with a clean stack.
- **`.wb-right` width binding** — the inspector pane had `flex-shrink:0`
  with no width, exploded to ~5600px over the workbench and swallowed
  editor clicks; `style={{ width: rightW }}` restored.
- **`stop_dev_server` notify gap** — the in-process static server emits
  no process events, so the stopped transition never reached the UI
  (and `preview_mark_stopped` never fired). `notify_state_changed()` now
  fires on the static-stop and failed-stop paths.
- **Editor flex fit** — `.qe-body`'s fixed 340px overflowed the split
  pane and clipped Save; it now flexes inside `.wb-code`.
- **Stale inspector bundle** — `packages/inspector-runtime/dist` must be
  rebuilt (`pnpm -r build`) before bundling; `build.rs` stages dist
  outputs into `inspector-assets/` automatically.

### Brand identity & open-source readiness

The supplied pixel-art robot mascot and identity artwork are now the
product brand — applied to the app shell and docs while the workbench
itself stays a dense, professional developer tool.

- **Asset pipeline** (`scripts/build_brand_assets.py`, Pillow) —
  reproducible: alpha-threshold crop for the standalone mascot, runtime
  lockup/mascot/wordmark under `apps/desktop/public/brand/`, masters
  under `docs/brand/`, multi-size `icon.ico` (16/24/32/48/64/128/256)
  rendered entirely from the robot — purpose-built pixel variants for
  16/24/32px, full mascot from 48px up — plus a 1280×640 social
  preview. (The earlier ring-mark small-icon fallback was rejected and
  removed — see "Manual brand correction pass".)
- **Centralized palette** — brand tokens in `index.css`: accent
  `#ff6b0c` sampled from the artwork, ember/glow variables, cool
  blue-gray panel borders. Semantic status tints kept; transient states
  (analyzing/starting/stopping) use the board's info blue.
- **App identity** — bootstrap splash in `index.html` (removed on React
  mount, no artificial delay), mascot header mark + tagline "Point at
  the UI. Reach the source.", branded Home lockup, `BrandLoader` for
  busy states, mascot ErrorBoundary, empty-code-pane watermark,
  Settings → About (version, tagline, stable-release pointer).
- **Docs/community** — rewritten README (hero, real installed-app
  screenshots, honest capability tiers, v0.2/v0.3 distinction),
  `docs/brand.md` brand guide, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, issue forms + PR template.
- **Repo metadata** — description, homepage and 12 topics set via
  GitHub API; Discussions enabled. Social-preview PNG generated at
  `docs/brand/rootray-social-preview.png` — GitHub has no API for it;
  upload is a manual UI step.
- **Real screenshots** — `tests/e2e/installed-shots.mjs` +
  `capture-window.ps1` capture the installed app via `PrintWindow`
  (`PW_RENDERFULLCONTENT`) so the native WebView2 preview surface is
  actually visible (DOM screenshots blank it); DPI-aware sizing fixed
  a clipped right edge on scaled displays.

### Manual brand correction pass

Manual feedback on the installed build rejected the previous icon
decision: the Windows title bar and taskbar showed the orange ring
mark, the header mascot was tiny, and the Preview-waiting mascot was
illegible. Correction pass — **the pixel robot mascot is the canonical
RootRay application icon at every size**; the ring mark is decorative
artwork only and no longer appears in any application-icon context.

- **Ring mark rejected** as the primary application icon — removed
  from `icon.ico`, the asset pipeline, and all app-icon surfaces.
- **Dedicated small-size robot variants** — hand-authored pixel maps
  for 16/24/32px (white head, dark face panel, two orange eyes,
  antenna light, ear-ring detail) built with nearest-neighbor output;
  no downscale-blur, no ring fallback. Masters committed under
  `docs/brand/icon-{16,24,32}.png`; `icon.ico` frames verified
  16/24/32/48/64/128/256 — robot at every frame (extracted and
  pixel-inspected).
- **Reproducible pipeline** — `scripts/build_brand_assets.py`
  generates the small variants, `mascot-head.png` (24px canvas), and
  the full icon set; `brand.test.ts` decodes the ICO and asserts robot
  pixel signatures at every frame.
- **Title bar — verified robot** on the real installed build
  (PrintWindow capture: white head + orange eye pixels; no ring).
- **Taskbar — verified robot** on the real installed build. Root
  cause of the lingering ring: the window exposed only `ICON_SMALL`
  (tao sets `ICON_BIG` separately), so Explorer painted its stale
  icon-cache bitmap for the exe path. Fix: the app now sets
  `ICON_SMALL` + `ICON_BIG` from the exe's own icon resource at
  startup (`set_windows_icons` in `lib.rs`); verified via
  `WM_GETICON` — both handles return the robot — plus a targeted
  `SHCNE_UPDATEIMAGE` invalidation and icon-cache rebuild. The
  installed verify locates RootRay's taskbar button via UI Automation
  and asserts robot pixels on that exact tile.
- **Start Menu — verified robot** (shortcut icon extracted:
  white-head + orange pixel signature).
- **Installer / uninstaller / Programs & Features — robot**
  (setup.exe and uninstall.exe icons extracted and pixel-checked;
  `DisplayIcon` resolves to the installed exe).
- **Header sizing** — dedicated robot-head glyph at readable size
  with `Root` (white) / `Ray` (orange) wordmark hierarchy.
- **Loading/waiting sizing** — `BrandLoader` renders the mascot at
  64px (56–80px band); Preview waiting state verified at exactly 64px
  on the installed build; splash keeps the robot lockup at 150px,
  `image-rendering: pixelated`, no artificial delay.
- **DPI** — verified at the machine's 125% scaling (physical-pixel
  captures: crisp title-bar and taskbar icons); the authored per-size
  frames render 1:1 at 100%.
- **Installer (this pass)** —
  `RootRay_0.3.0_x64-setup.exe` · **3,266,142 bytes** · SHA-256
  `40c2a887f7ca8f24ec753d99bf269562e4ebc6e1ed6b4c5b8101f2cffe02ae7e`
  · `scripts/installer-smoke.ps1` PASS · `installed-verify-brand.mjs`
  PASS end-to-end on the installed build.

### v0.3.0 verification so far

**Acceptance caveat (resolved):** the earlier rounds below ran against a
*manually deployed* binary (the exe copied over the install dir) after
two silent NSIS installs stalled. The final acceptance pass ran the real
installer end-to-end — see "Final installer acceptance".

- Rust **213 green** (200 suite + 13 units, 1 ignored —
  `golden_path_real_vite_server`, passes when run explicitly). New core
  coverage: `change_project` stop-then-analyze under one lifecycle
  hold, `starting`/`running` start notifications, direct-analyze
  rejection while running.
- Vitest **191 green** — exact audit (`pnpm -r test`): desktop **79**,
  inspector-runtime **23**, source-protocol **21**, jsx-instrument
  **20**, intelligence **17**, html-instrument **11**, vite-plugin
  **8**, shared **7**, next-adapter **5**. New coverage: layout
  persistence/clamping/reset, reducer layout actions, stale-snapshot
  drop, preview-controller, brand assets/ICO dimensions/splash removal.
- Playwright **62/62** (workbench + a11y + full regression). New
  coverage: pane collapse/restore, focus modes, output resize, split
  drag, layout persistence, reset, scroll containment, Change Project
  single-command contract, target-switch guard, branded home lockup +
  header mark assertions.
- `pnpm -r typecheck` all 10 projects · `pnpm exec biome check .` clean
  (4 pre-existing CSS warnings) · `cargo check`/`cargo build` both
  crates green.
- **Installed layout + transition verification: PASS**
  (`tests/e2e/installed-verify-layout.mjs` + `pick-folder.ps1`) on the
  NSIS-installed app — real ClientFlow-CRM run with embedded preview:
  Reset Layout, pane hide/restore, output collapse/resize, Preview
  Focus + exit, split drag, inspect→source with hidden inspector,
  restart/stop with no illegal transition, native folder picker driven
  to `fixtures/static-web`, Change Project while running
  (stopped→analyzed→`static-web`, old process tree dead, zero
  notices).

#### Final installer acceptance (real NSIS, no manual copy)

- `pnpm -r build` + `pnpm build:tauri` →
  `target\release\bundle\nsis\RootRay_0.3.0_x64-setup.exe`
  — **3,271,995 bytes** · SHA-256
  `31dab9fe381f99a5183c9ccb10eb9ca9d6ec528a66547bf373ee737d9922cc82`
  (brand build; the earlier 2,952,566-byte binary predates brand
  integration).
- `scripts/installer-smoke.ps1`: **PASS** — silent install → assets →
  launch → no stray dev server → silent uninstall → binary removed.
- **Installed workbench golden path: PASS** on the NSIS-installed app:
  embedded WebView2 preview inside RootRay, every privileged IPC denied
  from the preview, Interact/Inspect, click→exact source, Quick
  Edit→Vite HMR, re-inspect, Escape + Ctrl+Shift+C, toolbar nav, local
  popup policy, preview+server teardown.
- **Installed Next golden path: PASS** — Next 16.2.12, source attrs,
  Fast Refresh round-trip, App Router nav.
- **Installed real projects: PASS** — Shadow Runner (Vite 6.2.0 +
  Phaser; canvas facts/styles, no fabricated source) and ClientFlow-CRM
  (4 elements → 4 exact authored files; git status identical to
  baseline).
- Silent **uninstall verified** — binary, install dir and registry entry
  all removed.
- **Installed brand verification: PASS**
  (`tests/e2e/installed-verify-brand.mjs`) on the NSIS-installed brand
  build — exe icon contains the mascot, branded home (lockup + header
  mark + tagline), Settings → About (version/tagline/stable line),
  then a real ClientFlow-CRM run: embedded preview, inspect →
  `src/app/(auth)/login/page.tsx` source, Preview Focus, clean stop.
- Earlier rounds also passed `installed-golden-static`,
  `installed-golden-monorepo` (workspace-root scoping) on the installed
  app.

**Not tagged, not published.**

---

## Release History (published — do not alter)

> **Everything below this line is historical v0.1.x record.** It is
> preserved verbatim for audit, uses only v0.1.x-era facts and counts,
> and is superseded wherever the v0.2.0 sections above differ (test
> counts, installer artifact, release SHAs, capability scope).

## Overall Progress (v0.1.x)
100% — MVP complete

## Historical v0.1.x — Milestone 05
Release Hardening, Windows Packaging & MVP Final Acceptance — **Complete**

## Historical v0.1.x — Release Status
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

## Historical v0.1.x — Patch v0.1.1 (published)

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

## Historical v0.1.x — Implemented (Milestone 05 additions)

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

## Historical v0.1.x — Architecture

Unchanged in shape (see `docs/architecture.md`): rootray-core holds all
logic with zero Tauri deps; the frontend receives events only. New in M5:
`process/job.rs` containment and `ROOTRAY_INSPECTOR_ASSETS_DIR`-based
asset resolution for packaged builds.

## Historical v0.1.0 — Installer

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

## Historical v0.1.x — Verification

> v0.1.x-era counts — superseded. Current v0.2.0 counts are in the
> `v0.2.0 verification` section above (Rust 195 + 1 ignored, Vitest 162,
> Playwright 40).

### Historical v0.1.x automated counts

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

### Historical v0.1.0 Release Build

`pnpm build:tauri` → release `rootray-desktop.exe` (10,604,032 bytes,
10.1 MB, local measurement) + the NSIS installer above. The Release
workflow ran the identical command remotely.

### Historical v0.1.0 Installer Smoke Test

- **Local:** `scripts/installer-smoke.ps1` on the locally built artifact —
  silent install OK → exe + all three `inspector-assets` present → app
  launched and initialized (pid verified) → no dev server spawned on
  launch → clean terminate → silent uninstall → binary removed.
  `INSTALLER SMOKE: PASS`.
- **Remote:** the same script ran inside Release run #1 on
  `windows-latest` and passed.

### Historical v0.1.x End-to-End Acceptance

Browser-driven golden path is covered by Playwright against real Vite:
inspect → source → component intelligence → style intelligence →
Quick Edit → safe save → HMR → re-inspect — plus palettes, explorer and
a11y flows against the production-built UI (Tauri internals stubbed for
the DOM-level pass only). Installed-app launch verified by the smoke
script both locally and in Actions. Driving every GUI step inside
WebView2 remains environment-limited (no WebView2 test driver).

### Historical v0.1.x Security Audit

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

### Historical v0.1.x Dependency Audit

- `pnpm audit --prod`: **0 vulnerabilities**.
- `cargo audit` (474 crates): **0 vulnerabilities**; 7 warnings, all
  transitive/unreachable-in-product: `proc-macro-error` + `unic-*`
  unmaintained (build/proc-macro path via Tauri), `glib` iterator
  unsoundness (Linux-only Tauri dep, not called on Windows).
- Secret scan of tracked files: clean — no `.env`, keys, tokens,
  credentials, or machine paths committed.

### Historical v0.1.x Performance (measured, local build)

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

## Historical v0.1.x — Known Issues

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

## Historical v0.1.x — Deferred Items

> v0.1.x-era list — partially superseded: v0.2.0's generic-DOM path now
> covers non-React Vite, Vue+Vite, Svelte+Vite, and static sites.
> Current deferrals are in the v0.2.0 "Deferred to later milestones"
> section above.

- Code signing + auto-updater (needs cert + key infra — out of MVP scope).
- GUI-level WebView2 automation; multi-file tabs; selector-line CSS
  resolution; deeper import resolution; non-React frameworks.

## Historical v0.1.0 — Release Artifacts

| Artifact | Location | Notes |
|---|---|---|
| Actions artifact | `rootray-main-windows-x64` (Release run #1) | authoritative |
| NSIS installer | `RootRay_0.1.0_x64-setup.exe` | 2,569,430 bytes |
| Checksum manifest | `RootRay_0.1.0_x64-setup.exe.sha256` | matches installer |
| Executable | `target/release/rootray-desktop.exe` | 10.1 MB, local |

## Historical v0.1.0 — Remote Release Verification

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

## Historical v0.1.0 — Release Source SHA
`eedfee2f0da19665d1089e30b82d76013e3e70c3` — the commit Release run #1
built the v0.1.0 installer from.

## Release Source & Documentation SHAs

- **v0.2.0 release source SHA** (what the release workflow and installer
  were built from): `29b9b6751a12893a027a1db4ed956398946e675b`
- **Post-release documentation SHA** (the v0.2.0 docs-finalization
  commit on `main`): `9a46534eaa78d9d77afe4d172e17097981d6e26b`
- This STATUS-consistency correction lands as one further
  documentation-only commit on `main` (tip above `9a46534e`); the
  installer was NOT built from it and the `v0.2.0` tag is unchanged.

## Last Updated
2026-09-19
