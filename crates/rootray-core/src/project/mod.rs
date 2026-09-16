//! Workspace model: inspects a directory and produces a typed
//! [`WorkspaceAnalysis`] used by the UI and the process manager.
//!
//! Three roots are deliberately distinct:
//! - `securityRoot` — always the directory the user selected.
//! - `workspaceRoot` — same as the security root today.
//! - `activeTargetRoot` — the package/app currently targeted for runtime
//!   actions; a descendant of the security root.

pub mod package_json;
pub mod package_manager;
pub mod workspace;

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CoreResult;

pub use workspace::{
    analyze_workspace, Capability, CapabilityMatrix, CapabilityState, DiscoveryMetrics, Framework,
    ProjectTarget, RunnerCandidate, TargetKind, Technology, WorkspaceAnalysis, WorkspaceKind,
};

/// A resolved, spawnable dev command (executable + argv, never a shell string).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub display: String,
    /// Working directory — the canonicalized *target* root.
    pub cwd: PathBuf,
    /// Extra environment for the child. Never serialized — it may carry
    /// the ephemeral inspector session token.
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

/// Re-validates that `path` stays inside the analyzed workspace root
/// before a file-level operation is performed.
pub fn ensure_within_workspace(analysis: &WorkspaceAnalysis, candidate: &Path) -> CoreResult<PathBuf> {
    crate::filesystem::ensure_within_root(&analysis.root, candidate)
}
