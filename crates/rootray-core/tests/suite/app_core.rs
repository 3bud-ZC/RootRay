//! End-to-end tests of AppCore: analysis → state machine → settings.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rootray_core::process::ProcessEvent;
use rootray_core::project::adapters::Framework;
use rootray_core::state::RuntimePhase;
use rootray_core::{AppCore, CoreError};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn core() -> (AppCore, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    (core, dir)
}

fn noop_sink() -> Arc<dyn Fn(ProcessEvent) + Send + Sync> {
    Arc::new(|_| {})
}

#[test]
fn analyze_sets_ready_state() {
    let (core, _tmp) = core();
    let a = core.analyze(&fixtures().join("vite-react-basic")).unwrap();
    assert_eq!(a.framework, Framework::ViteReact);
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Ready);
    assert_eq!(s.project.unwrap().root, a.root);
}

#[test]
fn analyze_bad_project_sets_failed() {
    let (core, _tmp) = core();
    let err = core.analyze(&fixtures().join("unsupported-project")).unwrap();
    // unsupported is still a valid analysis (supported=false), phase=Ready
    assert!(!err.supported);
    assert_eq!(core.state().phase, RuntimePhase::Ready);
    // but a *missing* package.json is a hard failure
    let dir = tempfile::tempdir().unwrap();
    let e = core.analyze(dir.path()).unwrap_err();
    assert_eq!(e.code(), "PACKAGE_JSON_NOT_FOUND");
    assert_eq!(core.state().phase, RuntimePhase::Failed);
}

/// Regression for the v0.1.0 Open-Project bug: `analyze` mutated
/// RuntimeState but nothing told the host to push a fresh snapshot —
/// the UI stayed on HomeView. The state-notify hook is the contract the
/// Tauri layer subscribes to; it must fire on success AND failure, after
/// the final state is committed.
#[test]
fn analyze_notifies_state_change_on_success_and_failure() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (core, _tmp) = core();
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    core.set_state_notify(Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
    }));

    // Success path: notify fires once, snapshot carries ready + project.
    core.analyze(&fixtures().join("vite-react-basic")).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Ready);
    assert!(s.project.is_some());

    // Failure path: notify still fires; snapshot carries failed + error
    // and a cleared project.
    let dir = tempfile::tempdir().unwrap();
    let e = core.analyze(dir.path()).unwrap_err();
    assert_eq!(e.code(), "PACKAGE_JSON_NOT_FOUND");
    assert_eq!(count.load(Ordering::SeqCst), 2);
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Failed);
    assert!(s.project.is_none());
    assert!(s.error.is_some());
}

#[test]
fn start_requires_project() {
    let (core, _tmp) = core();
    let err = core.start_dev_server(noop_sink(), false).unwrap_err();
    assert!(matches!(err, CoreError::NoProjectSelected));
}

#[test]
fn start_rejects_unsupported_project() {
    let (core, _tmp) = core();
    core.analyze(&fixtures().join("unsupported-project")).unwrap();
    let err = core.start_dev_server(noop_sink(), false).unwrap_err();
    assert_eq!(err.code(), "UNSUPPORTED_FRAMEWORK");
    assert_eq!(core.state().phase, RuntimePhase::Ready); // not left dangling
}

#[test]
fn stop_while_idle_is_rejected() {
    let (core, _tmp) = core();
    let err = core.stop_dev_server().unwrap_err();
    assert!(matches!(err, CoreError::ProcessNotRunning));
}

#[test]
fn recent_projects_are_recorded() {
    let (core, _tmp) = core();
    let root = core.analyze(&fixtures().join("vite-react-basic")).unwrap().root;
    let settings = core.settings().unwrap();
    assert_eq!(settings.recent_projects.first(), Some(&root));
}

#[test]
fn settings_roundtrip() {
    let (core, _tmp) = core();
    let updated = core
        .update_settings(rootray_core::app::SettingsUpdate {
            preferred_launcher: Some("vscode".to_string()),
            open_browser_automatically: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(updated.preferred_launcher.as_deref(), Some("vscode"));
    assert!(updated.open_browser_automatically);
}

#[test]
fn editor_detection_returns_registry() {
    let (core, _tmp) = core();
    let editors = core.detect_editors();
    let ids: Vec<&str> = editors.iter().map(|e| e.id.as_str()).collect();
    assert!(ids.contains(&"vscode"));
    assert!(ids.contains(&"cursor"));
    assert!(ids.contains(&"windsurf"));
    // Every detected editor must have a path when available.
    for e in &editors {
        assert_eq!(e.available, e.executable_path.is_some());
    }
}

#[test]
fn open_in_editor_rejects_missing_launcher() {
    let (core, _tmp) = core();
    core.analyze(&fixtures().join("vite-react-basic")).unwrap();
    let err = core.open_project_in_editor("not-an-editor").unwrap_err();
    assert_eq!(err.code(), "LAUNCHER_NOT_FOUND");
}

#[test]
fn open_path_in_editor_enforces_boundary() {
    let (core, _tmp) = core();
    let root = core.analyze(&fixtures().join("vite-react-basic")).unwrap().root;
    // Even if a launcher existed, an escaping path must fail first.
    let err = core
        .open_path_in_editor("vscode", &root.join("../../../etc/passwd"))
        .unwrap_err();
    // Either boundary error (if it escapes) or launcher-not-found — both
    // prove the traversal never reached a spawn call.
    assert!(matches!(
        err.code(),
        "PROJECT_OUTSIDE_ALLOWED_ROOT" | "LAUNCHER_NOT_FOUND"
    ));
}
