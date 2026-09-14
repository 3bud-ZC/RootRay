# RootRay Architecture

## Layers

```
React frontend (apps/desktop)
        │  invoke: narrow commands only
        ▼
src-tauri command layer (apps/desktop/src-tauri)
        │  delegates everything
        ▼
rootray-core (crates/rootray-core)   ← all logic, zero Tauri deps
        │
        ├─ project/     detection + adapter registry + dev-command resolution
        ├─ process/     spawn/supervise/kill dev servers + URL detection
        ├─ launcher/    external editor registry + open
        ├─ filesystem/  canonicalized path boundaries
        ├─ state/       runtime state machine (idle…failed)
        ├─ settings/    local JSON settings store
        └─ app.rs       AppCore — orchestrates state + processes
```

## Why `rootray-core` is separate

The Tauri shell only wires `AppCore` methods to `invoke` commands and
forwards `ProcessEvent`s to the frontend. Keeping the core Tauri-free means
every behavior is unit-testable without a webview, and the security boundary
("frontend can only do X") is physically enforced by the command list.

## Event flow

```
dev server stdout/stderr
    → ProcessManager reader threads
    → ProcessEvent sink
    → AppCore updates RuntimeState (authoritative)
    → hook → tauri emit: rootray://process-event + rootray://state
    → frontend reducer → UI
```

The frontend never polls; it receives events plus a fresh state snapshot.

## Runtime state machine

```
idle ──▶ analyzing ──▶ ready ──▶ starting ──▶ running ──▶ stopping ──▶ stopped
          │             │           │            │                      │
          └──▶ failed ◀─┴───────────┴────────────┴──▶ failed            └──▶ starting (restart)
```

- Exits during `running`/`starting`: code 0 → `stopped`, otherwise `failed`.
- `failed` allows `starting` (retry/restart) — a dead process handle is
  simply replaced.
- Events are generation-guarded: output from a killed process cannot
  corrupt the state of a newer run.

## Adding a framework adapter

Implement `project::adapters::ProjectAdapter` (`detect(ctx)`), register it
in `adapters()`. Dev-command resolution is shared (package-manager driven),
so adapters only identify the framework.

## Adding an editor launcher

Append a `LauncherSpec` (id, display name, PATH names, known install
locations) to `LAUNCHERS` in `launcher/mod.rs`.

## Inspector (Milestone 02)

```
Vite dev transform (babel) ── stamps data-rootray-{file,line,column,component}
        │                       on intrinsic JSX elements; source untouched
        ▼
rendered DOM ──▶ browser inspector-runtime (Shadow-DOM overlay,
        │        capture-phase suppression, Escape, bounded reconnect)
        ▼
ws://127.0.0.1:<dynamic>/rootray  + per-session token + versioned protocol
        ▼
Rust inspector bridge ── validates version/token/shape/path-safety
        ▼
AppCore ──▶ rootray://inspector-state + selection ──▶ InspectorPanel
        ▼
read_source_preview / open_source_location  (re-validated vs project root)
```

Browser messages are data only. Every privileged action is an explicit
command initiated by the desktop UI, never by the page.
