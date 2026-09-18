# Changelog

All notable changes to RootRay, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style. Dates are UTC. Authoritative detail: [STATUS.md](STATUS.md).

## [Unreleased] — v0.3.0 (development)

### Added — Integrated Browser Workbench

- Embedded WebView2 **Preview** inside RootRay — the project runs in the
  app, not an external browser. Interact/Inspect modes, browser toolbar
  (back/forward/reload/URL/external), loopback-only navigation with a
  deny-list for remote links. Preview webview has zero IPC privileges.
- **Click-to-source in one window** — inspect an element and the mapped
  source opens beside the Preview; edit and save with HMR/Fast Refresh
  or SSE reload applying in place.
- **Flexible workbench layout** — collapsible/resizable Explorer,
  Inspector and Output panes (`Ctrl+B`, `Ctrl+J`), Preview/Code/Split
  views, Preview Focus and Code Focus modes, draggable split with
  double-click reset, persisted layout with clamping, Reset Layout.
- **Brand identity** — RootRay pixel-art mascot/wordmark, new app icon
  pipeline, branded home/splash/states, canonical guide in
  `docs/brand.md`.
- `change_project` command — switching projects while a server runs
  stops the old tree and analyzes under one lifecycle hold.
- `RuntimeState.seq` — monotonic snapshot ordering; the reducer drops
  stale `rootray://state` arrivals.

### Fixed

- `illegal runtime state transition: running -> analyzing` when changing
  projects mid-run — lifecycle commands are now serialized.
- Stale workspace display after project change — out-of-order state
  events could overwrite the newer snapshot.
- Preview bounds/visibility now track every layout change (pane
  collapse, split drag, focus modes, output resize).

### Community

- CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, CHANGELOG.md,
  GitHub issue forms and PR template.

## [0.2.0] — 2026-09 — Universal Project Workspace

- Evidence-based workspace analysis (kind, package manager, targets,
  capability matrix) replacing the global "supported" gate.
- Framework detection: Vue+Vite, Svelte+Vite, SvelteKit, Astro, Nuxt,
  Angular, Remotion — with honest capability tiers.
- Generic-DOM inspection for non-React targets; authored-HTML source
  mapping via parser-based stamping.
- Native loopback static server for `index.html` projects with
  save-driven SSE reload.
- Next.js adapter (Turbopack + webpack dev paths), React 19 support,
  instrumentation idempotency.
- Installer, session recovery, diagnostics, accessibility pass.
- See the [v0.2.0 release](https://github.com/3bud-ZC/RootRay/releases/tag/v0.2.0)
  and STATUS.md for the full record.

## [0.1.1] — 2026-09 — Patch

- Fixed: project picker closed without analyzing (missing
  `rootray://state` emission after `analyze_project`).

## [0.1.0] — 2026-09 — MVP

- Initial release: React+Vite inspection, click-to-source, component and
  style intelligence, Quick Edit with safe saves, Explorer, Quick Open,
  Workspace Search, Windows Job Object containment, NSIS installer.
