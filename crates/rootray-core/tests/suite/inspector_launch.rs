//! Inspector launch-path, source-preview and editor-location tests.

use std::path::Path;

use rootray_core::filesystem::preview::read_source_preview;
use rootray_core::inspector::launch::vite_args_from_dev_script;
use rootray_core::launcher::location_args;
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

/// `resolve_assets` feeds its paths to Node — as a script argument and via
/// `ROOTRAY_*_PATH` env vars. Tauri's `resource_dir()` canonicalizes, so on
/// Windows the assets dir arrives `\\?\`-verbatim; Node rejects verbatim
/// script paths (`lstat 'C:'` / "Cannot find module"), so the prefix must
/// be stripped before paths leave Rust.
#[cfg(windows)]
#[test]
fn resolve_assets_strips_windows_verbatim_prefix() {
    let dir = tempfile::tempdir().unwrap();
    for f in ["runner.cjs", "plugin.cjs", "runtime.js"] {
        std::fs::write(dir.path().join(f), b"x").unwrap();
    }
    // canonicalize() produces `\\?\C:\...` — the shape resource_dir() returns.
    let verbatim = dir.path().canonicalize().unwrap();
    assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
    for k in ["ROOTRAY_RUNNER_PATH", "ROOTRAY_PLUGIN_PATH", "ROOTRAY_RUNTIME_PATH"] {
        std::env::remove_var(k);
    }
    std::env::set_var("ROOTRAY_INSPECTOR_ASSETS_DIR", &verbatim);
    let assets = rootray_core::inspector::resolve_assets().unwrap();
    std::env::remove_var("ROOTRAY_INSPECTOR_ASSETS_DIR");
    for p in [&assets.runner, &assets.plugin, &assets.runtime] {
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
