//! Project-detection tests against real fixture files and synthetic
//! temp-dir projects.

use std::fs;
use std::path::{Path, PathBuf};

use rootray_core::project::adapters::Framework;
use rootray_core::project::package_manager::PackageManager;
use rootray_core::project::analyze_project;

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
    let a = analyze_project(&fixtures_dir().join("vite-react-basic")).unwrap();
    assert!(a.supported);
    assert_eq!(a.framework, Framework::ViteReact);
    assert_eq!(a.package_manager, PackageManager::Npm);
    assert!(a.capabilities.can_run);
    assert!(a.capabilities.inspector_compatible);
    let cmd = a.dev_command.expect("dev command");
    assert!(cmd.display.contains("npm run dev"));
    assert!(a.package_json_path.unwrap().ends_with("package.json"));
}

#[test]
fn detects_vite_react_typescript_fixture() {
    let a = analyze_project(&fixtures_dir().join("vite-react-typescript")).unwrap();
    assert!(a.supported);
    assert_eq!(a.framework, Framework::ViteReact);
    assert_eq!(a.package_manager, PackageManager::Pnpm);
    assert!(a.capabilities.can_run);
}

#[test]
fn rejects_unsupported_fixture_with_reasons() {
    let a = analyze_project(&fixtures_dir().join("unsupported-project")).unwrap();
    assert!(!a.supported);
    assert_eq!(a.framework, Framework::Unknown);
    assert!(!a.capabilities.can_run);
    assert!(a.reasons.iter().any(|r| r.contains("no supported framework")));
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
        let a = analyze_project(dir.path()).unwrap();
        assert_eq!(a.package_manager, pm, "lockfile {lock}");
        assert!(a.capabilities.can_run);
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
    let a = analyze_project(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Yarn);
    assert!(a.capabilities.can_run);
}

#[test]
fn multiple_lockfiles_are_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg(""));
    write(dir.path(), "package-lock.json", "{}");
    write(dir.path(), "yarn.lock", "");
    let a = analyze_project(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Unknown);
    assert!(!a.capabilities.can_run);
    assert!(a.reasons.iter().any(|r| r.contains("ambiguous") || r.contains("multiple")));
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
    let a = analyze_project(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Pnpm);
    assert!(a.capabilities.can_run);
}

#[test]
fn no_lockfile_no_field_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg(""));
    let a = analyze_project(dir.path()).unwrap();
    assert_eq!(a.package_manager, PackageManager::Unknown);
    assert!(!a.capabilities.can_run);
    assert!(a.reasons.iter().any(|r| r.contains("no lockfile")));
}

// ---- failure modes -----------------------------------------------------------

#[test]
fn missing_package_json() {
    let dir = tempfile::tempdir().unwrap();
    let err = analyze_project(dir.path()).unwrap_err();
    assert_eq!(err.code(), "PACKAGE_JSON_NOT_FOUND");
}

#[test]
fn malformed_package_json() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", "{ not json !!");
    let err = analyze_project(dir.path()).unwrap_err();
    assert_eq!(err.code(), "PACKAGE_JSON_INVALID");
}

#[test]
fn non_object_package_json() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", "[1,2,3]");
    let err = analyze_project(dir.path()).unwrap_err();
    assert_eq!(err.code(), "PACKAGE_JSON_INVALID");
}

#[test]
fn nonexistent_root() {
    let dir = tempfile::tempdir().unwrap();
    let err = analyze_project(&dir.path().join("does-not-exist")).unwrap_err();
    assert_eq!(err.code(), "INVALID_PROJECT_PATH");
}

#[test]
fn missing_dev_script_reports_available() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"x","scripts":{"build":"vite build","start":"node s.js"},
        "dependencies":{"react":"^19","vite":"^7"}}"#,
    );
    write(dir.path(), "package-lock.json", "{}");
    let a = analyze_project(dir.path()).unwrap();
    assert!(a.supported);
    assert!(!a.capabilities.can_run);
    assert!(a.dev_command.is_none());
    assert!(
        a.reasons
            .iter()
            .any(|r| r.contains("no \"dev\" script") && r.contains("build"))
    );
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
    let a = analyze_project(dir.path()).unwrap();
    assert!(a.supported);
    assert_eq!(a.framework, Framework::Vite);
    assert!(a.capabilities.can_run);
    assert!(!a.capabilities.inspector_compatible);
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
    let a = analyze_project(&sneaky).unwrap();
    assert_eq!(a.framework, Framework::Unknown);
    assert!(!a.supported);
}
