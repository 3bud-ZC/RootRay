//! Single integration-test binary — keeps the compiled-exe count low.

#[path = "suite/app_core.rs"]
mod app_core;
#[path = "suite/filesystem.rs"]
mod filesystem;
#[path = "suite/golden_path.rs"]
mod golden_path;
#[path = "suite/process_lifecycle.rs"]
mod process_lifecycle;
#[path = "suite/project_analysis.rs"]
mod project_analysis;
#[path = "suite/runtime_state.rs"]
mod runtime_state;
#[path = "suite/settings.rs"]
mod settings;
#[path = "suite/url_detect.rs"]
mod url_detect;
