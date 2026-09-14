use super::{AdapterDetection, DetectionContext, Framework, ProjectAdapter};

const VITE_CONFIG_EXTS: &[&str] = &["ts", "js", "mts", "mjs", "cts", "cjs"];

/// Detects Vite projects and refines to `vite-react` when React is present.
pub struct ViteAdapter;

impl ProjectAdapter for ViteAdapter {
    fn id(&self) -> &'static str {
        "vite"
    }

    fn detect(&self, ctx: &DetectionContext) -> AdapterDetection {
        let pkg = ctx.package_json;
        let mut reasons = Vec::new();

        let has_vite = pkg.has_dependency("vite");
        if !has_vite {
            return AdapterDetection {
                matched: false,
                framework: Framework::Unknown,
                inspector_compatible: false,
                reasons: vec!["\"vite\" is not declared in package.json dependencies".to_string()],
            };
        }
        reasons.push("\"vite\" found in package.json dependencies".to_string());

        match ctx.has_config_file("vite.config", VITE_CONFIG_EXTS) {
            Some(file) => reasons.push(format!("found {file}")),
            None => reasons.push(
                "no vite.config.* file found (Vite works without one)".to_string(),
            ),
        }

        let has_react = pkg.has_dependency("react") || pkg.has_dependency("react-dom");
        let framework = if has_react {
            reasons.push("\"react\" found in package.json dependencies".to_string());
            Framework::ViteReact
        } else {
            reasons.push(
                "\"react\" not found — treating as a plain Vite project".to_string(),
            );
            Framework::Vite
        };

        AdapterDetection {
            matched: true,
            framework,
            inspector_compatible: framework == Framework::ViteReact,
            reasons,
        }
    }
}
