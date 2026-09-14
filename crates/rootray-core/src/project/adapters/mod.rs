//! Framework adapter contract.
//!
//! Adapters decide *which* framework a project uses based on real project
//! files — never from folder names and never by executing project code.
//! New stacks (Next.js, Vue, Svelte, Astro) are added by implementing
//! [`ProjectAdapter`] and registering it in [`adapters`].

mod vite;

use std::path::Path;

use serde::Serialize;

use super::package_json::PackageJson;

pub use vite::ViteAdapter;

/// Frameworks RootRay can identify.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Framework {
    ViteReact,
    Vite,
    Unknown,
}

/// Everything an adapter may inspect. Only metadata — adapters must not
/// execute project code or traverse the whole tree.
pub struct DetectionContext<'a> {
    pub root: &'a Path,
    pub package_json: &'a PackageJson,
}

impl<'a> DetectionContext<'a> {
    /// True when any `name.*` file matching `extensions` exists at the root
    /// (e.g. `vite.config` with `ts`, `js`, `mts`, `mjs`).
    pub fn has_config_file(&self, name: &str, extensions: &[&str]) -> Option<String> {
        for ext in extensions {
            let file = format!("{name}.{ext}");
            if self.root.join(&file).is_file() {
                return Some(file);
            }
        }
        None
    }
}

#[derive(Debug)]
pub struct AdapterDetection {
    /// Whether this adapter claims the project.
    pub matched: bool,
    pub framework: Framework,
    /// Whether the milestone-02 inspector will be able to instrument it.
    pub inspector_compatible: bool,
    /// Human-readable facts discovered during detection.
    pub reasons: Vec<String>,
}

pub trait ProjectAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn detect(&self, ctx: &DetectionContext) -> AdapterDetection;
}

/// Registry of all adapters, in priority order. First match wins.
pub fn adapters() -> Vec<Box<dyn ProjectAdapter>> {
    vec![Box::new(ViteAdapter)]
}
