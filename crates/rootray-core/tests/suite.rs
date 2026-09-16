//! Single integration-test binary — keeps the compiled-exe count low.

#[path = "suite/app_core.rs"]
mod app_core;
#[path = "suite/filesystem.rs"]
mod filesystem;
#[path = "suite/golden_path.rs"]
mod golden_path;
#[path = "suite/inspector_bridge.rs"]
mod inspector_bridge;
#[path = "suite/inspector_launch.rs"]
mod inspector_launch;
#[path = "suite/process_lifecycle.rs"]
mod process_lifecycle;
#[path = "suite/process_containment.rs"]
mod process_containment;
#[path = "suite/project_nav.rs"]
mod project_nav;
#[path = "suite/project_analysis.rs"]
mod project_analysis;
#[path = "suite/runtime_state.rs"]
mod runtime_state;
#[path = "suite/settings.rs"]
mod settings;
#[path = "suite/source_edit.rs"]
mod source_edit;
#[path = "suite/url_detect.rs"]
mod url_detect;
#[path = "suite/workspace_discovery.rs"]
mod workspace_discovery;
