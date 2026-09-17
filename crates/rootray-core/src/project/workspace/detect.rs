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
    /// Vue on Vite — the generic DOM adapter covers it (no JSX).
    VueVite,
    /// Svelte on Vite — generic DOM inspection; no component mapping.
    SvelteVite,
    /// SvelteKit runs on Vite but sets `appType: "custom"` and renders
    /// HTML outside `transformIndexHtml` — no safe injection point.
    /// Workspace + run + browser open only.
    SvelteKit,
    Astro,
    Nuxt,
    Angular,
    Remotion,
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
            Self::VueVite => "Vue + Vite",
            Self::SvelteVite => "Svelte + Vite",
            Self::SvelteKit => "SvelteKit",
            Self::Astro => "Astro",
            Self::Nuxt => "Nuxt",
            Self::Angular => "Angular",
            Self::Remotion => "Remotion",
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
    let capabilities =
        capabilities_for(framework, tkind, selected.is_some(), dev_script.as_deref());

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

/// Directories with `index.html` but no package.json — plain browser
/// projects. A manifest-backed directory is already a target; every other
/// index.html dir becomes a static target (nested sites included).
pub fn static_targets(
    root: &Path,
    scan: &Scan,
    findings: &mut Vec<String>,
) -> Vec<ProjectTarget> {
    const MAX_STATIC_TARGETS: usize = 16;
    let mut out = Vec::new();
    for dir in &scan.index_html_dirs {
        if scan.manifest_dirs.iter().any(|d| d == dir) {
            continue; // already a manifest-backed target
        }
        if out.len() >= MAX_STATIC_TARGETS {
            break;
        }
        let rel_root = rel(root, dir);
        let id = if rel_root.is_empty() { "root".to_string() } else { rel_root.clone() };
        findings.push(format!("static web entry found: {id}/index.html"));
        out.push(ProjectTarget {
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
            capabilities: static_caps(),
            evidence: vec!["index.html present".to_string()],
        });
    }
    out
}

fn static_caps() -> CapabilityMatrix {
    CapabilityMatrix {
        workspace_browse: Capability::available(),
        workspace_search: Capability::available(),
        quick_open: Capability::available(),
        quick_edit: Capability::available(),
        safe_write: Capability::available(),
        open_external: Capability::available(),
        // No dev script is needed — RootRay's own loopback static server
        // runs the site.
        run: Capability::available(),
        browser_open: Capability::available(),
        dom_inspect: Capability::available(),
        style_inspect: Capability::available(),
        source_mapping: Capability::partial(
            "authored HTML elements map exactly; runtime-created DOM has no authored source",
        ),
        component_intelligence: Capability::not_applicable_because("not a React project"),
        hmr_aware: Capability::partial("RootRay reloads the page on save — no HMR"),
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

    // Meta-frameworks with their own toolchains must be classified before
    // the plain-vite branch — several of them (SvelteKit, Astro) declare
    // `vite` in their manifests but drive it through their own CLI/SSR.
    if pkg.has_dependency("@sveltejs/kit") {
        let v = normalize_version(pkg.dependency_version("@sveltejs/kit"));
        ev.push("\"@sveltejs/kit\" dependency found".to_string());
        if has_config(dir, "svelte.config") {
            ev.push("svelte.config.* found".to_string());
        }
        return (Framework::SvelteKit, v, ev);
    }
    if pkg.has_dependency("nuxt") || has_config(dir, "nuxt.config") {
        let v = normalize_version(pkg.dependency_version("nuxt"));
        ev.push("nuxt dependency/config found".to_string());
        return (Framework::Nuxt, v, ev);
    }
    if pkg.has_dependency("astro") || has_config(dir, "astro.config") {
        let v = normalize_version(pkg.dependency_version("astro"));
        ev.push("astro dependency/config found".to_string());
        return (Framework::Astro, v, ev);
    }
    if pkg.has_dependency("@angular/core") || dir.join("angular.json").is_file() {
        let v = normalize_version(pkg.dependency_version("@angular/core"));
        ev.push("angular dependency/angular.json found".to_string());
        return (Framework::Angular, v, ev);
    }
    if pkg.has_dependency("remotion") {
        let v = normalize_version(pkg.dependency_version("remotion"));
        ev.push("\"remotion\" dependency found".to_string());
        return (Framework::Remotion, v, ev);
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
        if pkg.has_dependency("vue") || pkg.has_dependency("@vitejs/plugin-vue") {
            ev.push("\"vue\" found in package.json dependencies".to_string());
            return (Framework::VueVite, v, ev);
        }
        if pkg.has_dependency("svelte") || pkg.has_dependency("@sveltejs/vite-plugin-svelte") {
            ev.push("\"svelte\" found in package.json dependencies".to_string());
            return (Framework::SvelteVite, v, ev);
        }
        ev.push("no react/vue/svelte dependency — plain Vite project".to_string());
        return (Framework::Vite, v, ev);
    }

    if has_config(dir, "svelte.config") || pkg.has_dependency("svelte") {
        ev.push("svelte config/dependency found".to_string());
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
        Framework::NextJs
        | Framework::ViteReact
        | Framework::Vite
        | Framework::VueVite
        | Framework::SvelteVite
        | Framework::SvelteKit
        | Framework::Astro
        | Framework::Nuxt
        | Framework::Angular
        | Framework::Remotion => {
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

fn capabilities_for(
    framework: Framework,
    kind: TargetKind,
    runnable: bool,
    dev_script: Option<&str>,
) -> CapabilityMatrix {
    let mut caps = CapabilityMatrix::universal();
    caps.run = if runnable {
        Capability::available()
    } else {
        Capability::unavailable("no resolvable run script")
    };

    match framework {
        Framework::ViteReact => {
            // Same contract as Next: full inspection only when the dev
            // script is a reconstructable `vite` invocation — a wrapped
            // script still runs plainly and reports why.
            let instrumentable = runnable
                && dev_script
                    .map(|s| {
                        crate::inspector::launch::vite_args_from_dev_script(s).is_some()
                    })
                    .unwrap_or(false);
            caps.browser_open = if runnable {
                Capability::available()
            } else {
                Capability::unavailable("no resolvable run script")
            };
            if instrumentable {
                caps.dom_inspect = Capability::available();
                caps.style_inspect = Capability::available();
                caps.source_mapping = Capability::available();
                caps.component_intelligence = Capability::available();
                caps.hmr_aware = Capability::available();
            } else {
                let reason = match dev_script {
                    Some(_) => "dev script too complex for safe instrumentation",
                    None => "no resolvable dev script",
                };
                caps.dom_inspect = Capability::unavailable(reason);
                caps.style_inspect = Capability::unavailable(reason);
                caps.source_mapping = Capability::unavailable(reason);
                caps.component_intelligence = Capability::partial(
                    "static React analysis only — no rendered-element mapping",
                );
                caps.hmr_aware = Capability::unavailable(reason);
            }
        }
        Framework::Vite | Framework::VueVite | Framework::SvelteVite => {
            // Generic DOM inspection runs through the same Vite adapter —
            // the deciding factor is a reconstructable `vite` dev command,
            // not the framework name. Authored index.html elements map
            // exactly; framework-rendered DOM stays inspectable but has no
            // authored source.
            let instrumentable = runnable
                && dev_script
                    .map(|s| {
                        crate::inspector::launch::vite_args_from_dev_script(s).is_some()
                    })
                    .unwrap_or(false);
            caps.browser_open = if runnable {
                Capability::available()
            } else {
                Capability::unavailable("no resolvable run script")
            };
            if instrumentable {
                caps.dom_inspect = Capability::available();
                caps.style_inspect = Capability::available();
                caps.source_mapping = Capability::partial(
                    "authored HTML elements map exactly; runtime-created DOM has no authored source",
                );
                caps.hmr_aware = Capability::available();
            } else {
                let reason = match dev_script {
                    Some(_) => "dev script too complex for safe instrumentation",
                    None => "no resolvable dev script",
                };
                caps.dom_inspect = Capability::unavailable(reason);
                caps.style_inspect = Capability::unavailable(reason);
                caps.source_mapping = Capability::unavailable(reason);
                caps.hmr_aware = Capability::unavailable(reason);
            }
            caps.component_intelligence = Capability::not_applicable_because(match framework {
                Framework::VueVite => "Vue component-tree mapping is not implemented — generic DOM inspection only",
                Framework::SvelteVite => "Svelte component-tree mapping is not implemented — generic DOM inspection only",
                _ => "not a React project",
            });
        }
        Framework::SvelteKit
        | Framework::Astro
        | Framework::Nuxt
        | Framework::Angular
        | Framework::Remotion => {
            // These dev servers run through the framework's own toolchain.
            // RootRay can run the declared script (argv via the package
            // manager) and open the detected URL, but there is no safe
            // in-memory instrumentation path — SSR HTML never reaches a
            // RootRay adapter.
            caps.browser_open = if runnable {
                Capability::available()
            } else {
                Capability::unavailable("no resolvable run script")
            };
            let reason = match framework {
                Framework::SvelteKit => {
                    "SvelteKit renders HTML outside Vite's transform pipeline — no injection point"
                }
                Framework::Astro => "Astro dev runs its own server — no runtime adapter",
                Framework::Nuxt => "Nuxt dev runs its own server — no runtime adapter",
                Framework::Angular => "Angular CLI serves outside Vite — no runtime adapter",
                _ => "Remotion studio runs its own server — no runtime adapter",
            };
            caps.dom_inspect = Capability::unavailable(reason);
            caps.style_inspect = Capability::unavailable(reason);
            caps.source_mapping = Capability::unavailable(reason);
            caps.component_intelligence = Capability::unavailable(
                "component-level source intelligence requires a framework adapter",
            );
            caps.hmr_aware = Capability::unavailable(reason);
        }
        Framework::NextJs => {
            caps.browser_open = Capability::available();
            // The Next adapter instruments `next dev` in memory — but only
            // for dev scripts it can safely reconstruct. Complex scripts
            // still run; the inspector just reports why it is absent.
            let instrumentable = runnable
                && match dev_script {
                    Some(s) => crate::inspector::launch::next_dev_args_from_script(s).is_ok(),
                    None => false,
                };
            if instrumentable {
                caps.dom_inspect = Capability::available();
                caps.style_inspect = Capability::available();
                caps.source_mapping = Capability::available();
                // Instrumentation stamps DOM nodes for client *and* server
                // components; runtime ownership for RSC is static-only.
                caps.component_intelligence = Capability::partial(
                    "rendered-element mapping via build instrumentation; server-component ownership is static",
                );
                caps.hmr_aware = Capability::available();
            } else {
                let reason = match dev_script {
                    Some(_) => "dev script too complex for safe instrumentation",
                    None => "no resolvable dev script",
                };
                caps.dom_inspect = Capability::unavailable(reason);
                caps.style_inspect = Capability::unavailable(reason);
                caps.source_mapping = Capability::unavailable(reason);
                caps.component_intelligence = Capability::partial(
                    "static React analysis only — no rendered-element mapping",
                );
                caps.hmr_aware = Capability::unavailable(reason);
            }
        }
        Framework::StaticWeb => {
            // Manifest-backed static target (package.json + index.html,
            // no bundler) — served by RootRay's built-in loopback server,
            // so a dev script is not required.
            caps.run = Capability::available();
            caps.browser_open = Capability::available();
            caps.dom_inspect = Capability::available();
            caps.style_inspect = Capability::available();
            caps.source_mapping = Capability::partial(
                "authored HTML elements map exactly; runtime-created DOM has no authored source",
            );
            caps.component_intelligence =
                Capability::not_applicable_because("not a React project");
            caps.hmr_aware =
                Capability::partial("RootRay reloads the page on save — no HMR");
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
            caps.browser_open = if runnable
                && matches!(kind, TargetKind::WebApp | TargetKind::Unknown | TargetKind::Server)
            {
                // The loopback URL detector is runtime-agnostic — any dev
                // server that prints a local URL can be opened.
                Capability::partial(
                    "unrecognized stack — a browser opens only if the server prints a loopback URL",
                )
            } else {
                Capability::unavailable("no detected dev server")
            };
            caps.dom_inspect = Capability::unavailable(NO_ADAPTER);
            caps.style_inspect = Capability::unavailable(NO_ADAPTER);
            caps.source_mapping = Capability::unavailable(NO_ADAPTER);
            caps.component_intelligence = Capability::unavailable("no React evidence");
            caps.hmr_aware = Capability::not_applicable();
        }
    }
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
