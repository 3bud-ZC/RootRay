//! RootRay desktop shell — thin Tauri command layer over `rootray-core`.
//!
//! Security boundary: the frontend can only call the commands below. There
//! is deliberately no generic `execute(command)` — every operation is
//! application-specific and validates its inputs in the core.

use std::path::PathBuf;
use std::sync::Arc;

use rootray_core::app::SettingsUpdate;
use rootray_core::launcher::DetectedLauncher;
use rootray_core::process::{EventSink, ProcessEvent};
use rootray_core::project::ProjectAnalysis;
use rootray_core::settings::Settings;
use rootray_core::state::RuntimeState;
use rootray_core::{AppCore, CommandError};

use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_PROCESS: &str = "rootray://process-event";
const EVENT_STATE: &str = "rootray://state";

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
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<u32> {
    core.start_dev_server(ui_sink(&app)).map_err(Into::into)
}

#[tauri::command]
fn stop_dev_server(core: State<'_, Arc<AppCore>>) -> CmdResult<()> {
    core.stop_dev_server().map_err(Into::into)
}

#[tauri::command]
fn restart_dev_server(
    app: AppHandle,
    core: State<'_, Arc<AppCore>>,
) -> CmdResult<u32> {
    core.restart_dev_server(ui_sink(&app)).map_err(Into::into)
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
            app.manage(core);

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
