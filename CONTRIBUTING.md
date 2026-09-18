# Contributing to RootRay

Thanks for helping. RootRay is a local-first Windows developer tool —
contributions should keep it fast, honest, and safe.

## Ground rules

- **Honesty over claims.** RootRay never fabricates a source location or
  capability. If something can't be proven, the UI says so. Keep it that
  way — an honest `unresolved` beats a confident guess.
- **Local-first.** No telemetry, accounts, cloud calls, or analytics.
  The only sanctioned listener is the loopback inspector bridge.
- **Security boundary is real.** Workspace-relative filesystem access,
  secret denylist, preview IPC isolation, process containment. Don't
  weaken it to make a feature work.
- **Tests gate merges.** `cargo test -p rootray-core`, `pnpm -r test`,
  `pnpm -r typecheck` and `pnpm exec biome check .` must stay green.
  Don't reduce coverage.

## Reporting bugs

Use the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml).
Include: RootRay version, Windows version, the project's framework and
package manager, reproduction steps, expected vs actual. Settings →
Copy Diagnostics produces a bounded, secret-free report you can paste.

**Never** paste secrets, `.env` contents, tokens, or private source code
into an issue. Security vulnerabilities: see [SECURITY.md](SECURITY.md) —
do not open a public issue.

## Requesting features

Use the [feature request form](.github/ISSUE_TEMPLATE/feature_request.yml).
Describe the product problem and your use case — not a prescribed
implementation. RootRay's scope is deliberately narrow; the best requests
explain the workflow gap.

## Development setup

Prerequisites: Windows 10/11, Rust stable (MSVC) + Visual Studio Build
Tools (C++ workload), Node.js ≥ 20, pnpm ≥ 9.

```sh
pnpm install
pnpm -r --if-present build   # inspector runtime + plugin bundles
pnpm dev:tauri               # dev build
```

Useful commands:

```sh
pnpm test            # Vitest + Playwright E2E
pnpm test:rust       # cargo test -p rootray-core
pnpm typecheck
pnpm lint            # Biome
python scripts/build_brand_assets.py   # regenerate brand assets
```

## Conventions

- **Rust:** all logic lives in `crates/rootray-core` with zero Tauri
  dependencies; `apps/desktop/src-tauri` is a thin command layer.
- **Frontend:** React + TypeScript; state flows through the reducer in
  `src/state/`. Workbench surfaces stay dense and professional — the
  brand layer is for startup/home/states only (see `docs/brand.md`).
- **Protocol:** `packages/source-protocol` is versioned; additive
  changes only, validated on both sides.
- **Commits:** concise messages explaining *why*, matching repo style.
- Keep changes focused; don't reformat unrelated code.

## Pull requests

- Fill in the PR template — what changed, why, how verified.
- One concern per PR.
- Include tests for behavior changes (reducer units, Rust core tests,
  or Playwright e2e as appropriate).
- If you touch the workbench layout or preview lifecycle, run
  `tests/e2e/installed-verify-layout.mjs` against a built install.
