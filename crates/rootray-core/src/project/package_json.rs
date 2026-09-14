use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::error::{CoreError, CoreResult};

/// Minimal, tolerant view of a project's package.json. Unknown fields are
/// ignored; the file is only ever *read*, never executed or written.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PackageJson {
    #[serde(default)]
    pub name: Option<String>,

    #[serde(default)]
    pub scripts: BTreeMap<String, String>,

    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,

    #[serde(default, rename = "devDependencies")]
    pub dev_dependencies: BTreeMap<String, String>,

    /// Corepack-style `packageManager` field, e.g. `"pnpm@9.1.0"`.
    #[serde(default, rename = "packageManager")]
    pub package_manager: Option<String>,
}

impl PackageJson {
    /// Reads and parses `root/package.json`.
    pub fn load(root: &Path) -> CoreResult<Self> {
        let path = root.join("package.json");
        if !path.is_file() {
            return Err(CoreError::PackageJsonNotFound);
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CoreError::PackageJsonNotFound
            } else {
                CoreError::Internal(format!("failed to read package.json: {e}"))
            }
        })?;
        Self::parse(&raw)
    }

    pub fn parse(raw: &str) -> CoreResult<Self> {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| CoreError::PackageJsonInvalid(e.to_string()))?;
        if !value.is_object() {
            return Err(CoreError::PackageJsonInvalid(
                "top-level value must be an object".to_string(),
            ));
        }
        serde_json::from_value(value).map_err(|e| CoreError::PackageJsonInvalid(e.to_string()))
    }

    /// True if `dep` appears in dependencies or devDependencies.
    pub fn has_dependency(&self, dep: &str) -> bool {
        self.dependencies.contains_key(dep) || self.dev_dependencies.contains_key(dep)
    }

    /// Names of dependencies the project declares (deps + devDeps).
    pub fn dependency_names(&self) -> impl Iterator<Item = &String> {
        self.dependencies.keys().chain(self.dev_dependencies.keys())
    }
}
