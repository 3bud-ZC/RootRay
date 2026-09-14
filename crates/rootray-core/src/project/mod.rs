//! Project detector: inspects a directory and produces a typed
//! [`ProjectAnalysis`] used by the UI and the process manager.

pub mod adapters;
pub mod package_json;
pub mod package_manager;

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::filesystem::canonicalize_root;

use adapters::{adapters, DetectionContext, Framework};
use package_json::PackageJson;
use package_manager::{detect_package_manager, PackageManager};

/// A resolved, spawnable dev command (executable + argv, never a shell string).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub display: String,
    /// Working directory — always the canonicalized project root.
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapabilities {
    pub can_run: bool,
    pub inspector_compatible: bool,
}

/// Full result of analyzing a project directory. Serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAnalysis {
    pub root: PathBuf,
    pub project_name: Option<String>,
    pub supported: bool,
    pub framework: Framework,
    pub package_manager: PackageManager,
    pub dev_command: Option<DevCommand>,
    pub package_json_path: Option<PathBuf>,
    pub dev_script: Option<String>,
    /// Factual findings — also used to explain unsupported projects.
    pub reasons: Vec<String>,
    pub capabilities: ProjectCapabilities,
}

/// Analyzes `root` without executing any project code.
///
/// Hard failures (missing/unreadable/invalid package.json, bad path) return
/// `Err`. Unsupported-but-valid projects return `Ok` with
/// `supported == false` and explanatory `reasons`.
pub fn analyze_project(root: &Path) -> CoreResult<ProjectAnalysis> {
    let root = canonicalize_root(root)?;
    let pkg = PackageJson::load(&root)?;
    let package_json_path = root.join("package.json");

    let mut reasons = Vec::new();

    // --- Framework detection via adapters -------------------------------
    let ctx = DetectionContext { root: &root, package_json: &pkg };
    let detection = adapters()
        .iter()
        .map(|a| a.detect(&ctx))
        .find(|d| d.matched);

    let (framework, inspector_compatible) = match &detection {
        Some(d) => {
            reasons.extend(d.reasons.iter().cloned());
            (d.framework, d.inspector_compatible)
        }
        None => {
            let names: Vec<String> = pkg.dependency_names().cloned().collect();
            reasons.push("no supported framework detected".to_string());
            reasons.push(format!(
                "declared dependencies: {}",
                if names.is_empty() { "(none)".to_string() } else { names.join(", ") }
            ));
            (Framework::Unknown, false)
        }
    };
    let supported = framework != Framework::Unknown;

    // --- Package manager -------------------------------------------------
    let pm = detect_package_manager(&root, &pkg);
    reasons.extend(pm.reasons.iter().cloned());
    let package_manager = pm.package_manager;

    // --- Dev script -------------------------------------------------------
    let dev_script = pkg.scripts.get("dev").cloned();
    if let Some(script) = &dev_script {
        reasons.push(format!("found dev script: \"dev\": \"{script}\""));
    } else {
        let available: Vec<&String> = pkg.scripts.keys().collect();
        reasons.push(format!(
            "no \"dev\" script in package.json (available: {})",
            if available.is_empty() {
                "(none)".to_string()
            } else {
                available
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ));
    }

    // --- Dev command resolution ------------------------------------------
    let dev_command = if supported && package_manager != PackageManager::Unknown && dev_script.is_some()
    {
        let args = package_manager.run_args("dev");
        let exe = package_manager.executable().to_string();
        let display = format!("{} {}", exe.trim_end_matches(".cmd"), args.join(" "));
        Some(DevCommand { executable: exe, args, display, cwd: root.clone() })
    } else {
        None
    };

    let can_run = dev_command.is_some();
    if supported && !can_run {
        if package_manager == PackageManager::Unknown {
            reasons.push("cannot run: package manager is unknown".to_string());
        }
        if dev_script.is_none() {
            reasons.push("cannot run: missing dev script".to_string());
        }
    }

    Ok(ProjectAnalysis {
        root,
        project_name: pkg.name.clone(),
        supported,
        framework,
        package_manager,
        dev_command,
        package_json_path: Some(package_json_path),
        dev_script,
        reasons,
        capabilities: ProjectCapabilities { can_run, inspector_compatible },
    })
}

/// Re-validates that `path` stays inside the analyzed project root before a
/// file-level operation is performed. Used today by `open_in_editor` and by
/// the upcoming inspector.
pub fn ensure_within_project(analysis: &ProjectAnalysis, candidate: &Path) -> CoreResult<PathBuf> {
    crate::filesystem::ensure_within_root(&analysis.root, candidate)
}

/// Convenience used by callers that already know the project is unsupported
/// and want a typed error instead of an analysis value.
pub fn unsupported_error(analysis: &ProjectAnalysis) -> CoreError {
    CoreError::UnsupportedFramework(analysis.reasons.join("; "))
}
