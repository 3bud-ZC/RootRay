//! Universal workspace discovery: monorepos, nested targets, bounds,
//! secret safety, symlink containment and active-target behavior.

use std::fs;
use std::path::{Path, PathBuf};

use rootray_core::project::package_manager::PackageManager;
use rootray_core::project::workspace::discovery::{MAX_DEPTH, MAX_MANIFESTS};
use rootray_core::project::{
    analyze_workspace, CapabilityState, Framework, TargetKind, WorkspaceKind,
};
use rootray_core::{AppCore, CoreError};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn target<'a>(
    a: &'a rootray_core::project::WorkspaceAnalysis,
    id: &str,
) -> &'a rootray_core::project::ProjectTarget {
    a.targets.iter().find(|t| t.id == id).expect(id)
}

// ---- monorepo discovery -----------------------------------------------------

#[test]
fn pnpm_monorepo_discovers_nested_targets() {
    let a = analyze_workspace(&fixtures().join("pnpm-monorepo")).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::PnpmWorkspace);
    assert_eq!(a.package_manager, PackageManager::Pnpm);

    // web + api + ui discovered — plus the workspace root manifest itself.
    let web = target(&a, "apps/web");
    let api = target(&a, "apps/api");
    let ui = target(&a, "packages/ui");

    assert_eq!(web.framework, Framework::NextJs);
    assert_eq!(web.kind, TargetKind::WebApp);
    assert_eq!(api.kind, TargetKind::Server);
    assert_eq!(ui.kind, TargetKind::Library);
    // ui has a "build" script only — not a runnable app candidate.
    assert!(ui.selected_runner.is_none());

    // The single web app is auto-selected.
    assert_eq!(a.active_target_id.as_deref(), Some("apps/web"));

    // Nested targets inherit the workspace package manager.
    assert_eq!(web.package_manager, PackageManager::Pnpm);
    assert_eq!(api.package_manager, PackageManager::Pnpm);
    assert_eq!(web.selected_runner.as_ref().unwrap().display, "pnpm run dev");
    // Runner cwd is the target root, not the workspace root.
    assert_eq!(
        web.selected_runner.as_ref().unwrap().cwd,
        web.absolute_root
    );
    assert!(web.absolute_root.starts_with(&a.root));
}

#[test]
fn turborepo_detected_via_turbo_json_and_dep() {
    let a = analyze_workspace(&fixtures().join("turborepo")).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::PnpmWorkspace);
    // turbo.json evidence lands in findings.
    assert!(a.findings.iter().any(|f| f.contains("turbo")));
    // The root manifest's turbo devDependency surfaces as technology.
    let root = target(&a, "root");
    assert!(root.technologies.iter().any(|t| t.name == "Turborepo"));
    let web = target(&a, "apps/web");
    assert_eq!(web.framework, Framework::NextJs);
    let ui = target(&a, "packages/ui");
    assert_eq!(ui.kind, TargetKind::Library);
}

#[test]
fn workspace_without_root_manifest_still_works() {
    let a = analyze_workspace(&fixtures().join("no-root-manifest")).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::UnknownMultiPackage);
    let web = target(&a, "apps/web");
    assert_eq!(web.framework, Framework::NextJs);
    assert_eq!(a.active_target_id.as_deref(), Some("apps/web"));
    // Security root = selected dir; target root = the nested package.
    assert!(a.root.ends_with("no-root-manifest"));
    assert!(web.absolute_root.starts_with(&a.root));
    assert!(web.absolute_root.ends_with("web"));
}

#[test]
fn npm_workspaces_field_detected() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"ws","private":true,"workspaces":["apps/*"]}"#,
    );
    write(dir.path(), "package-lock.json", "{}");
    write(
        dir.path(),
        "apps/web/package.json",
        r#"{"name":"web","scripts":{"dev":"vite"},"dependencies":{"react":"^19"},"devDependencies":{"vite":"^7"}}"#,
    );
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::NpmWorkspace);
    let web = target(&a, "apps/web");
    assert_eq!(web.framework, Framework::ViteReact);
    assert_eq!(web.package_manager, PackageManager::Npm); // inherited
    assert_eq!(a.active_target_id.as_deref(), Some("apps/web"));
}

#[test]
fn yarn_workspaces_field_detected() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"ws","private":true,"workspaces":{"packages":["apps/*"]}}"#,
    );
    write(dir.path(), "yarn.lock", "");
    write(
        dir.path(),
        "apps/api/package.json",
        r#"{"name":"api","scripts":{"start":"node s.js"},"dependencies":{"express":"^4"}}"#,
    );
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.workspace_kind, WorkspaceKind::YarnWorkspace);
    assert_eq!(target(&a, "apps/api").package_manager, PackageManager::Yarn);
}

// ---- bounded discovery ------------------------------------------------------

#[test]
fn generated_directories_are_never_entered() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    // A manifest planted inside ignored dirs must not be discovered.
    for ignored in [
        "node_modules/evil",
        ".git/evil",
        "dist/evil",
        "build/evil",
        "coverage/evil",
        ".next/evil",
        ".turbo/evil",
        "target/evil",
        "playwright-report/evil",
        "test-results/evil",
        ".e2e-work/evil",
    ] {
        write(dir.path(), &format!("{ignored}/package.json"), r#"{"name":"evil"}"#);
    }
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.targets.len(), 1);
    assert_eq!(a.targets[0].id, "root");
    assert_eq!(a.discovery.manifests_read, 1);
}

fn vite_pkg() -> String {
    r#"{"name":"tmp","scripts":{"dev":"vite"},"devDependencies":{"vite":"^7"},
    "dependencies":{"react":"^19"}}"#
        .to_string()
}

#[test]
fn discovery_depth_is_capped() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    // Bury a manifest deeper than MAX_DEPTH.
    let mut deep = String::new();
    for i in 0..MAX_DEPTH + 3 {
        deep.push_str(&format!("d{i}/"));
    }
    write(dir.path(), &format!("{deep}package.json"), r#"{"name":"deep"}"#);
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(!a.targets.iter().any(|t| t.id.starts_with("d0")));
    assert!(a.discovery.dirs_visited > 0);
}

#[test]
fn discovery_manifest_cap_truncates() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    for i in 0..MAX_MANIFESTS + 5 {
        write(dir.path(), &format!("pkg{i}/package.json"), r#"{"name":"p"}"#);
    }
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(a.discovery.truncated);
    assert!(a.targets.len() <= MAX_MANIFESTS);
}

#[test]
fn discovery_never_executes_scripts() {
    // A script that would create a marker file must never run.
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("EXECUTED_MARKER");
    write(
        dir.path(),
        "package.json",
        &format!(
            r#"{{"name":"x","scripts":{{"dev":"node -e \"require('fs').writeFileSync('{}','x')\""}},
            "devDependencies":{{"vite":"^7"}}}}"#,
            marker.to_string_lossy().replace('\\', "\\\\")
        ),
    );
    analyze_workspace(dir.path()).unwrap();
    assert!(!marker.exists());
}

#[test]
fn secret_files_are_never_read() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    write(dir.path(), ".env", "TOKEN=hunter2");
    write(dir.path(), ".env.local", "TOKEN=hunter2");
    write(dir.path(), "id_rsa", "PRIVATE KEY");
    write(dir.path(), "secrets/credentials.json", "{}");
    let a = analyze_workspace(dir.path()).unwrap();
    // Secrets exist but their contents never appear in findings/evidence.
    let blob = format!("{:?}{:?}{:?}", a.findings, a.warnings, a.targets);
    assert!(!blob.contains("hunter2"));
    assert!(!blob.contains("PRIVATE KEY"));
}

#[test]
fn symlink_escaping_root_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "package.json", r#"{"name":"outside"}"#);

    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(outside.path(), dir.path().join("linked")).is_err() {
        return; // no symlink privilege — junction check covers containment
    }
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(!a.targets.iter().any(|t| t.id.contains("linked")));
    assert!(a.warnings.iter().any(|w| w.contains("escaping")));
}

#[cfg(windows)]
#[test]
fn junction_escaping_root_is_skipped() {
    // Junctions need no privilege on Windows — always testable.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", &vite_pkg());
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "package.json", r#"{"name":"outside"}"#);
    // `cmd /c mklink /J` creates a junction without privileges.
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(dir.path().join("linked"))
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(status.status.success());
    let a = analyze_workspace(dir.path()).unwrap();
    assert!(!a.targets.iter().any(|t| t.id.contains("linked")));
}

// ---- active target -----------------------------------------------------------

#[test]
fn set_active_target_switches_runtime_only() {
    let tmp = tempfile::tempdir().unwrap();
    let core = AppCore::new(tmp.path());
    core.analyze(&fixtures().join("pnpm-monorepo")).unwrap();

    let switched = core.set_active_target("apps/api").unwrap();
    assert_eq!(switched.active_target_id.as_deref(), Some("apps/api"));
    // Workspace root unchanged — it is still the security boundary.
    assert_eq!(switched.root, core.state().workspace.unwrap().root);
    // And start() now resolves the api runner, not web.
    let api = switched.active_target().unwrap();
    assert_eq!(api.selected_runner.as_ref().unwrap().display, "pnpm run dev");
    assert!(api.selected_runner.as_ref().unwrap().cwd.ends_with("api"));
}

#[test]
fn set_active_target_rejects_unknown_id() {
    let tmp = tempfile::tempdir().unwrap();
    let core = AppCore::new(tmp.path());
    core.analyze(&fixtures().join("pnpm-monorepo")).unwrap();
    let err = core.set_active_target("apps/nonexistent").unwrap_err();
    assert_eq!(err.code(), "WORKSPACE_TARGET_NOT_FOUND");
}

#[test]
fn set_active_target_requires_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let core = AppCore::new(tmp.path());
    let err = core.set_active_target("root").unwrap_err();
    assert!(matches!(err, CoreError::NoProjectSelected));
}

// ---- capabilities ------------------------------------------------------------

#[test]
fn capability_matrix_is_richer_than_boolean() {
    let a = analyze_workspace(&fixtures().join("nextjs-basic")).unwrap();
    let t = a.active_target().unwrap();
    // Next.js: universal + run + inspector capabilities available — the
    // dev script is a plain `next dev`, which the adapter can instrument.
    assert!(t.capabilities.workspace_browse.is_available());
    assert!(t.capabilities.quick_open.is_available());
    assert!(t.capabilities.workspace_search.is_available());
    assert!(t.capabilities.quick_edit.is_available());
    assert!(t.capabilities.safe_write.is_available());
    assert!(t.capabilities.open_external.is_available());
    assert!(t.capabilities.run.is_available());
    assert!(t.capabilities.browser_open.is_available());
    assert_eq!(t.capabilities.dom_inspect.state, CapabilityState::Available);
    assert_eq!(t.capabilities.style_inspect.state, CapabilityState::Available);
    assert_eq!(t.capabilities.source_mapping.state, CapabilityState::Available);
    // Instrumentation maps rendered DOM to source for client *and* server
    // components, but RSC runtime ownership is static-only → Partial.
    assert_eq!(
        t.capabilities.component_intelligence.state,
        CapabilityState::Partial
    );
    assert_eq!(t.capabilities.hmr_aware.state, CapabilityState::Available);
}

#[test]
fn nextjs_with_complex_dev_script_reports_unavailable_inspection() {
    // A dev script the adapter cannot safely reconstruct must degrade to
    // "runnable but not inspectable" — never a broken Run button.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(
        root.join("package.json"),
        r#"{
            "name": "complex-next",
            "scripts": { "dev": "cross-env FOO=1 next dev" },
            "dependencies": { "next": "16.0.0", "react": "19.0.0" }
        }"#,
    )
    .unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    std::fs::write(root.join("next.config.js"), "module.exports = {}").unwrap();
    let a = analyze_workspace(root).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::NextJs);
    assert!(t.capabilities.run.is_available());
    assert_eq!(t.capabilities.dom_inspect.state, CapabilityState::Unavailable);
    assert_eq!(t.capabilities.hmr_aware.state, CapabilityState::Unavailable);
}

// ---- broader framework compatibility --------------------------------------

#[test]
fn vue_vite_target_gets_generic_dom_tier() {
    let a = analyze_workspace(&fixtures().join("vue-vite")).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::VueVite);
    assert_eq!(t.kind, TargetKind::WebApp);
    assert!(t.technologies.iter().any(|t| t.name == "Vue"));
    assert!(t.technologies.iter().any(|t| t.name == "Vite"));
    let c = &t.capabilities;
    assert!(c.run.is_available());
    assert!(c.browser_open.is_available());
    // Tier B: generic DOM inspection — authored index.html maps exactly,
    // Vue-rendered DOM stays inspectable without a source.
    assert_eq!(c.dom_inspect.state, CapabilityState::Available);
    assert_eq!(c.style_inspect.state, CapabilityState::Available);
    assert_eq!(c.source_mapping.state, CapabilityState::Partial);
    assert_eq!(c.hmr_aware.state, CapabilityState::Available);
    // Honest: no Vue component-tree mapping is claimed.
    assert_eq!(c.component_intelligence.state, CapabilityState::NotApplicable);
    assert!(c
        .component_intelligence
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("Vue"));
}

#[test]
fn svelte_vite_target_gets_generic_dom_tier() {
    let a = analyze_workspace(&fixtures().join("svelte-vite")).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::SvelteVite);
    assert_eq!(t.kind, TargetKind::WebApp);
    let c = &t.capabilities;
    assert_eq!(c.dom_inspect.state, CapabilityState::Available);
    assert_eq!(c.source_mapping.state, CapabilityState::Partial);
    assert_eq!(c.component_intelligence.state, CapabilityState::NotApplicable);
    assert!(c
        .component_intelligence
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("Svelte"));
}

#[test]
fn sveltekit_is_workspace_run_tier_c() {
    let a = analyze_workspace(&fixtures().join("sveltekit-basic")).unwrap();
    let t = a.active_target().unwrap();
    // SvelteKit must not collapse into plain Vite — it drives Vite with
    // appType "custom" and bypasses transformIndexHtml entirely.
    assert_eq!(t.framework, Framework::SvelteKit);
    assert_eq!(t.kind, TargetKind::WebApp);
    let c = &t.capabilities;
    // Universal workspace + safe run + browser open remain.
    assert!(c.workspace_browse.is_available());
    assert!(c.quick_edit.is_available());
    assert!(c.run.is_available()); // npm run dev → `vite dev`
    assert!(c.browser_open.is_available());
    assert_eq!(c.dom_inspect.state, CapabilityState::Unavailable);
    assert!(c
        .dom_inspect
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("SvelteKit"));
    assert_eq!(c.source_mapping.state, CapabilityState::Unavailable);
}

#[test]
fn astro_nuxt_angular_are_workspace_run_tier() {
    for (fixture, expected) in [
        ("astro-basic", Framework::Astro),
        ("nuxt-basic", Framework::Nuxt),
        ("angular-basic", Framework::Angular),
    ] {
        let a = analyze_workspace(&fixtures().join(fixture)).unwrap();
        let t = a.active_target().unwrap();
        assert_eq!(t.framework, expected, "{fixture}");
        assert_eq!(t.kind, TargetKind::WebApp, "{fixture}");
        let c = &t.capabilities;
        assert!(c.run.is_available(), "{fixture}");
        assert!(c.browser_open.is_available(), "{fixture}");
        assert_eq!(c.dom_inspect.state, CapabilityState::Unavailable, "{fixture}");
        assert!(c.dom_inspect.reason.is_some(), "{fixture}");
    }
}

#[test]
fn vite_family_detection_is_dependency_driven() {
    // A Vite-based project is never classified by folder names — only by
    // the declared dependency graph.
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"x","scripts":{"dev":"vite"},"devDependencies":{"vite":"^7","@vitejs/plugin-vue":"^5"},"dependencies":{"vue":"^3"}}"#,
    );
    write(dir.path(), "package-lock.json", "{}");
    let a = analyze_workspace(dir.path()).unwrap();
    assert_eq!(a.active_target().unwrap().framework, Framework::VueVite);
}

#[test]
fn vite_project_with_wrapped_script_reports_unavailable_inspection() {
    // `concurrently …` still runs (npm run dev), but the inspector cannot
    // reconstruct it — the capability must say so up front.
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "package.json",
        r#"{"name":"x","scripts":{"dev":"concurrently \"vite\" \"tsc -w\""},"devDependencies":{"vite":"^7"}}"#,
    );
    write(dir.path(), "package-lock.json", "{}");
    let a = analyze_workspace(dir.path()).unwrap();
    let t = a.active_target().unwrap();
    assert_eq!(t.framework, Framework::Vite);
    assert!(t.capabilities.run.is_available());
    assert_eq!(t.capabilities.dom_inspect.state, CapabilityState::Unavailable);
    assert!(t
        .capabilities
        .dom_inspect
        .reason
        .as_deref()
        .unwrap_or("")
        .contains("complex"));
}

#[test]
fn metrics_are_real_and_bounded() {
    let a = analyze_workspace(&fixtures().join("pnpm-monorepo")).unwrap();
    assert!(a.discovery.dirs_visited > 0);
    assert!(a.discovery.manifests_read >= 4); // root + web + api + ui
    assert_eq!(a.discovery.targets_found, a.targets.len());
    assert!(!a.discovery.truncated);
    assert!(a.discovery.metadata_bytes > 0);
}

// ---- installed-verification fixture guard ------------------------------------
//
// `vite-react-inspector` is the fixture the installed app must actually Run.
// If it ever loses its package-manager evidence (package-lock.json) the
// detector correctly reports Unknown and the runner silently disappears —
// this test makes that regression loud instead of a dead "Run" capability.

#[test]
fn vite_react_inspector_fixture_resolves_a_real_runner() {
    let a = analyze_workspace(&fixtures().join("vite-react-inspector")).unwrap();
    let t = a.active_target().expect("fixture must have an active target");

    assert_eq!(t.framework, Framework::ViteReact);
    assert_eq!(t.package_manager, PackageManager::Npm); // package-lock.json
    assert_eq!(t.dev_script.as_deref(), Some("vite"));

    let runner = t
        .selected_runner
        .as_ref()
        .expect("fixture must resolve `npm run dev` — check package-lock.json exists");
    assert_eq!(runner.display, "npm run dev");
    assert_eq!(runner.cwd, t.absolute_root);

    let c = &t.capabilities;
    assert!(c.run.is_available());
    assert!(c.source_mapping.is_available());
    assert!(c.dom_inspect.is_available());
    assert!(c.style_inspect.is_available());
    assert!(c.component_intelligence.is_available());
    assert!(c.hmr_aware.is_available());
    assert!(c.browser_open.is_available());
}
