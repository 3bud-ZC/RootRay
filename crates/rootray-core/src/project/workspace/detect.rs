//! Evidence-based detection: workspace kind, target classification,
//! technologies, runner candidates and capabilities.
//!
//! Nothing here executes project code or guesses versions — every claim
//! carries the file/field it came from.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::discovery::{self, Scan};
use super::DiscoveryMetrics;
use super::{rel, DevCommand, ProjectTarget, RunnerCandidate, Technology};
use crate::project::package_json::PackageJson;
use crate::project::package_manager::{detect_package_manager, PackageManager};

/// Frameworks RootRay can identify for a target. Extensible — new
/// frameworks are added here without reshaping the workspace model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Framework {
    NextJs,
    ViteReact,
    Vite,
    StaticWeb,
    NodeWeb,
    Unknown,
}

impl Framework {
    pub fn display(&self) -> &'static str {
        match self {
            Self::NextJs => "Next.js",
            Self::ViteReact => "React + Vite",
            Self::Vite => "Vite",
            Self::StaticWeb => "Static Web",
            Self::NodeWeb => "Node.js",
            Self::Unknown => "unknown",
        }
    }
}

/// How the selected directory is organized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceKind {
    SinglePackage,
    NpmWorkspace,
    PnpmWorkspace,
    YarnWorkspace,
    /// Multiple package dirs but no declared workspace config.
    UnknownMultiPackage,
    /// No package.json anywhere in the selected directory.
    NoManifest,
}

impl WorkspaceKind {
    pub fn display(&self) -> &'static str {
        match self {
            Self::SinglePackage => "single package",
            Self::NpmWorkspace => "npm workspace",
            Self::PnpmWorkspace => "pnpm workspace",
            Self::YarnWorkspace => "yarn workspace",
            Self::UnknownMultiPackage => "multi-package",
            Self::NoManifest => "no manifest",
        }
    }
}

/// What a discovered target is — evidence-based, not folder-name-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetKind {
    WebApp,
    Server,
    Library,
    Tool,
    StaticWeb,
    Unknown,
}

impl TargetKind {
    pub fn display(&self) -> &'static str {
        match self {
            Self::WebApp => "web-app",
            Self::Server => "server",
            Self::Library => "library",
            Self::Tool => "tool",
            Self::StaticWeb => "static-web",
            Self::Unknown => "unknown",
        }
    }
}

/// Richer than boolean: every capability carries a factual reason when it
/// is not fully available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityState {
    Available,
    Partial,
    Unavailable,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: CapabilityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Capability {
    pub const fn available() -> Self {
        Self { state: CapabilityState::Available, reason: None }
    }
    pub fn partial(reason: impl Into<String>) -> Self {
        Self { state: CapabilityState::Partial, reason: Some(reason.into()) }
    }
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self { state: CapabilityState::Unavailable, reason: Some(reason.into()) }
    }
    pub const fn not_applicable() -> Self {
        Self { state: CapabilityState::NotApplicable, reason: None }
    }
    pub fn not_applicable_because(reason: impl Into<String>) -> Self {
        Self { state: CapabilityState::NotApplicable, reason: Some(reason.into()) }
    }
    pub fn is_available(&self) -> bool {
        self.state == CapabilityState::Available
    }
}

/// The full capability surface of a target or workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityMatrix {
    pub workspace_browse: Capability,
    pub workspace_search: Capability,
    pub quick_open: Capability,
    pub quick_edit: Capability,
    pub safe_write: Capability,
    pub open_external: Capability,
    pub run: Capability,
    pub browser_open: Capability,
    pub dom_inspect: Capability,
    pub style_inspect: Capability,
    pub source_mapping: Capability,
    pub component_intelligence: Capability,
    pub hmr_aware: Capability,
}

impl CapabilityMatrix {
    /// Universal filesystem capabilities — every safely-opened workspace
    /// gets these regardless of framework support.
    pub fn universal() -> Self {
        Self {
            workspace_browse: Capability::available(),
            workspace_search: Capability::available(),
            quick_open: Capability::available(),
            quick_edit: Capability::available(),
            safe_write: Capability::available(),
            open_external: Capability::available(),
            run: Capability::unavailable("no runnable target"),
            browser_open: Capability::not_applicable(),
            dom_inspect: Capability::not_applicable(),
            style_inspect: Capability::not_applicable(),
            source_mapping: Capability::not_applicable(),
            component_intelligence: Capability::not_applicable(),
            hmr_aware: Capability::not_applicable(),
        }
    }
}

const NO_ADAPTER: &str = "runtime source adapter for this framework is not implemented yet";

// ---------------------------------------------------------------------------
// workspace-level detection
// ---------------------------------------------------------------------------

pub fn workspace_kind(
    root: &Path,
    scan: &Scan,
    root_pkg: Option<&PackageJson>,
    findings: &mut Vec<String>,
) -> WorkspaceKind {
    let declared_globs = root_pkg.map(|p| !p.workspace_globs().is_empty()).unwrap_or(false);

    let kind = if scan.pnpm_workspace_file.is_some() {
        findings.push("pnpm-workspace.yaml found — pnpm workspace".to_string());
        WorkspaceKind::PnpmWorkspace
    } else if declared_globs {
        // workspaces field — npm or yarn depending on lockfile evidence.
        let pm_hint = if root.join("yarn.lock").is_file() {
            WorkspaceKind::YarnWorkspace
        } else {
            WorkspaceKind::NpmWorkspace
        };
        findings.push(format!(
            "package.json workspaces field found — {}",
            pm_hint.display()
        ));
        pm_hint
    } else if scan.root_manifest {
        WorkspaceKind::SinglePackage
    } else if !scan.manifest_dirs.is_empty() {
        // Packages exist below the root but no declared workspace config.
        findings.push(
            "package.json manifests found below a root without workspace config".into(),
        );
        WorkspaceKind::UnknownMultiPackage
    } else {
        WorkspaceKind::NoManifest
    };

    if scan.has_turbo {
        findings.push("turbo.json found — Turborepo orchestration".to_string());
    }
    kind
}

/// Workspace-level package manager: root lockfile/packageManager field.
/// Nested targets inherit this when they have no evidence of their own.
pub fn workspace_package_manager(
    root: &Path,
    root_pkg: Option<&PackageJson>,
    findings: &mut Vec<String>,
) -> PackageManager {
    let default = PackageJson::default();
    let pkg = root_pkg.unwrap_or(&default);
    let det = detect_package_manager(root, pkg);
    findings.extend(det.reasons.iter().cloned());
    det.package_manager
}

// ---------------------------------------------------------------------------
// per-target detection
// ---------------------------------------------------------------------------

/// A directory containing package.json becomes a classified target.
pub fn detect_target(
    ws_root: &Path,
    dir: &Path,
    ws_pm: PackageManager,
    kind: &WorkspaceKind,
    metrics: &mut DiscoveryMetrics,
    warnings: &mut Vec<String>,
) -> ProjectTarget {
    let rel_root = rel(ws_root, dir);
    let id = if rel_root.is_empty() { "root".to_string() } else { rel_root.clone() };
    let mut evidence: Vec<String> = Vec::new();
    let mut languages: Vec<String> = Vec::new();
    let mut technologies: Vec<Technology> = Vec::new();

    // --- manifest --------------------------------------------------------
    let pkg_path = dir.join("package.json");
    let pkg = match discovery::read_metadata(&pkg_path, metrics) {
        Some(text) => match PackageJson::parse(&text) {
            Ok(p) => Some(p),
            Err(e) => {
                warnings.push(format!("invalid package.json at {id}: {e}"));
                None
            }
        },
        None => {
            warnings.push(format!("package.json at {id} exceeds metadata budget"));
            None
        }
    };

    // --- package manager (inherit workspace when no local evidence) -------
    let empty = PackageJson::default();
    let pkg_ref = pkg.as_ref().unwrap_or(&empty);
    let local_pm = detect_package_manager(dir, pkg_ref);
    let package_manager = if local_pm.package_manager != PackageManager::Unknown {
        evidence.extend(local_pm.reasons.iter().cloned());
        local_pm.package_manager
    } else if ws_pm != PackageManager::Unknown && *kind != WorkspaceKind::SinglePackage {
        evidence.push(format!("inherited {} from workspace root", pm_name(ws_pm)));
        ws_pm
    } else {
        evidence.extend(local_pm.reasons.iter().cloned());
        ws_pm
    };

    // --- technology detection ---------------------------------------------
    detect_technologies(dir, pkg_ref, &mut technologies, &mut languages, &mut evidence);

    // --- framework --------------------------------------------------------
    let (framework, framework_version, fw_evidence) = detect_framework(dir, pkg_ref);
    evidence.extend(fw_evidence);

    // --- languages fallback -------------------------------------------------
    if languages.is_empty() && pkg.is_some() {
        languages.push("JavaScript".to_string());
    }

    // --- kind ---------------------------------------------------------------
    let tkind = classify_kind(dir, pkg_ref, framework, &mut evidence);

    // --- runners ------------------------------------------------------------
    let (candidates, selected) = resolve_runners(dir, pkg_ref, package_manager, &mut evidence);
    let dev_script = pkg_ref.scripts.get("dev").cloned();

    // --- capabilities -------------------------------------------------------
    let capabilities = capabilities_for(framework, tkind, selected.is_some());

    ProjectTarget {
        id,
        name: pkg_ref.name.clone().or_else(|| {
            dir.file_name().map(|n| n.to_string_lossy().to_string())
        }),
        relative_root: rel_root,
        absolute_root: dir.to_path_buf(),
        kind: tkind,
        framework,
        framework_version,
        languages,
        technologies,
        package_manager,
        dev_script,
        runner_candidates: candidates,
        selected_runner: selected,
        capabilities,
        evidence,
    }
}

/// A directory with `index.html` but no package.json — a plain browser
/// project. Returns `None` when the directory is already a target.
pub fn static_target(
    root: &Path,
    scan: &Scan,
    findings: &mut Vec<String>,
) -> Option<ProjectTarget> {
    let dir = scan.index_html_dirs.first()?;
    if scan.manifest_dirs.iter().any(|d| d == dir) {
        return None; // already a manifest-backed target
    }
    let rel_root = rel(root, dir);
    let id = if rel_root.is_empty() { "root".to_string() } else { rel_root.clone() };
    findings.push(format!("static web entry found: {id}/index.html"));
    let caps = CapabilityMatrix {
        run: Capability::unavailable(
            "no declared dev script — RootRay does not fabricate a server command",
        ),
        ..static_caps()
    };
    Some(ProjectTarget {
        id,
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()),
        relative_root: rel_root,
        absolute_root: dir.clone(),
        kind: TargetKind::StaticWeb,
        framework: Framework::StaticWeb,
        framework_version: None,
        languages: vec!["JavaScript".to_string()],
        technologies: vec![],
        package_manager: PackageManager::Unknown,
        dev_script: None,
        runner_candidates: vec![],
        selected_runner: None,
        capabilities: caps,
        evidence: vec!["index.html present".to_string()],
    })
}

fn static_caps() -> CapabilityMatrix {
    CapabilityMatrix {
        workspace_browse: Capability::available(),
        workspace_search: Capability::available(),
        quick_open: Capability::available(),
        quick_edit: Capability::available(),
        safe_write: Capability::available(),
        open_external: Capability::available(),
        run: Capability::unavailable("no declared dev script"),
        browser_open: Capability::unavailable("no dev server to produce a URL"),
        dom_inspect: Capability::unavailable(NO_ADAPTER),
        style_inspect: Capability::unavailable(NO_ADAPTER),
        source_mapping: Capability::unavailable(NO_ADAPTER),
        component_intelligence: Capability::not_applicable_because("not a React project"),
        hmr_aware: Capability::not_applicable(),
    }
}

// ---------------------------------------------------------------------------
// framework / kind / technology
// ---------------------------------------------------------------------------

/// Framework detection from manifest deps + config files. Returns the
/// framework, its declared version spec and the evidence list.
fn detect_framework(
    dir: &Path,
    pkg: &PackageJson,
) -> (Framework, Option<String>, Vec<String>) {
    let mut ev = Vec::new();

    if pkg.has_dependency("next") {
        let v = normalize_version(pkg.dependency_version("next"));
        ev.push(format!(
            "\"next\" dependency: {}",
            pkg.dependency_version("next").unwrap_or("?")
        ));
        if has_config(dir, "next.config") {
            ev.push("next.config.* found".to_string());
        }
        if dir.join("app").is_dir() || dir.join("pages").is_dir() {
            ev.push("app/ or pages/ directory present".to_string());
        }
        return (Framework::NextJs, v, ev);
    }

    if pkg.has_dependency("vite") {
        let v = normalize_version(pkg.dependency_version("vite"));
        ev.push("\"vite\" found in package.json dependencies".to_string());
        if has_config(dir, "vite.config") {
            ev.push("vite.config.* found".to_string());
        }
        if pkg.has_dependency("react") || pkg.has_dependency("react-dom") {
            ev.push("\"react\" found in package.json dependencies".to_string());
            return (Framework::ViteReact, v, ev);
        }
        ev.push("\"react\" not found — plain Vite project".to_string());
        return (Framework::Vite, v, ev);
    }

    if has_config(dir, "astro.config") {
        ev.push("astro.config.* found".to_string());
        return (Framework::Unknown, None, ev); // adapter not implemented yet
    }
    if has_config(dir, "svelte.config") || pkg.has_dependency("svelte") {
        ev.push("svelte config/dependency found".to_string());
        return (Framework::Unknown, None, ev);
    }
    if pkg.has_dependency("nuxt") || has_config(dir, "nuxt.config") {
        ev.push("nuxt dependency/config found".to_string());
        return (Framework::Unknown, None, ev);
    }
    if pkg.has_dependency("@angular/core") || dir.join("angular.json").is_file() {
        ev.push("angular dependency/angular.json found".to_string());
        return (Framework::Unknown, None, ev);
    }

    if pkg.has_dependency("express")
        || pkg.has_dependency("fastify")
        || pkg.has_dependency("koa")
        || pkg.has_dependency("hono")
        || pkg.has_dependency("@nestjs/core")
        || pkg.has_dependency("@nestjs/common")
    {
        ev.push("node web framework dependency found".to_string());
        return (Framework::NodeWeb, None, ev);
    }

    if dir.join("index.html").is_file() && !pkg.has_dependency("react") {
        ev.push("index.html present without a bundler manifest".to_string());
        return (Framework::StaticWeb, None, ev);
    }

    (Framework::Unknown, None, ev)
}

/// Evidence-based target classification — never folder names.
fn classify_kind(
    dir: &Path,
    pkg: &PackageJson,
    framework: Framework,
    evidence: &mut Vec<String>,
) -> TargetKind {
    match framework {
        Framework::NextJs | Framework::ViteReact | Framework::Vite => {
            evidence.push("web framework detected".to_string());
            TargetKind::WebApp
        }
        Framework::StaticWeb => TargetKind::StaticWeb,
        Framework::NodeWeb => {
            evidence.push("node web framework detected".to_string());
            TargetKind::Server
        }
        Framework::Unknown => {
            if pkg.bin.is_some() {
                evidence.push("package.json declares a bin entry".to_string());
                return TargetKind::Tool;
            }
            let has_dev = pkg.scripts.contains_key("dev")
                || pkg.scripts.contains_key("serve")
                || pkg.scripts.contains_key("start");
            let has_entry = pkg.main.is_some() || pkg.bin.is_some();
            if !has_dev && has_entry {
                evidence.push("entry point without run scripts — library/tool".to_string());
                return TargetKind::Library;
            }
            if has_dev {
                // A runnable script exists but no recognized framework —
                // look for node-runtime signals: engines.node, a main/bin
                // entry, or server-ish script words.
                let scriptish_node = ["dev", "serve", "start"]
                    .iter()
                    .filter_map(|n| pkg.scripts.get(*n))
                    .any(|s| {
                        ["node", "nest", "tsx", "ts-node", "bun", "deno", "server"]
                            .iter()
                            .any(|w| s.split_whitespace().any(|t| t.starts_with(w)))
                    });
                if pkg.engines.contains_key("node")
                    || scriptish_node
                    || dir.join("src").join("server.ts").is_file()
                {
                    evidence.push("node runtime evidence".to_string());
                    return TargetKind::Server;
                }
                evidence.push("runnable script without a recognized stack".to_string());
                return TargetKind::Unknown;
            }
            if pkg.scripts.is_empty() {
                evidence.push("no scripts — treating as library".to_string());
                TargetKind::Library
            } else {
                TargetKind::Unknown
            }
        }
    }
}

/// Structured technology detection — name, declared version, evidence.
fn detect_technologies(
    dir: &Path,
    pkg: &PackageJson,
    out: &mut Vec<Technology>,
    languages: &mut Vec<String>,
    evidence: &mut Vec<String>,
) {
    let mut add = |name: &str, dep: Option<&str>, ev: &str| {
        out.push(Technology {
            name: name.to_string(),
            version: dep.and_then(|d| normalize_version(pkg.dependency_version(d))),
            evidence: vec![ev.to_string()],
        });
    };

    // (display name, manifest dependency, evidence label)
    const DEP_TECH: &[(&str, &str)] = &[
        ("React", "react"),
        ("Next.js", "next"),
        ("Vite", "vite"),
        ("Vue", "vue"),
        ("Nuxt", "nuxt"),
        ("Svelte", "svelte"),
        ("SvelteKit", "@sveltejs/kit"),
        ("Astro", "astro"),
        ("Angular", "@angular/core"),
        ("Phaser", "phaser"),
        ("Three.js", "three"),
        ("Express", "express"),
        ("NestJS", "@nestjs/core"),
        ("Tailwind CSS", "tailwindcss"),
        ("Prisma", "prisma"),
        ("Prisma", "@prisma/client"),
        ("Remotion", "remotion"),
        ("Turborepo", "turbo"),
        ("TypeScript", "typescript"),
    ];
    for (name, dep) in DEP_TECH {
        if pkg.has_dependency(dep) {
            add(
                name,
                Some(dep),
                &format!("package.json dependency \"{dep}\""),
            );
        }
    }

    if dir.join("tsconfig.json").is_file() && !pkg.has_dependency("typescript") {
        out.push(Technology {
            name: "TypeScript".to_string(),
            version: None,
            evidence: vec!["tsconfig.json present".to_string()],
        });
    }

    // languages
    if dir.join("tsconfig.json").is_file()
        || pkg.has_dependency("typescript")
        || has_source_ext(dir, "ts")
    {
        languages.push("TypeScript".to_string());
    }
    languages.push("JavaScript".to_string());

    // Node.js technology when the project is node-runtime evidenced.
    if pkg.engines.contains_key("node") {
        out.push(Technology {
            name: "Node.js".to_string(),
            version: pkg.engines.get("node").cloned(),
            evidence: vec!["package.json engines.node".to_string()],
        });
        evidence.push("engines.node declared".to_string());
    }
}

/// Cheap presence check for `*.ext` sources in `src/` or root — bounded,
/// never recursive beyond two levels.
fn has_source_ext(dir: &Path, ext: &str) -> bool {
    for base in [dir.join("src"), dir.join("app"), dir.join("pages"), dir.to_path_buf()] {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten().take(200) {
                if e.path().extension().map(|x| x == ext).unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

fn has_config(dir: &Path, base: &str) -> bool {
    ["ts", "js", "mts", "mjs", "cts", "cjs", "json"]
        .iter()
        .any(|ext| dir.join(format!("{base}.{ext}")).is_file())
}

/// `"^16.2.12"` → `16.2.12`; opaque specs (workspace:, file:) → None.
fn normalize_version(spec: Option<&str>) -> Option<String> {
    let s = spec?.trim();
    let cleaned = s
        .trim_start_matches(['^', '~', '>', '=', 'v', ' '])
        .trim_start_matches("v");
    if cleaned.is_empty() || cleaned.starts_with("workspace:") || cleaned.contains(':') {
        return None;
    }
    Some(cleaned.to_string())
}

// ---------------------------------------------------------------------------
// runners
// ---------------------------------------------------------------------------

/// Picks runner candidates from declared scripts and selects the best one.
/// Only safe script names are runnable — RootRay never executes the
/// script *contents*, always `pm run <name>` argv-style.
fn resolve_runners(
    dir: &Path,
    pkg: &PackageJson,
    pm: PackageManager,
    evidence: &mut Vec<String>,
) -> (Vec<RunnerCandidate>, Option<DevCommand>) {
    const ORDER: &[(&str, u8, &str)] = &[
        ("dev", 100, "conventional dev script"),
        ("serve", 70, "serve script"),
        ("start", 60, "start script"),
    ];
    let mut candidates = Vec::new();
    for (name, confidence, reason) in ORDER {
        if let Some(script) = pkg.scripts.get(*name) {
            let display = format!("{} {}", pm.executable().trim_end_matches(".cmd"), {
                let a = pm.run_args(name);
                a.join(" ")
            });
            candidates.push(RunnerCandidate {
                script_name: name.to_string(),
                display,
                confidence: *confidence,
                reason: format!("{reason}: \"{name}\": \"{script}\""),
            });
        }
    }
    if candidates.is_empty() && !pkg.scripts.is_empty() {
        evidence.push(format!(
            "no conventional run script (available: {})",
            pkg.scripts.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }

    let selected = if pm == PackageManager::Unknown {
        if !candidates.is_empty() {
            evidence.push("cannot resolve runner: package manager unknown".to_string());
        }
        None
    } else {
        candidates.first().map(|c| DevCommand {
            executable: pm.executable().to_string(),
            args: pm.run_args(&c.script_name),
            display: c.display.clone(),
            cwd: dir.to_path_buf(),
            env: Vec::new(),
        })
    };
    (candidates, selected)
}

// ---------------------------------------------------------------------------
// capabilities per target
// ---------------------------------------------------------------------------

fn capabilities_for(framework: Framework, kind: TargetKind, runnable: bool) -> CapabilityMatrix {
    let mut caps = CapabilityMatrix::universal();
    caps.run = if runnable {
        Capability::available()
    } else {
        Capability::unavailable("no resolvable run script")
    };

    match framework {
        Framework::ViteReact => {
            caps.browser_open = Capability::available();
            caps.dom_inspect = Capability::available();
            caps.style_inspect = Capability::available();
            caps.source_mapping = Capability::available();
            caps.component_intelligence = Capability::available();
            caps.hmr_aware = Capability::available();
        }
        Framework::Vite => {
            caps.browser_open = Capability::available();
            caps.dom_inspect =
                Capability::unavailable("inspector instrumentation requires React + Vite");
            caps.style_inspect =
                Capability::unavailable("inspector instrumentation requires React + Vite");
            caps.source_mapping =
                Capability::unavailable("inspector instrumentation requires React + Vite");
            caps.component_intelligence =
                Capability::not_applicable_because("not a React project");
            caps.hmr_aware = Capability::available();
        }
        Framework::NextJs => {
            caps.browser_open = Capability::available();
            caps.dom_inspect =
                Capability::unavailable("Next.js runtime adapter is not implemented yet");
            caps.style_inspect =
                Capability::unavailable("Next.js runtime adapter is not implemented yet");
            caps.source_mapping =
                Capability::unavailable("Next.js runtime adapter is not implemented yet");
            caps.component_intelligence = Capability::partial(
                "static React analysis only — no rendered-element mapping",
            );
            caps.hmr_aware = Capability::unavailable(NO_ADAPTER);
        }
        Framework::StaticWeb => {
            caps.browser_open =
                Capability::unavailable("no dev server to produce a URL");
            caps.dom_inspect = Capability::unavailable(NO_ADAPTER);
            caps.style_inspect = Capability::unavailable(NO_ADAPTER);
            caps.source_mapping = Capability::unavailable(NO_ADAPTER);
            caps.component_intelligence =
                Capability::not_applicable_because("not a React project");
            caps.hmr_aware = Capability::not_applicable();
        }
        Framework::NodeWeb => {
            caps.browser_open =
                Capability::unavailable("server target — no UI inspection");
            caps.dom_inspect = Capability::not_applicable();
            caps.style_inspect = Capability::not_applicable();
            caps.source_mapping = Capability::not_applicable();
            caps.component_intelligence = Capability::not_applicable();
            caps.hmr_aware = Capability::not_applicable();
        }
        Framework::Unknown => {
            caps.browser_open = Capability::unavailable("no detected dev server");
            caps.dom_inspect = Capability::unavailable(NO_ADAPTER);
            caps.style_inspect = Capability::unavailable(NO_ADAPTER);
            caps.source_mapping = Capability::unavailable(NO_ADAPTER);
            caps.component_intelligence = Capability::unavailable("no React evidence");
            caps.hmr_aware = Capability::not_applicable();
        }
    }
    let _ = kind;
    caps
}

// ---------------------------------------------------------------------------
// active target + aggregation
// ---------------------------------------------------------------------------

/// Selects the active target: the single unambiguous web-app, else the
/// first runnable target, else the first target. The UI can always switch.
pub fn select_active_target(targets: &[ProjectTarget], findings: &mut Vec<String>) -> Option<String> {
    let web_apps: Vec<&ProjectTarget> =
        targets.iter().filter(|t| t.kind == TargetKind::WebApp).collect();
    let choice = if web_apps.len() == 1 {
        Some(web_apps[0])
    } else if web_apps.len() > 1 {
        findings.push(format!("{} web targets found — target selector available", web_apps.len()));
        web_apps.first().copied()
    } else {
        targets
            .iter()
            .find(|t| t.selected_runner.is_some())
            .or_else(|| targets.first())
    };
    choice.map(|t| t.id.clone())
}

/// Union of target technologies (first evidence wins on name+version).
pub fn aggregate_technologies(targets: &[ProjectTarget]) -> Vec<Technology> {
    let mut out: Vec<Technology> = Vec::new();
    for t in targets {
        for tech in &t.technologies {
            if !out.iter().any(|e| e.name == tech.name) {
                out.push(tech.clone());
            }
        }
    }
    out
}

fn pm_name(pm: PackageManager) -> &'static str {
    match pm {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Npm => "npm",
        PackageManager::Yarn => "yarn",
        PackageManager::Unknown => "unknown",
    }
}

#[allow(dead_code)]
fn _unused(_: PathBuf) {}
