//! Inspector-enabled Vite launch path.
//!
//! Builds a `DevCommand` that runs the RootRay Node runner instead of the
//! package-manager dev script. The runner resolves Vite from the inspected
//! project and merges the RootRay plugin in memory — nothing is written to
//! the user's project.

use std::path::PathBuf;

use crate::inspector::SessionInfo;
use crate::launcher::find_executable_on_path;
use crate::project::{DevCommand, Framework, ProjectTarget};

/// On-disk assets the runner needs (bundled JS, not user files).
#[derive(Debug, Clone)]
pub struct InspectorAssets {
    pub runner: PathBuf,
    pub plugin: PathBuf,
    pub runtime: PathBuf,
}

/// Locates the bundled inspector assets.
///
/// Resolution order:
/// 1. `ROOTRAY_RUNNER_PATH` / `ROOTRAY_PLUGIN_PATH` / `ROOTRAY_RUNTIME_PATH`
///    (all three must be set — a partial override is ignored)
/// 2. `ROOTRAY_INSPECTOR_ASSETS_DIR` — one directory containing
///    `runner.cjs`, `plugin.cjs` and `runtime.js`. The Tauri shell sets
///    this to the bundle resource dir, so packaged installs work.
/// 3. the workspace `packages/` directory relative to the crate — the
///    development path.
pub fn resolve_assets() -> Option<InspectorAssets> {
    if let (Ok(r), Ok(p), Ok(t)) = (
        std::env::var("ROOTRAY_RUNNER_PATH"),
        std::env::var("ROOTRAY_PLUGIN_PATH"),
        std::env::var("ROOTRAY_RUNTIME_PATH"),
    ) {
        let a = normalize(InspectorAssets {
            runner: PathBuf::from(r),
            plugin: PathBuf::from(p),
            runtime: PathBuf::from(t),
        });
        if a.runner.is_file() && a.plugin.is_file() && a.runtime.is_file() {
            return Some(a);
        }
    }

    if let Ok(dir) = std::env::var("ROOTRAY_INSPECTOR_ASSETS_DIR") {
        let dir = crate::filesystem::strip_verbatim_pub(&PathBuf::from(dir));
        let a = InspectorAssets {
            runner: dir.join("runner.cjs"),
            plugin: dir.join("plugin.cjs"),
            runtime: dir.join("runtime.js"),
        };
        if a.runner.is_file() && a.plugin.is_file() && a.runtime.is_file() {
            return Some(a);
        }
    }

    let packages = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages");
    let a = normalize(InspectorAssets {
        runner: packages.join("vite-plugin/dist/runner.cjs"),
        plugin: packages.join("vite-plugin/dist/plugin.cjs"),
        runtime: packages.join("inspector-runtime/dist/runtime.js"),
    });
    (a.runner.is_file() && a.plugin.is_file() && a.runtime.is_file()).then_some(a)
}

/// Asset paths are handed to Node verbatim — the `\\?\` prefix Windows
/// canonicalization adds (e.g. Tauri's `resource_dir()`) is rejected by
/// Node's module loader, so it is stripped before the paths leave Rust.
fn normalize(a: InspectorAssets) -> InspectorAssets {
    InspectorAssets {
        runner: crate::filesystem::strip_verbatim_pub(&a.runner),
        plugin: crate::filesystem::strip_verbatim_pub(&a.plugin),
        runtime: crate::filesystem::strip_verbatim_pub(&a.runtime),
    }
}

/// Session credentials handed to the runner via environment.
pub type InspectorLaunchInfo = SessionInfo;

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

/// Builds the inspector-enabled dev command, or `None` when this target's
/// dev setup is not safely instrumentable (caller falls back gracefully).
pub fn inspector_dev_command(
    target: &ProjectTarget,
    info: &InspectorLaunchInfo,
    assets: &InspectorAssets,
) -> Option<DevCommand> {
    if target.framework != Framework::ViteReact {
        return None;
    }
    let script = target.dev_script.as_ref()?;
    let vite_args = vite_args_from_dev_script(script)?;
    let node = find_executable_on_path("node")?;

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
    ];

    Some(DevCommand {
        executable: node.to_string_lossy().to_string(),
        args,
        display: "vite (RootRay inspector)".to_string(),
        cwd: target.absolute_root.clone(),
        env,
    })
}
