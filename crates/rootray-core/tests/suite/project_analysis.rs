//! Workspace-analysis tests against real fixture files and synthetic
//! temp-dir workspaces.

use std::fs;
use std::path::{Path, PathBuf};

use rootray_core::project::package_manager::PackageManager;
use rootray_core::project::{
    analyze_workspace, CapabilityState, Framework, TargetKind, WorkspaceKind,
};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn vite_pkg(extra: &str) -> String {
    format!(
        r#"{{"name":"tmp","private":true,"scripts":{{"dev":"vite"}},
        "dependencies":{{"react":"^19.0.0","react-dom":"^19.0.0"}},
        "devDependencies":{{"vite":"^7.0.0"}}{extra}}}"#
    )
}

// ---- fixture-based detection -----------------------------------------------

#[test]
fn detects_vite_react_basic_fixture() {
    let a = analyze_workspace(&fixtures_dir().join("vite-react-basic")).unwrap();
    let t = a.active_target().expect("active target");
    assert_eq!(t.framework, Framework::ViteReact);
    assert_eq!(t.package_manager, PackageManager::Npm);
    assert!(t.capabilities.run.is_available());
    assert!(t.capabilities.source_mapping.is_available());
    let cmd = t.selected_runner.as_ref().expect("dev command");
    assert!(cmd.display.contains("npm run dev"));
    assert_eq!(cmd.cwd, t.absolute_root);
    assert!(a.manifests.iter().any(|m| m.ends_with("package.json")));
    // Universal workspace capabilities are always on.
    assert!(a.capabilities.workspace_browse.is_available());
    assert!(a.capabilities.quick_edit.is_available());
}

#[test]
fn detects_vite_react_typescript_fixture() {
    let a = analyze_workspace(&fixtures_dir().join("vite-react-typescript")).unwrap();
    let t = a.active_target().expect("active target");
    assert_eq!(t.framework, Framework::ViteReact);
    assert_eq!(t.package_manager, PackageManager::Pnpm);
    assert!(t.capabilities.run.is_available());
}

#[test]
fn detects_nextjs_fixture_with_version() {
    let a = analyze_workspace(&fixtures_dir().join("nextjs-basic")).unwrap();
    let t = a.active_target().expect("active target");
    assert_eq!(t.framework, Framework::NextJs);
    assert_eq!(t.framework_version.as_deref(), Some("16.2.12"));
    assert_eq!(t.package_manager, PackageManager::Npm);
    assert_eq!(t.dev_script.as_deref(), Some("next dev"));
    let cmd = t.selected_runner.as_ref().expect("next dev runner");
    assert_eq!(cmd.display, "npm run dev");
    // Universal features on; the plain `next dev` script is instrumentable
    // so runtime inspection is available.
    assert!(t.capabilities.workspace_search.is_available());
    assert!(t.capabilities.quick_edit.is_available());
    assert!(t.capabilities.run.is_available());
    assert_eq!(t.capabilities.source_mapping.state, CapabilityState::Available);
    assert!(t.technologies.iter().any(|x| x.name == "React"));
    assert!(t.technologies.iter().any(|x| x.name == "Prisma"));
    assert!(t.technologies.iter().any(|x| x.name == "Tailwind CSS"));
}

#[test]
fn unsupported_fixture_is_a_usable_workspace() {
    // A Node/Express project is no longer "unsupported" — it is a server
    // target with universal workspace capabilities.
    let a = analyze_workspace(&fixtures_dir().join("unsupported-project")).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::SinglePackage);
    let t = a.active_target().expect("active target");
    assert_eq!(t.framework, Framework::NodeWeb);
    assert_eq!(t.kind, TargetKind::Server);
    assert!(t.capabilities.workspace_browse.is_available());
    assert!(t.capabilities.quick_open.is_available());
    assert_eq!(t.package_manager, PackageManager::Yarn); // yarn.lock
    assert_eq!(t.selected_runner.as_ref().unwrap().display, "yarn run start");
}

// ---- package-manager detection ----------------------------------------------

#[test]
fn detects_each_lockfile() {
    for (lock, pm) in [
        ("pnpm-lock.yaml", PackageManager::Pnpm),
        ("package-lock.json", PackageManager::Npm),
        ("yarn.lock", PackageManager::Yarn),
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "package.json", &vite_pkg(""));
        write(dir.path(), lock, "# lockfile\n");
        let a = analyze_workspace(dir.path()).unwrap();
        let t = a.active_target().unwrap();
        assert_eq!(t.package_manager, pm, "lockfile {lock}");
        assert!(t.capabilities.run.is_available());
    }
}

#[test]
fn package_manager_field_used_without_lockfile() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        &vite_pkg(r#","packageManager":"yarn@4.5.0""#),
    );
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.active_target().unwrap().package_manager, PackageManager::Yarn);
}

#[test]
fn multiple_lockfiles_are_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg(""));
    write(dir.path(), "package-lock.json", "{}");
    write(dir.path(), "yarn.lock", "");
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Unknown);
    // Ambiguous PM → no selected runner, but the workspace still opens.
    assert!(!a.active_target().unwrap().capabilities.run.is_available());
}

#[test]
fn multiple_lockfiles_resolved_by_package_manager_field() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        &vite_pkg(r#","packageManager":"pnpm@9""#),
    );
    write(dir.path(), "package-lock.json", "{}");
    write(dir.path(), "pnpm-lock.yaml", "");
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.active_target().unwrap().package_manager, PackageManager::Pnpm);
}

#[test]
fn no_lockfile_no_field_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg(""));
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Unknown);
    assert!(a.findings.iter().any(|r| r.contains("no lockfile")));
}

// ---- failure modes -----------------------------------------------------------

#[test]
fn empty_directory_is_a_valid_workspace() {
    // The root no longer requires package.json — an empty directory is a
    // workspace with no targets, not an error.
    let dir = tempfile::tempdir().unwrap();
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::NoManifest);
    assert!(a.targets.is_empty());
    assert!(a.active_target_id.is_none());
    assert!(a.capabilities.workspace_browse.is_available());
    assert!(a.capabilities.quick_edit.is_available());
}

#[test]
fn malformed_package_json_is_a_warning_not_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", "{ not json !!");
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(a.warnings.iter().any(|w| w.contains("invalid package.json")));
}

#[test]
fn non_object_package_json_is_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", "[1,2,3]");
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(a.warnings.iter().any(|w| w.contains("invalid package.json")));
}

#[test]
fn nonexistent_root() {
    let dir = tempfile::tempdir().unwrap();
    let err = analyze_workspace(&dir.path().join("does-not-exist")).unwrap_err();
    assert_eq!(err.code(), "INVALID_PROJECT_PATH");
}

#[test]
fn missing_dev_script_reports_available_scripts() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"x","scripts":{"build":"vite build","start":"vite preview"},
        "dependencies":{"react":"^19","vite":"^7"}}"#,
    );
    write(dir.path(), "package-lock.json", "{}");
    let a = analyze_workspace(dir.path()).unwrap();
    let t = a.active_target().unwrap();
    // "start" is still a runner candidate — dev is just preferred.
    assert!(t.runner_candidates.iter().any(|c| c.script_name == "start"));
    assert!(t.selected_runner.as_ref().unwrap().display.contains("start"));
}

#[test]
fn vite_without_react_is_vite_framework() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"x","scripts":{"dev":"vite"},
        "devDependencies":{"vite":"^7"}}"#,
    );
    write(dir.path(), "pnpm-lock.yaml", "");
    let a = analyze_workspace(dir.path()).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::Vite);
    assert!(t.capabilities.run.is_available());
    assert!(!t.capabilities.source_mapping.is_available());
    assert_eq!(
        t.capabilities.component_intelligence.state,
        CapabilityState::NotApplicable
    );
}

#[test]
fn vite_phaser_fixture_is_not_react() {
    let a = analyze_workspace(&fixtures_dir().join("vite-nonreact")).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::Vite);
    assert!(t.technologies.iter().any(|x| x.name == "Phaser"));
    assert!(!t.technologies.iter().any(|x| x.name == "React"));
    assert!(t.capabilities.run.is_available());
    assert_eq!(
        t.capabilities.component_intelligence.state,
        CapabilityState::NotApplicable
    );
}

#[test]
fn static_web_fixture_detected_and_runnable() {
    let a = analyze_workspace(&fixtures_dir().join("static-web")).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::StaticWeb);
    assert_eq!(t.kind, TargetKind::StaticWeb);
    assert!(t.capabilities.workspace_browse.is_available());
    assert!(t.capabilities.quick_edit.is_available());
    // No dev script — RootRay's built-in loopback server runs it.
    assert!(t.capabilities.run.is_available());
    assert!(t.capabilities.dom_inspect.is_available());
    assert_eq!(
        t.capabilities.source_mapping.state,
        CapabilityState::Partial
    );
    assert!(t.selected_runner.is_none());
}

#[test]
fn node_cli_fixture_is_a_tool_not_a_web_app() {
    let a = analyze_workspace(&fixtures_dir().join("node-cli")).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.kind, TargetKind::Tool);
    assert!(!t.capabilities.run.is_available()); // build/test only, no dev/serve/start
    assert_eq!(
        t.capabilities.source_mapping.state,
        CapabilityState::Unavailable
    );
    assert!(a.capabilities.workspace_search.is_available());
}

#[test]
fn detection_never_uses_folder_names() {
    // A directory named like a framework but without the deps must not match.
    let dir = tempfile::tempdir().unwrap();
    let sneaky = dir.path().join("vite-react");
    fs::create_dir_all(&sneaky).unwrap();
    write(
        &sneaky,
        "package.json",
        r#"{"name":"x","scripts":{"dev":"node s.js"},"dependencies":{"express":"^4"}}"#,
    );
    write(&sneaky, "package-lock.json", "{}");
    let a = analyze_workspace(&sneaky).unwrap();
    assert_eq!(a.active_target().unwrap().framework, Framework::NodeWeb);
}
