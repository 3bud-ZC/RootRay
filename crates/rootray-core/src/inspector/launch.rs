//! Inspector-enabled launch paths, per framework adapter.
//!
//! Each adapter builds a `DevCommand` that runs the project's own dev
//! server with RootRay's instrumentation injected in memory — nothing is
//! written to the user's project beyond a session-scoped scratch dir under
//! `node_modules/.cache/` (removed on stop; swept on next launch if a
//! crash left one behind).

use std::path::{Path, PathBuf};

use crate::inspector::SessionInfo;
use crate::launcher::find_executable_on_path;
use crate::project::{DevCommand, Framework, ProjectTarget};

/// On-disk assets the adapters need (bundled JS, not user files).
#[derive(Debug, Clone)]
pub struct InspectorAssets {
    pub runner: PathBuf,
    pub plugin: PathBuf,
    pub runtime: PathBuf,
    /// `next-shim.cjs` — `Module._load` hook injected into `next dev`.
    pub next_shim: PathBuf,
    /// `jsx-loader.cjs` — webpack/turbopack-compatible JSX instrumenter.
    pub next_loader: PathBuf,
}

/// Locates the bundled inspector assets.
///
/// Resolution order:
/// 1. `ROOTRAY_RUNNER_PATH` / `ROOTRAY_PLUGIN_PATH` / `ROOTRAY_RUNTIME_PATH`
///    plus `ROOTRAY_NEXT_SHIM_PATH` / `ROOTRAY_NEXT_LOADER_PATH`
///    (a partial override is ignored)
/// 2. `ROOTRAY_INSPECTOR_ASSETS_DIR` — one directory containing all of
///    `runner.cjs`, `plugin.cjs`, `runtime.js`, `next-shim.cjs` and
///    `jsx-loader.cjs`. The Tauri shell sets this to the bundle resource
///    dir, so packaged installs work.
/// 3. the workspace `packages/` directory relative to the crate — the
///    development path.
pub fn resolve_assets() -> Option<InspectorAssets> {
    if let (Ok(r), Ok(p), Ok(t), Ok(s), Ok(l)) = (
        std::env::var("ROOTRAY_RUNNER_PATH"),
        std::env::var("ROOTRAY_PLUGIN_PATH"),
        std::env::var("ROOTRAY_RUNTIME_PATH"),
        std::env::var("ROOTRAY_NEXT_SHIM_PATH"),
        std::env::var("ROOTRAY_NEXT_LOADER_PATH"),
    ) {
        let a = normalize(InspectorAssets {
            runner: PathBuf::from(r),
            plugin: PathBuf::from(p),
            runtime: PathBuf::from(t),
            next_shim: PathBuf::from(s),
            next_loader: PathBuf::from(l),
        });
        if a.runner.is_file()
            && a.plugin.is_file()
            && a.runtime.is_file()
            && a.next_shim.is_file()
            && a.next_loader.is_file()
        {
            return Some(a);
        }
    }

    if let Ok(dir) = std::env::var("ROOTRAY_INSPECTOR_ASSETS_DIR") {
        let dir = crate::filesystem::strip_verbatim_pub(&PathBuf::from(dir));
        let a = InspectorAssets {
            runner: dir.join("runner.cjs"),
            plugin: dir.join("plugin.cjs"),
            runtime: dir.join("runtime.js"),
            next_shim: dir.join("next-shim.cjs"),
            next_loader: dir.join("jsx-loader.cjs"),
        };
        if a.runner.is_file()
            && a.plugin.is_file()
            && a.runtime.is_file()
            && a.next_shim.is_file()
            && a.next_loader.is_file()
        {
            return Some(a);
        }
    }

    let packages = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages");
    let a = normalize(InspectorAssets {
        runner: packages.join("vite-plugin/dist/runner.cjs"),
        plugin: packages.join("vite-plugin/dist/plugin.cjs"),
        runtime: packages.join("inspector-runtime/dist/runtime.js"),
        next_shim: packages.join("next-adapter/dist/next-shim.cjs"),
        next_loader: packages.join("next-adapter/dist/jsx-loader.cjs"),
    });
    (a.runner.is_file()
        && a.plugin.is_file()
        && a.runtime.is_file()
        && a.next_shim.is_file()
        && a.next_loader.is_file())
    .then_some(a)
}

/// Asset paths are handed to Node verbatim — the `\\?\` prefix Windows
/// canonicalization adds (e.g. Tauri's `resource_dir()`) is rejected by
/// Node's module loader, so it is stripped before the paths leave Rust.
fn normalize(a: InspectorAssets) -> InspectorAssets {
    InspectorAssets {
        runner: crate::filesystem::strip_verbatim_pub(&a.runner),
        plugin: crate::filesystem::strip_verbatim_pub(&a.plugin),
        runtime: crate::filesystem::strip_verbatim_pub(&a.runtime),
        next_shim: crate::filesystem::strip_verbatim_pub(&a.next_shim),
        next_loader: crate::filesystem::strip_verbatim_pub(&a.next_loader),
    }
}

/// Session credentials handed to the dev command via environment.
pub type InspectorLaunchInfo = SessionInfo;

/// A runtime inspector adapter for one supported framework.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectorAdapter {
    ViteReact,
    /// Vite without React — generic DOM inspection: authored index.html
    /// elements map to source, runtime-created DOM stays inspectable
    /// without a mapping.
    ViteGeneric,
    NextJs,
}

impl InspectorAdapter {
    /// The adapter that can inspect this framework, if one exists.
    /// The start path asks this instead of matching on framework names —
    /// adding an adapter extends inspector support without touching the
    /// launch flow.
    pub fn for_framework(framework: &Framework) -> Option<Self> {
        match framework {
            Framework::ViteReact => Some(Self::ViteReact),
            Framework::Vite => Some(Self::ViteGeneric),
            Framework::NextJs => Some(Self::NextJs),
            _ => None,
        }
    }

    /// Builds the instrumented dev command. `Err` carries a factual reason
    /// the inspector cannot launch (caller runs the plain dev server and
    /// reports the reason).
    pub fn dev_command(
        &self,
        target: &ProjectTarget,
        info: &InspectorLaunchInfo,
        assets: &InspectorAssets,
    ) -> Result<(DevCommand, LaunchArtifacts), String> {
        match self {
            Self::ViteReact => vite_dev_command(target, info, assets, "jsx-meta")
                .map(|c| (c, LaunchArtifacts::default())),
            Self::ViteGeneric => vite_dev_command(target, info, assets, "generic-dom")
                .map(|c| (c, LaunchArtifacts::default())),
            Self::NextJs => next_dev_command(target, info, assets),
        }
    }
}

/// Filesystem artifacts an instrumented launch created:
/// - `scratch` — session dirs removed entirely on session end.
/// - `stubs` — stable-path files (like the Next session entry) that are
///   rewritten to an inert stub on session end rather than deleted, so
///   stale bundler-cache imports still resolve.
#[derive(Debug, Default)]
pub struct LaunchArtifacts {
    pub scratch: Vec<PathBuf>,
    pub stubs: Vec<PathBuf>,
}

/// Builds the inspector-enabled dev command.
/// `Ok(None)` — no adapter exists for this framework (silent fallback).
/// `Err(reason)` — an adapter exists but cannot launch it (reported).
/// `LaunchArtifacts` is returned alongside so the session manager can
/// unwind adapter-owned temp files on stop.
pub fn inspector_dev_command(
    target: &ProjectTarget,
    info: &InspectorLaunchInfo,
    assets: &InspectorAssets,
) -> Result<Option<(DevCommand, LaunchArtifacts)>, String> {
    match InspectorAdapter::for_framework(&target.framework) {
        Some(adapter) => adapter.dev_command(target, info, assets).map(Some),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Vite React adapter
// ---------------------------------------------------------------------------

/// Extracts the safe subset of `vite` CLI arguments from a dev script.
///
/// Only a plain `vite [...]` invocation is inspector-compatible; anything
/// more exotic (`concurrently`, `cross-env`, chained commands) returns
/// `None` so the caller falls back to the normal runner.
pub fn vite_args_from_dev_script(script: &str) -> Option<Vec<String>> {
    let mut tokens = script.split_whitespace().peekable();
    if tokens.next()? != "vite" {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    while let Some(arg) = tokens.next() {
        match arg {
            "--strictPort" | "--force" | "--cors" | "--clearScreen" => {
                out.push(arg.to_string())
            }
            "--host" | "--port" | "--mode" => {
                match tokens.peek() {
                    Some(v) if !v.starts_with("--") => {
                        out.push(arg.to_string());
                        out.push(tokens.next().unwrap().to_string());
                    }
                    // bare `--host` is legal (equivalent to --host true)
                    _ if arg == "--host" => out.push(arg.to_string()),
                    _ => return None,
                }
            }
            // `--open` would pop a second browser — RootRay opens it itself.
            "--open" => {
                if tokens.peek().is_some_and(|v| !v.starts_with("--")) {
                    tokens.next();
                }
            }
            _ if arg.starts_with("--host=")
                || arg.starts_with("--port=")
                || arg.starts_with("--mode=") =>
            {
                out.push(arg.to_string())
            }
            _ => return None,
        }
    }
    Some(out)
}

fn vite_dev_command(
    target: &ProjectTarget,
    info: &InspectorLaunchInfo,
    assets: &InspectorAssets,
    mode: &str,
) -> Result<DevCommand, String> {
    let script = target.dev_script.as_deref().unwrap_or("");
    let vite_args = vite_args_from_dev_script(script)
        .ok_or_else(|| "dev script is not a plain `vite` invocation".to_string())?;
    let node = find_executable_on_path("node")
        .ok_or_else(|| "node is not on PATH".to_string())?;

    let mut args = vec![
        assets.runner.to_string_lossy().to_string(),
        "--root".to_string(),
        target.absolute_root.to_string_lossy().to_string(),
    ];
    args.extend(vite_args);

    let env = vec![
        (
            "ROOTRAY_PROJECT_ROOT".into(),
            target.absolute_root.to_string_lossy().to_string(),
        ),
        ("ROOTRAY_BRIDGE_URL".into(), format!("ws://127.0.0.1:{}/rootray", info.port)),
        ("ROOTRAY_SESSION_ID".into(), info.session_id.clone()),
        ("ROOTRAY_SESSION_TOKEN".into(), info.token.clone()),
        ("ROOTRAY_PLUGIN_PATH".into(), assets.plugin.to_string_lossy().to_string()),
        ("ROOTRAY_RUNTIME_PATH".into(), assets.runtime.to_string_lossy().to_string()),
        ("ROOTRAY_INSPECTOR_MODE".into(), mode.to_string()),
    ];

    Ok(DevCommand {
        executable: node.to_string_lossy().to_string(),
        args,
        display: "vite (RootRay inspector)".to_string(),
        cwd: target.absolute_root.clone(),
        env,
    })
}

// ---------------------------------------------------------------------------
// Next.js adapter
// ---------------------------------------------------------------------------

/// Next dev-script flags RootRay understands and can preserve.
///
/// Anything beyond this set (chained commands, env wrappers, unknown
/// flags) makes the script unsafe to reconstruct → `Err` with the flag
/// named, and the caller falls back to a plain (uninspected) run.
pub fn next_dev_args_from_script(script: &str) -> Result<Vec<String>, String> {
    let mut tokens = script.split_whitespace().peekable();
    match (tokens.next(), tokens.next()) {
        (Some("next"), Some("dev")) => {}
        _ => {
            return Err("dev script is not a plain `next dev` invocation".to_string());
        }
    }
    let mut out: Vec<String> = Vec::new();
    while let Some(arg) = tokens.next() {
        match arg {
            "--turbopack" | "--turbo" | "--webpack" => out.push(arg.to_string()),
            "-p" | "--port" | "-H" | "--hostname" => {
                match tokens.peek() {
                    Some(v) if !v.starts_with('-') => {
                        out.push(arg.to_string());
                        out.push(tokens.next().unwrap().to_string());
                    }
                    _ => return Err(format!("{arg} requires a value")),
                }
            }
            _ if arg.starts_with("--port=") || arg.starts_with("--hostname=") => {
                out.push(arg.to_string())
            }
            _ => return Err(format!("unsupported next dev flag: {arg}")),
        }
    }
    Ok(out)
}

/// Locates `node_modules/next/dist/bin/next` for the target — its own
/// node_modules first, then ancestors up to the workspace root (monorepo
/// hoisting). No result means dependencies are not installed.
fn find_next_bin(target_root: &Path, workspace_root: &Path) -> Option<PathBuf> {
    let mut dir = Some(target_root);
    while let Some(d) = dir {
        let bin = d.join("node_modules/next/dist/bin/next");
        if bin.is_file() {
            return Some(crate::filesystem::strip_verbatim_pub(&bin));
        }
        if d == workspace_root {
            break;
        }
        dir = d.parent();
    }
    None
}

/// Stable path of the generated inspector entry module:
/// `<nm>/.cache/rootray/entry.js` — inside the target's own
/// `node_modules/.cache/` (the conventional, gitignored tool-cache
/// location that is always inside the bundler root).
///
/// The path deliberately carries *no* session id: bundler persistent
/// caches (webpack `.next/cache`, turbopack FS cache) outlive a session,
/// and a cached instrumented module would otherwise import a deleted
/// `rootray-<sid>` entry — breaking even a later *unshimmed* `next dev`.
/// A fixed path always resolves; RootRay rewrites it per session and
/// leaves an inert stub behind on stop.
fn next_entry_path(next_bin: &Path) -> PathBuf {
    // <nm>/next/dist/bin/next → ancestors: self(file), bin, dist, next, <nm>
    let nm = next_bin
        .ancestors()
        .nth(4)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("node_modules"));
    nm.join(".cache").join("rootray").join("entry.js")
}

/// Inert module left behind in place of the session entry on stop —
/// keeps stale bundler-cache imports resolvable without booting a
/// runtime against a dead bridge.
pub(crate) const NEXT_ENTRY_STUB: &str =
    "if (typeof window !== \"undefined\") { /* rootray: inspector session ended */ }\n";

/// Removes stale `rootray-*` scratch dirs left behind by crashed sessions.
fn sweep_stale_scratch(cache_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p != keep
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rootray-"))
        {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

/// Writes the session entry module: sets `window.__ROOTRAY__` then runs
/// the bundled inspector runtime, guarded so it is a no-op in the
/// server/edge module graphs where `window` does not exist.
fn write_next_entry(
    entry: &Path,
    info: &InspectorLaunchInfo,
    assets: &InspectorAssets,
) -> Result<PathBuf, String> {
    let runtime = std::fs::read_to_string(&assets.runtime)
        .map_err(|e| format!("cannot read inspector runtime bundle: {e}"))?;
    let config = serde_json::json!({
        "bridgeUrl": format!("ws://127.0.0.1:{}/rootray", info.port),
        "sessionId": info.session_id,
        "token": info.token,
        "version": crate::inspector::protocol::PROTOCOL_VERSION,
        "projectRoot": info
            .target_root
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        // Next always uses JSX metadata picking — the shim instruments
        // every JSX module, and the runtime resolves via nearest
        // instrumented ancestor.
        "mode": "jsx-meta",
    });
    let body = format!(
        "if (typeof window !== \"undefined\") {{\nwindow.__ROOTRAY__={};\n{}}}\n",
        config, runtime
    );
    if let Some(dir) = entry.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create entry dir: {e}"))?;
    }
    std::fs::write(entry, body).map_err(|e| format!("cannot write session entry: {e}"))?;
    Ok(entry.to_path_buf())
}

fn next_dev_command(
    target: &ProjectTarget,
    info: &InspectorLaunchInfo,
    assets: &InspectorAssets,
) -> Result<(DevCommand, LaunchArtifacts), String> {
    let script = target.dev_script.as_deref().unwrap_or("");
    let next_args = next_dev_args_from_script(script)?;
    let node = find_executable_on_path("node").ok_or_else(|| "node is not on PATH".to_string())?;
    let workspace_root = info
        .workspace_root
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| target.absolute_root.clone());
    let next_bin = find_next_bin(&target.absolute_root, &workspace_root).ok_or_else(|| {
        "next binary not found under node_modules — install project dependencies".to_string()
    })?;

    // Stable entry module (stubbed, not deleted, on session end) + sweep
    // of any legacy session-scoped `rootray-*` dirs in the same cache.
    let entry = next_entry_path(&next_bin);
    if let Some(cache) = entry.parent().and_then(|p| p.parent()) {
        sweep_stale_scratch(cache, Path::new(""));
    }
    let entry = write_next_entry(&entry, info, assets)?;

    // `node -r <shim> <next-bin> dev <args>`: argv `-r` avoids NODE_OPTIONS
    // whitespace splitting (spaces in paths are safe) and confines the
    // hook to the process that loads bundler config.
    let mut args = vec![
        "--require".to_string(),
        assets.next_shim.to_string_lossy().to_string(),
        next_bin.to_string_lossy().to_string(),
        "dev".to_string(),
    ];
    args.extend(next_args);

    let env = vec![
        (
            "ROOTRAY_PROJECT_ROOT".into(),
            target.absolute_root.to_string_lossy().to_string(),
        ),
        (
            "ROOTRAY_NEXT_LOADER".into(),
            assets.next_loader.to_string_lossy().to_string(),
        ),
        ("ROOTRAY_NEXT_ENTRY".into(), entry.to_string_lossy().to_string()),
        ("ROOTRAY_BRIDGE_URL".into(), format!("ws://127.0.0.1:{}/rootray", info.port)),
        ("ROOTRAY_SESSION_ID".into(), info.session_id.clone()),
        ("ROOTRAY_SESSION_TOKEN".into(), info.token.clone()),
    ];

    Ok((
        DevCommand {
            executable: node.to_string_lossy().to_string(),
            args,
            display: "next dev (RootRay inspector)".to_string(),
            cwd: target.absolute_root.clone(),
            env,
        },
        LaunchArtifacts {
            scratch: Vec::new(),
            stubs: vec![entry],
        },
    ))
}
