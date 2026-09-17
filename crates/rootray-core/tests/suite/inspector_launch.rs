//! Inspector launch-path, source-preview and editor-location tests.

use std::path::{Path, PathBuf};

use rootray_core::filesystem::preview::read_source_preview;
use rootray_core::inspector::launch::{
    next_dev_args_from_script, vite_args_from_dev_script, InspectorAdapter,
};
use rootray_core::inspector::SessionInfo;
use rootray_core::launcher::location_args;
use rootray_core::project::{Framework, ProjectTarget, TargetKind};
use rootray_core::{AppCore, CoreError};

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

#[test]
fn vite_script_args_are_extracted() {
    assert_eq!(vite_args_from_dev_script("vite"), Some(vec![]));
    assert_eq!(
        vite_args_from_dev_script("vite --host"),
        Some(vec!["--host".to_string()])
    );
    assert_eq!(
        vite_args_from_dev_script("vite --port 3000 --strictPort"),
        Some(vec!["--port".into(), "3000".into(), "--strictPort".into()])
    );
    assert_eq!(
        vite_args_from_dev_script("vite --mode staging --force"),
        Some(vec!["--mode".into(), "staging".into(), "--force".into()])
    );
    // --open is dropped — RootRay controls the browser itself.
    assert_eq!(vite_args_from_dev_script("vite --open"), Some(vec![]));
    // Non-plain-vite scripts are not inspector-compatible.
    assert_eq!(vite_args_from_dev_script("concurrently \"vite\" \"tsc\""), None);
    assert_eq!(vite_args_from_dev_script("vite build"), None);
    assert_eq!(vite_args_from_dev_script("cross-env X=1 vite"), None);
    assert_eq!(vite_args_from_dev_script("vite --unknown-flag"), None);
}

// ---------------------------------------------------------------------------
// Next.js adapter
// ---------------------------------------------------------------------------

#[test]
fn next_script_args_cover_supported_forms() {
    assert_eq!(next_dev_args_from_script("next dev"), Ok(vec![]));
    assert_eq!(
        next_dev_args_from_script("next dev --turbopack"),
        Ok(vec!["--turbopack".to_string()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev --turbo"),
        Ok(vec!["--turbo".to_string()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev --webpack"),
        Ok(vec!["--webpack".to_string()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev -p 3001"),
        Ok(vec!["-p".into(), "3001".into()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev --port 3001"),
        Ok(vec!["--port".into(), "3001".into()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev --port=3001"),
        Ok(vec!["--port=3001".into()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev -H 127.0.0.1"),
        Ok(vec!["-H".into(), "127.0.0.1".into()])
    );
    assert_eq!(
        next_dev_args_from_script("next dev --hostname localhost"),
        Ok(vec!["--hostname".into(), "localhost".into()])
    );
}

#[test]
fn next_script_args_reject_unsafe_forms() {
    for bad in [
        "next build",
        "next start",
        "cross-env FOO=1 next dev",
        "next dev && echo done",
        "next dev || exit 1",
        "concurrently \"next dev\" \"tsc -w\"",
        "next dev --unknown-flag",
        "next dev -p",
        "npm run dev",
        "",
    ] {
        assert!(
            next_dev_args_from_script(bad).is_err(),
            "expected rejection: {bad:?}"
        );
    }
}

fn test_target(root: &Path, framework: Framework, dev_script: &str) -> ProjectTarget {
    ProjectTarget {
        id: "root".into(),
        name: Some("t".into()),
        relative_root: String::new(),
        absolute_root: root.to_path_buf(),
        kind: TargetKind::WebApp,
        framework,
        framework_version: None,
        languages: vec![],
        technologies: vec![],
        package_manager: rootray_core::project::package_manager::PackageManager::Npm,
        dev_script: Some(dev_script.to_string()),
        runner_candidates: vec![],
        selected_runner: None,
        capabilities: rootray_core::project::CapabilityMatrix::universal(),
        evidence: vec![],
    }
}

fn test_info(port: u16, target_root: &Path, workspace_root: &Path) -> SessionInfo {
    SessionInfo {
        session_id: "rs-test".into(),
        token: "tok".into(),
        port,
        target_root: Some(target_root.to_path_buf()),
        workspace_root: Some(workspace_root.to_path_buf()),
    }
}

fn test_assets(root: &Path) -> rootray_core::inspector::InspectorAssets {
    let mk = |name: &str| {
        let p = root.join(name);
        std::fs::write(&p, b"// stub\n").unwrap();
        p
    };
    rootray_core::inspector::InspectorAssets {
        runner: mk("runner.cjs"),
        plugin: mk("plugin.cjs"),
        runtime: mk("runtime.js"),
        next_shim: mk("next-shim.cjs"),
        next_loader: mk("jsx-loader.cjs"),
    }
}

#[test]
fn adapter_selection_is_framework_aware() {
    assert_eq!(
        InspectorAdapter::for_framework(&Framework::ViteReact),
        Some(InspectorAdapter::ViteReact)
    );
    assert_eq!(
        InspectorAdapter::for_framework(&Framework::NextJs),
        Some(InspectorAdapter::NextJs)
    );
    // Non-React Vite gets the generic DOM adapter — HTML instrumentation
    // only, no JSX stamping requirement.
    assert_eq!(
        InspectorAdapter::for_framework(&Framework::Vite),
        Some(InspectorAdapter::ViteGeneric)
    );
    for f in [Framework::StaticWeb, Framework::NodeWeb, Framework::Unknown] {
        assert_eq!(InspectorAdapter::for_framework(&f), None, "{f:?}");
    }
}

/// Builds a minimal fake next install: `<root>/node_modules/next/dist/bin/next`.
fn fake_next(root: &Path) -> PathBuf {
    let bin = root.join("node_modules/next/dist/bin/next");
    std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
    std::fs::write(&bin, "#!/usr/bin/env node\n").unwrap();
    bin
}

#[test]
fn next_adapter_builds_shimmed_dev_command() {
    let tmp = tempfile::tempdir().unwrap();
    let target_root = tmp.path().join("app");
    std::fs::create_dir_all(&target_root).unwrap();
    let bin = fake_next(&target_root);
    let assets = test_assets(tmp.path());
    let info = test_info(43210, &target_root, tmp.path());
    let target = test_target(&target_root, Framework::NextJs, "next dev --webpack -p 3010");

    let (cmd, artifacts) = InspectorAdapter::NextJs
        .dev_command(&target, &info, &assets)
        .expect("next adapter command");

    // node -r <shim> <next-bin> dev <args>
    assert!(
        cmd.executable.to_ascii_lowercase().ends_with("node.exe")
            || cmd.executable.to_ascii_lowercase().ends_with("node"),
        "executable was {}",
        cmd.executable
    );
    assert_eq!(cmd.args[0], "--require");
    assert_eq!(cmd.args[1], assets.next_shim.to_string_lossy());
    assert_eq!(cmd.args[2], bin.to_string_lossy());
    assert_eq!(cmd.args[3], "dev");
    assert_eq!(cmd.args[4..], ["--webpack", "-p", "3010"]);
    assert_eq!(cmd.cwd, target_root);
    assert!(!cmd_env(&cmd, "ROOTRAY_NEXT_ENTRY").is_empty());
    assert!(!cmd_env(&cmd, "ROOTRAY_NEXT_LOADER").is_empty());
    assert_eq!(cmd_env(&cmd, "ROOTRAY_SESSION_ID"), "rs-test");
    let entry = PathBuf::from(cmd_env(&cmd, "ROOTRAY_NEXT_ENTRY"));
    // Stable entry path — no session id — inside node_modules/.cache/rootray/
    assert_eq!(entry, target_root.join("node_modules/.cache/rootray/entry.js"));
    assert!(entry.is_file());
    // The entry sets window.__ROOTRAY__ and inlines the runtime.
    let body = std::fs::read_to_string(&entry).unwrap();
    assert!(body.contains("window.__ROOTRAY__"));
    assert!(body.contains("rs-test"));
    assert!(body.contains("ws://127.0.0.1:43210/rootray"));
    assert!(body.contains("typeof window"));
    // Entry is a stable path under the target's own
    // node_modules/.cache/rootray/ — no session id, never inside the
    // `next` package dir (which may be a junction into a shared pnpm
    // store). Registered as a stub: rewritten in place on session end so
    // stale bundler-cache imports keep resolving.
    assert!(artifacts.scratch.is_empty());
    assert_eq!(
        artifacts.stubs,
        [target_root.join("node_modules/.cache/rootray/entry.js")]
    );
    assert!(artifacts.stubs[0].is_file());
}

fn cmd_env(cmd: &rootray_core::project::DevCommand, key: &str) -> String {
    cmd.env
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

#[test]
fn next_adapter_finds_hoisted_bin_and_uses_target_cwd() {
    // Nested monorepo: next installed at the workspace root, target is
    // apps/web. cwd must stay the target root; the bin resolves upward.
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let target_root = ws.join("apps/web");
    std::fs::create_dir_all(&target_root).unwrap();
    fake_next(ws);
    let assets = test_assets(tmp.path());
    let info = test_info(43210, &target_root, ws);
    let target = test_target(&target_root, Framework::NextJs, "next dev");

    let (cmd, artifacts) = InspectorAdapter::NextJs
        .dev_command(&target, &info, &assets)
        .unwrap();
    assert_eq!(cmd.cwd, target_root);
    assert!(cmd.args[2].contains("node_modules"));
    // Entry lives under the hoisted node_modules — inside the turbopack
    // root, which is the workspace root here.
    assert_eq!(
        artifacts.stubs,
        [ws.join("node_modules/.cache/rootray/entry.js")]
    );
}

#[test]
fn next_adapter_rejects_missing_next_install() {
    let tmp = tempfile::tempdir().unwrap();
    let target_root = tmp.path().join("app");
    std::fs::create_dir_all(&target_root).unwrap();
    let assets = test_assets(tmp.path());
    let info = test_info(43210, &target_root, tmp.path());
    let target = test_target(&target_root, Framework::NextJs, "next dev");
    let err = InspectorAdapter::NextJs
        .dev_command(&target, &info, &assets)
        .unwrap_err();
    assert!(err.contains("next binary not found"), "{err}");
}

#[test]
fn next_adapter_rejects_complex_scripts_with_reason() {
    let tmp = tempfile::tempdir().unwrap();
    let target_root = tmp.path().join("app");
    std::fs::create_dir_all(&target_root).unwrap();
    fake_next(&target_root);
    let assets = test_assets(tmp.path());
    let info = test_info(43210, &target_root, tmp.path());
    let target = test_target(&target_root, Framework::NextJs, "cross-env X=1 next dev");
    let err = InspectorAdapter::NextJs
        .dev_command(&target, &info, &assets)
        .unwrap_err();
    assert!(err.contains("next dev"), "{err}");
}

#[test]
fn scratch_cleanup_removes_only_rootray_dirs() {
    use rootray_core::inspector::InspectorManager;
    let tmp = tempfile::tempdir().unwrap();
    let cache = tmp.path().join("node_modules/.cache");
    let ours = cache.join("rootray-sess1");
    let foreign = cache.join("babel-cache");
    std::fs::create_dir_all(&ours).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(ours.join("entry.js"), "x").unwrap();
    std::fs::write(foreign.join("keep.js"), "x").unwrap();

    let mgr = InspectorManager::new();
    mgr.register_scratch(vec![ours.clone(), foreign.clone()]);
    mgr.shutdown();
    assert!(!ours.exists(), "session scratch must be removed");
    assert!(
        foreign.exists(),
        "non-rootray dirs must never be deleted by cleanup"
    );
}

#[test]
fn entry_stubs_are_rewritten_in_place_never_deleted() {
    use rootray_core::inspector::InspectorManager;
    let tmp = tempfile::tempdir().unwrap();
    let entry = tmp.path().join("node_modules/.cache/rootray/entry.js");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "window.__ROOTRAY__={live:true}").unwrap();
    // A path outside the `rootray/` convention must never be written to.
    let foreign = tmp.path().join("node_modules/.cache/other/entry.js");
    std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    std::fs::write(&foreign, "keep").unwrap();

    let mgr = InspectorManager::new();
    mgr.register_entry_stubs(vec![entry.clone(), foreign.clone()]);
    mgr.shutdown();

    assert!(entry.exists(), "stable entry must remain on disk");
    let body = std::fs::read_to_string(&entry).unwrap();
    assert!(body.contains("session ended"), "stub body: {body}");
    assert!(!body.contains("__ROOTRAY__="));
    assert_eq!(std::fs::read_to_string(&foreign).unwrap(), "keep");
}

/// `resolve_assets` feeds its paths to Node — as a script argument and via
/// `ROOTRAY_*_PATH` env vars. Tauri's `resource_dir()` canonicalizes, so on
/// Windows the assets dir arrives `\\?\`-verbatim; Node rejects verbatim
/// script paths (`lstat 'C:'` / "Cannot find module"), so the prefix must
/// be stripped before paths leave Rust.
#[cfg(windows)]
#[test]
fn resolve_assets_strips_windows_verbatim_prefix() {
    let dir = tempfile::tempdir().unwrap();
    for f in ["runner.cjs", "plugin.cjs", "runtime.js", "next-shim.cjs", "jsx-loader.cjs"] {
        std::fs::write(dir.path().join(f), b"x").unwrap();
    }
    // canonicalize() produces `\\?\C:\...` — the shape resource_dir() returns.
    let verbatim = dir.path().canonicalize().unwrap();
    assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
    for k in [
        "ROOTRAY_RUNNER_PATH",
        "ROOTRAY_PLUGIN_PATH",
        "ROOTRAY_RUNTIME_PATH",
        "ROOTRAY_NEXT_SHIM_PATH",
        "ROOTRAY_NEXT_LOADER_PATH",
    ] {
        std::env::remove_var(k);
    }
    std::env::set_var("ROOTRAY_INSPECTOR_ASSETS_DIR", &verbatim);
    let assets = rootray_core::inspector::resolve_assets().unwrap();
    std::env::remove_var("ROOTRAY_INSPECTOR_ASSETS_DIR");
    for p in [
        &assets.runner,
        &assets.plugin,
        &assets.runtime,
        &assets.next_shim,
        &assets.next_loader,
    ] {
        assert!(
            !p.to_string_lossy().starts_with(r"\\?\"),
            "verbatim path leaked to Node boundary: {p:?}"
        );
        assert!(p.is_file());
    }
}

#[test]
fn preview_reads_lines_around_selection() {
    let root = fixtures().join("vite-react-typescript");
    let preview = read_source_preview(&root, "src/App.tsx", 5).unwrap();
    assert_eq!(preview.selected_line, 5);
    assert!(preview.start_line <= 5 && preview.end_line >= 5);
    assert!(!preview.lines.is_empty());
    assert_eq!(preview.lines[0].n, preview.start_line);
    assert_eq!(preview.lines.last().unwrap().n, preview.end_line);
    assert!(preview.lines.iter().any(|l| l.text.contains("RootRay Fixture")));
}

#[test]
fn preview_clamps_to_file_bounds() {
    let root = fixtures().join("vite-react-typescript");
    let preview = read_source_preview(&root, "src/App.tsx", 2).unwrap();
    assert_eq!(preview.start_line, 1);
    // Beyond EOF → clamps to total.
    let far = read_source_preview(&root, "src/App.tsx", 99999).unwrap();
    assert!(far.end_line >= far.selected_line);
}

#[test]
fn preview_rejects_traversal_and_absolute_paths() {
    let root = fixtures().join("vite-react-typescript");
    for bad in ["../secret.txt", "..\\secret.txt", "C:/Windows/win.ini", "/etc/passwd", "src/../../x"] {
        assert!(
            read_source_preview(&root, bad, 1).is_err(),
            "expected rejection: {bad}"
        );
    }
}

#[test]
fn preview_rejects_sensitive_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(".env"), "SECRET=hunter2").unwrap();
    std::fs::write(root.path().join(".env.local"), "SECRET=hunter2").unwrap();
    std::fs::write(root.path().join("server.pem"), "KEY").unwrap();
    for f in [".env", ".env.local", "server.pem"] {
        let err = read_source_preview(root.path(), f, 1).unwrap_err();
        assert_eq!(err.code(), "PROJECT_OUTSIDE_ALLOWED_ROOT", "{f}");
    }
}

#[test]
fn preview_rejects_missing_and_outside_root() {
    let root = tempfile::tempdir().unwrap();
    let err = read_source_preview(root.path(), "src/nope.tsx", 1).unwrap_err();
    assert!(
        matches!(
            err,
            CoreError::ProjectOutsideAllowedRoot(_) | CoreError::InspectorSourceNotFound(_)
        ),
        "{err:?}"
    );
}

#[test]
fn location_args_use_goto_line_column() {
    let args = location_args(Path::new("C:\\proj\\src\\App.tsx"), 12, 9);
    assert_eq!(args[0], "--goto");
    assert!(args[1].ends_with("App.tsx:12:9"), "{}", args[1]);
}

#[test]
fn source_preview_command_validates_project_root() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    let err = core.read_source_preview("src/App.tsx", 1).unwrap_err();
    assert!(matches!(err, CoreError::NoProjectSelected));
}
