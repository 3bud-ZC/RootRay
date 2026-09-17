//! Universal workspace discovery and capability engine.
//!
//! The unit RootRay opens is a *workspace* — the directory the user
//! selected. A workspace contains zero or more **targets** (apps,
//! servers, libraries, tools). Runtime actions (run, inspector) apply to
//! the *active target*; filesystem features always apply to the whole
//! workspace root, which is also the security root.
//!
//! Discovery is read-only, bounded and never executes project code or
//! package-manager commands.

pub mod detect;
pub mod discovery;

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::error::CoreResult;
use crate::filesystem::canonicalize_root;

use super::package_json::PackageJson;
use super::package_manager::PackageManager;
use super::DevCommand;

// Re-exported for callers and the wire format.
pub use detect::{Framework, TargetKind, WorkspaceKind};
pub use detect::{Capability, CapabilityMatrix, CapabilityState};

/// A technology identified from real project metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Technology {
    pub name: String,
    /// Declared version from the manifest, e.g. `^16.2.12` — never guessed.
    pub version: Option<String>,
    /// Where the evidence came from.
    pub evidence: Vec<String>,
}

/// A plausible way to run a target — informational until selected.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCandidate {
    pub script_name: String,
    /// Human display string, e.g. `npm run dev`.
    pub display: String,
    /// 0–100; `dev` beats `serve`/`start`.
    pub confidence: u8,
    pub reason: String,
}

/// One runnable/examinable unit inside the workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTarget {
    /// Stable id — the workspace-relative path (or `root` for the root
    /// target). Also used by `set_active_target`.
    pub id: String,
    pub name: Option<String>,
    /// Root of this target relative to the workspace root ("" = root).
    pub relative_root: String,
    /// Canonical absolute root — always a descendant of the workspace root.
    pub absolute_root: PathBuf,
    pub kind: TargetKind,
    pub framework: Framework,
    pub framework_version: Option<String>,
    pub languages: Vec<String>,
    pub technologies: Vec<Technology>,
    pub package_manager: PackageManager,
    pub dev_script: Option<String>,
    pub runner_candidates: Vec<RunnerCandidate>,
    /// The runner RootRay will execute when the user presses Run.
    pub selected_runner: Option<DevCommand>,
    pub capabilities: CapabilityMatrix,
    pub evidence: Vec<String>,
}

/// Metrics recorded during bounded discovery — surfaced to the UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryMetrics {
    pub dirs_visited: usize,
    pub manifests_read: usize,
    pub metadata_bytes: u64,
    pub targets_found: usize,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

/// The authoritative workspace snapshot serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAnalysis {
    /// Canonical selected directory — workspace root AND security root.
    pub root: PathBuf,
    /// Workspace display name (root package.json name or directory name).
    pub name: Option<String>,
    pub workspace_kind: WorkspaceKind,
    /// Workspace-level package manager — targets may inherit it.
    pub package_manager: PackageManager,
    /// Relative paths of every manifest that contributed to the analysis.
    pub manifests: Vec<String>,
    /// Aggregated technologies across the workspace.
    pub technologies: Vec<Technology>,
    pub targets: Vec<ProjectTarget>,
    /// Currently selected target — runtime actions act on it.
    pub active_target_id: Option<String>,
    /// Workspace-level capabilities (Explorer/Search/Edit/…).
    pub capabilities: CapabilityMatrix,
    /// Factual notes about the workspace.
    pub findings: Vec<String>,
    /// Non-fatal issues encountered during discovery.
    pub warnings: Vec<String>,
    pub discovery: DiscoveryMetrics,
}

impl WorkspaceAnalysis {
    /// The active target, if any.
    pub fn active_target(&self) -> Option<&ProjectTarget> {
        self.active_target_id
            .as_deref()
            .and_then(|id| self.targets.iter().find(|t| t.id == id))
    }

    /// Absolute root of the active target — falls back to the workspace
    /// root so callers never deal with an absent target unexpectedly.
    pub fn active_target_root(&self) -> PathBuf {
        self.active_target()
            .map(|t| t.absolute_root.clone())
            .unwrap_or_else(|| self.root.clone())
    }
}

/// Analyzes `root` as a universal workspace. Never fails on content —
/// only an unreadable/non-directory root is a hard error. Everything else
/// lands in `warnings`/`findings` with honest capabilities.
pub fn analyze_workspace(root: &Path) -> CoreResult<WorkspaceAnalysis> {
    let started = Instant::now();
    let root = canonicalize_root(root)?;

    let mut metrics = DiscoveryMetrics::default();
    let mut warnings: Vec<String> = Vec::new();
    let mut findings: Vec<String> = Vec::new();

    let scan = discovery::scan(&root, &mut metrics, &mut warnings);

    // --- workspace-level metadata -------------------------------------
    let root_pkg = if scan.root_manifest {
        match PackageJson::load_opt(&root) {
            Ok(pkg) => pkg,
            Err(e) => {
                warnings.push(format!("root package.json is invalid: {e}"));
                None
            }
        }
    } else {
        None
    };

    let workspace_kind = detect::workspace_kind(&root, &scan, root_pkg.as_ref(), &mut findings);
    let ws_pm = detect::workspace_package_manager(&root, root_pkg.as_ref(), &mut findings);

    // --- targets -------------------------------------------------------
    let mut targets: Vec<ProjectTarget> = scan
        .manifest_dirs
        .iter()
        .map(|dir| {
            detect::detect_target(&root, dir, ws_pm, &workspace_kind, &mut metrics, &mut warnings)
        })
        .collect();
    // Static-web targets: index.html dirs not covered by a manifest
    // target (nested sites included).
    targets.extend(detect::static_targets(&root, &scan, &mut findings));
    targets.sort_by(|a, b| a.id.cmp(&b.id));

    // --- active target -------------------------------------------------
    let active_target_id = detect::select_active_target(&targets, &mut findings);
    if let Some(id) = &active_target_id {
        if let Some(t) = targets.iter().find(|t| &t.id == id) {
            findings.push(format!("active target: {} ({})", t.id, t.framework.display()));
        }
    } else if targets.is_empty() {
        findings.push("no runnable or package targets discovered".to_string());
    }

    // --- aggregated technologies ---------------------------------------
    let technologies = detect::aggregate_technologies(&targets);

    metrics.targets_found = targets.len();
    metrics.elapsed_ms = started.elapsed().as_millis() as u64;

    let name = root_pkg
        .and_then(|p| p.name.clone())
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().to_string()));

    let manifests = scan
        .manifest_dirs
        .iter()
        .map(|d| rel(&root, &d.join("package.json")))
        .collect();

    Ok(WorkspaceAnalysis {
        capabilities: CapabilityMatrix::universal(),
        root,
        name,
        workspace_kind,
        package_manager: ws_pm,
        manifests,
        technologies,
        targets,
        active_target_id,
        findings,
        warnings,
        discovery: metrics,
    })
}

/// Stable workspace-relative display path.
pub(crate) fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}
