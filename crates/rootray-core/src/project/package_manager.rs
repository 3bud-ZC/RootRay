use std::path::Path;

use serde::Serialize;

use super::package_json::PackageJson;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Unknown,
}

impl PackageManager {
    /// Executable name used to spawn the package manager on this platform.
    /// On Windows the `.cmd` shim must be named explicitly so it can be
    /// resolved through PATH by CreateProcess.
    pub fn executable(&self) -> &'static str {
        #[cfg(windows)]
        match self {
            Self::Pnpm => "pnpm.cmd",
            Self::Npm => "npm.cmd",
            Self::Yarn => "yarn.cmd",
            Self::Unknown => "unknown",
        }
        #[cfg(not(windows))]
        match self {
            Self::Pnpm => "pnpm",
            Self::Npm => "npm",
            Self::Yarn => "yarn",
            Self::Unknown => "unknown",
        }
    }

    /// Arguments that run the named script, e.g. `run dev`.
    pub fn run_args(&self, script: &str) -> Vec<String> {
        match self {
            // `pnpm dev` / `yarn dev` also work, but `run` is explicit and
            // consistent across all three managers.
            Self::Pnpm | Self::Npm | Self::Yarn => vec!["run".to_string(), script.to_string()],
            Self::Unknown => vec![],
        }
    }
}

/// Lockfiles that identify each package manager.
const LOCKFILES: &[(PackageManager, &str)] = &[
    (PackageManager::Pnpm, "pnpm-lock.yaml"),
    (PackageManager::Npm, "package-lock.json"),
    (PackageManager::Yarn, "yarn.lock"),
];

/// Parses a `packageManager` field like `"pnpm@9.1.0"` or `"yarn@4"`.
fn parse_package_manager_field(field: &str) -> PackageManager {
    let name = field.split('@').next().unwrap_or("").trim();
    match name {
        "pnpm" => PackageManager::Pnpm,
        "npm" => PackageManager::Npm,
        "yarn" => PackageManager::Yarn,
        _ => PackageManager::Unknown,
    }
}

pub struct PmDetection {
    pub package_manager: PackageManager,
    pub reasons: Vec<String>,
    /// True when evidence conflicts (multiple lockfiles, or lockfile and
    /// packageManager field disagreeing).
    pub ambiguous: bool,
}

/// Detects the package manager from real files only: lockfiles first,
/// then the package.json `packageManager` field.
pub fn detect_package_manager(root: &Path, pkg: &PackageJson) -> PmDetection {
    let mut reasons = Vec::new();
    let found: Vec<PackageManager> = LOCKFILES
        .iter()
        .filter(|(_, file)| root.join(file).is_file())
        .map(|(pm, file)| {
            reasons.push(format!("found lockfile {file}"));
            *pm
        })
        .collect();

    let from_field = pkg.package_manager.as_deref().map(|f| {
        let pm = parse_package_manager_field(f);
        if pm != PackageManager::Unknown {
            reasons.push(format!("package.json declares packageManager \"{f}\""));
        }
        pm
    });

    match found.len() {
        1 => {
            let pm = found[0];
            if let Some(field_pm) = from_field {
                if field_pm != PackageManager::Unknown && field_pm != pm {
                    reasons.push(format!(
                        "packageManager field conflicts with lockfile; trusting lockfile ({})",
                        pm_name(pm)
                    ));
                }
            }
            PmDetection { package_manager: pm, reasons, ambiguous: false }
        }
        0 => match from_field {
            Some(pm) if pm != PackageManager::Unknown => {
                PmDetection { package_manager: pm, reasons, ambiguous: false }
            }
            _ => {
                reasons.push(
                    "no lockfile (pnpm-lock.yaml / package-lock.json / yarn.lock) and no \
                     packageManager field found"
                        .to_string(),
                );
                PmDetection { package_manager: PackageManager::Unknown, reasons, ambiguous: false }
            }
        },
        _ => {
            // Multiple lockfiles: prefer an explicit packageManager field.
            if let Some(pm) = from_field {
                if pm != PackageManager::Unknown {
                    reasons.push(format!(
                        "multiple lockfiles found; using packageManager field ({})",
                        pm_name(pm)
                    ));
                    return PmDetection { package_manager: pm, reasons, ambiguous: true };
                }
            }
            reasons.push(
                "multiple conflicting lockfiles found; package manager is ambiguous".to_string(),
            );
            PmDetection { package_manager: PackageManager::Unknown, reasons, ambiguous: true }
        }
    }
}

fn pm_name(pm: PackageManager) -> &'static str {
    match pm {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Npm => "npm",
        PackageManager::Yarn => "yarn",
        PackageManager::Unknown => "unknown",
    }
}
