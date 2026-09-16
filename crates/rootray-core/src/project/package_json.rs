use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

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

    /// npm/yarn `workspaces` — either `["packages/*"]` or
    /// `{ "packages": [...] }`. Kept untyped because both shapes exist.
    #[serde(default)]
    pub workspaces: Option<Value>,

    /// CLI entry (`"bin": "cli.js"` or a map) — evidence for tool targets.
    #[serde(default)]
    pub bin: Option<Value>,

    /// Library entry point — evidence for library targets.
    #[serde(default)]
    pub main: Option<String>,

    /// `engines` map — e.g. `{ "node": ">=18" }` is Node evidence.
    #[serde(default)]
    pub engines: BTreeMap<String, String>,
}

impl PackageJson {
    /// Reads `root/package.json` if present: `Ok(None)` when absent,
    /// `Err` only when the file exists but cannot be read/parsed.
    pub fn load_opt(root: &Path) -> CoreResult<Option<Self>> {
        match Self::load(root) {
            Ok(pkg) => Ok(Some(pkg)),
            Err(CoreError::PackageJsonNotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

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

    /// Declared version spec for a dependency, e.g. `"^16.2.12"`.
    pub fn dependency_version(&self, dep: &str) -> Option<&str> {
        self.dependencies
            .get(dep)
            .or_else(|| self.dev_dependencies.get(dep))
            .map(String::as_str)
    }

    /// Workspace package globs — from `workspaces: [...]` or
    /// `workspaces.packages: [...]`. Non-string entries are ignored.
    pub fn workspace_globs(&self) -> Vec<String> {
        let collect = |v: &Value| -> Vec<String> {
            v.as_array()
                .map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        match &self.workspaces {
            Some(Value::Array(_)) => collect(self.workspaces.as_ref().unwrap()),
            Some(Value::Object(m)) => m.get("packages").map(collect).unwrap_or_default(),
            _ => Vec::new(),
        }
    }
}
