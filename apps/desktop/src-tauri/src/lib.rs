//! RootRay desktop shell — thin Tauri command layer over `rootray-core`.
//!
//! Security boundary: the frontend can only call the commands below. There
//! is deliberately no generic `execute(command)` — every operation is
//! application-specific and validates its inputs in the core.

use std::path::PathBuf;
use std::sync::Arc;

use rootray_core::app::SettingsUpdate;
use rootray_core::editor::{EditorSessionInfo, SourceFileHash, SourceFileRead, SourceFileWrite};
use rootray_core::filesystem::preview::SourcePreview;
use rootray_core::inspector::InspectorState;
use rootray_core::launcher::DetectedLauncher;
use rootray_core::process::{EventSink, ProcessEvent};
use rootray_core::project::ProjectAnalysis;
use rootray_core::settings::Settings;
use rootray_core::state::RuntimeState;
use rootray_core::{AppCore, CommandError};

use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_PROCESS: &str = "rootray://process-event";
const EVENT_STATE: &str = "rootray://state";
const EVENT_INSPECTOR: &str = "rootray://inspector-state";
const EVENT_EDITOR: &str = "rootray://editor-event";

type CmdResult<T> = Result<T, CommandError>;

/// Event sink that forwards process events + fresh state snapshots to the UI.
fn ui_sink(app: &AppHandle) -> EventSink {
    let app = app.clone();
    Arc::new(move |event: ProcessEvent| {
        let _ = app.emit(EVENT_PROCESS, &event);
        // Push a fresh state snapshot so the frontend never has to poll.
        if let Some(core) = app.try_state::<Arc<AppCore>>() {
            let _ = app.emit(EVENT_STATE, core.state());
        }
    })
}

#[tauri::command]
fn analyze_project(path: String, core: State<'_, Arc<AppCore>>) -> CmdResult<ProjectAnalysis> {
    core.analyze(std::path::Path::new(&path)).map_err(Into::into)
}

#[tauri::command]
fn start_dev_server(
    app: AppHandle,
    inspector: bool,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<u32> {
    core.start_dev_server(ui_sink(&app), inspector).map_err(Into::into)
}

#[tauri::command]
fn stop_dev_server(core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.stop_dev_server().map_err(Into::into)
}

#[tauri::command]
fn restart_dev_server(
    app: AppHandle,
    inspector: bool,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<u32> {
    core.restart_dev_server(ui_sink(&app), inspector).map_err(Into::into)
}

#[tauri::command]
fn get_runtime_state(core: State<'_, Arc<AppCore>>) -> RuntimeState {
    core.state()
}

#[tauri::command]
fn open_browser(url: String, core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.open_browser(&url).map_err(Into::into)
}

#[tauri::command]
fn detect_editors(core: State<'_, Arc<AppCore>>) -> Vec<DetectedLauncher> {
    core.detect_editors()
}

#[tauri::command]
fn open_in_editor(
    launcher_id: String,
    path: Option<String>,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<()> {
    match path {
        Some(p) => core
            .open_path_in_editor(&launcher_id, &PathBuf::from(p))
            .map_err(Into::into),
        None => core.open_project_in_editor(&launcher_id).map_err(Into::into),
    }
}

#[tauri::command]
fn open_source_location(
    launcher_id: String,
    relative_path: String,
    line: u32,
    column: u32,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<()> {
    core.open_source_location(&launcher_id, &relative_path, line, column)
        .map_err(Into::into)
}

// --- inspector --------------------------------------------------------------

#[tauri::command]
fn get_inspector_state(core: State<'_, Arc<AppCore>>) -> InspectorState {
    core.inspector_state()
}

#[tauri::command]
fn set_inspection(enabled: bool, core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.set_inspection(enabled).map_err(Into::into)
}

#[tauri::command]
fn clear_inspector_selection(core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.clear_inspector_selection().map_err(Into::into)
}

#[tauri::command]
fn read_source_preview(
    relative_path: String,
    line: u32,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourcePreview> {
    core.read_source_preview(&relative_path, line).map_err(Into::into)
}

// --- quick editor -------------------------------------------------------------
//
// The frontend passes only project-relative paths; every operation is
// re-validated inside the analyzed project root by the core. A browser
// message can never reach these — they are explicit UI-initiated calls.

#[tauri::command]
fn open_source_editor(
    relative_path: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileRead> {
    core.open_source_editor(&relative_path).map_err(Into::into)
}

#[tauri::command]
fn save_source_file(
    relative_path: String,
    content: String,
    expected_hash: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileWrite> {
    core.save_source_file(&relative_path, &content, &expected_hash)
        .map_err(Into::into)
}

#[tauri::command]
fn check_source_file(
    relative_path: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileHash> {
    core.check_source_file(&relative_path).map_err(Into::into)
}

#[tauri::command]
fn reload_source_file(
    relative_path: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileRead> {
    core.reload_source_file(&relative_path).map_err(Into::into)
}

#[tauri::command]
fn revert_source_save(
    relative_path: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileRead> {
    core.revert_source_save(&relative_path).map_err(Into::into)
}

/// Read-only fetch that leaves the edit session untouched — powers the
/// conflict "Compare" view.
#[tauri::command]
fn peek_source_file(
    relative_path: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<SourceFileRead> {
    core.peek_source_file(&relative_path).map_err(Into::into)
}

#[tauri::command]
fn close_source_editor(core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.close_source_editor();
    Ok(())
}

#[tauri::command]
fn get_editor_state(core: State<'_, Arc<AppCore>>) -> EditorSessionInfo {
    core.editor_session_info()
}

// --- project navigation -------------------------------------------------------
//
// Read-only, root-bounded navigation for the explorer, Quick Open,
// workspace search and component intelligence collection.

#[tauri::command]
fn list_project_dir(
    relative_dir: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<rootray_core::filesystem::nav::DirListing> {
    core.list_project_dir(&relative_dir).map_err(Into::into)
}

#[tauri::command]
fn list_project_files(
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<rootray_core::filesystem::nav::FileListing> {
    core.list_project_files().map_err(Into::into)
}

#[tauri::command]
fn search_workspace(
    query: String,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<rootray_core::filesystem::nav::SearchResult> {
    core.search_workspace(&query).map_err(Into::into)
}

#[tauri::command]
fn collect_source_files(
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<rootray_core::filesystem::nav::SourceCollection> {
    core.collect_source_files().map_err(Into::into)
}

/// Safe shell metadata for Copy Diagnostics — version and platform only.
/// No tokens, no paths, no environment variables.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
fn get_diagnostics() -> DiagnosticsInfo {
    DiagnosticsInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn get_settings(core: State<'_, Arc<AppCore>>) -> CmdResult<Settings> {
    core.settings().map_err(Into::into)
}

#[tauri::command]
fn update_settings(
    update: SettingsUpdate,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<Settings> {
    core.update_settings(update).map_err(Into::into)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Local settings live under the OS app-config dir.
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let core = Arc::new(AppCore::new(&dir));
            app.manage(core.clone());

            // Packaged installs ship the inspector bundles as resources —
            // point the core at them. Dev workspaces fall back to packages/.
            if let Ok(resource_dir) = app.path().resource_dir() {
                let assets = resource_dir.join("inspector-assets");
                if assets.is_dir() {
                    std::env::set_var("ROOTRAY_INSPECTOR_ASSETS_DIR", &assets);
                }
            }

            // Inspector state changes are pushed as full snapshots.
            let handle = app.handle().clone();
            let core_for_notify = core.clone();
            core.set_inspector_notify(Arc::new(move || {
                let _ = handle.emit(EVENT_INSPECTOR, core_for_notify.inspector_state());
            }));

            // Editor events (external file changes) go straight to the UI.
            let handle2 = app.handle().clone();
            core.set_editor_notify(Arc::new(move |event| {
                let _ = handle2.emit(EVENT_EDITOR, event);
            }));

            // If the window closes, make sure no dev server is orphaned.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_project,
            start_dev_server,
            stop_dev_server,
            restart_dev_server,
            get_runtime_state,
            open_browser,
            detect_editors,
            open_in_editor,
            open_source_location,
            get_inspector_state,
            set_inspection,
            clear_inspector_selection,
            read_source_preview,
            open_source_editor,
            save_source_file,
            check_source_file,
            reload_source_file,
            revert_source_save,
            peek_source_file,
            close_source_editor,
            get_editor_state,
            list_project_dir,
            list_project_files,
            search_workspace,
            collect_source_files,
            get_diagnostics,
            get_settings,
            update_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(core) = window.app_handle().try_state::<Arc<AppCore>>() {
                    // Best-effort cleanup — never leave orphan dev servers.
                    let _ = core.stop_dev_server();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running RootRay");
}
