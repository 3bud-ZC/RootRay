//! `AppCore` — the single orchestrator behind every native command.
//!
//! Owns the [`RuntimeState`] machine and the [`ProcessManager`]. The Tauri
//! layer supplies an [`EventSink`] that forwards events to the frontend;
//! AppCore itself updates the authoritative state before forwarding, so the
//! UI can always re-pull a consistent snapshot.

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::editor::{EditorEvent, EditorManager, EditorSessionInfo};
use crate::error::{CommandError, CoreError, CoreResult};
use crate::inspector::{InspectorManager, InspectorState};
use crate::launcher::{self, DetectedLauncher};
use crate::process::{EventSink, ProcessEvent, ProcessManager};
use crate::project::{
    analyze_workspace, DevCommand, ProjectTarget, WorkspaceAnalysis,
};
use crate::settings::{Settings, SettingsStore};
use crate::state::{LogStream, RuntimePhase, RuntimeState};

pub struct AppCore {
    state: Arc<Mutex<RuntimeState>>,
    processes: Arc<ProcessManager>,
    settings: SettingsStore,
    inspector: InspectorManager,
    editor: EditorManager,
    /// Monotonic run id — guards against events from a previous process
    /// generation landing on a newer run.
    generation: Arc<Mutex<u64>>,
    /// Host hook fired after synchronous RuntimeState mutations that have
    /// no process-event path (e.g. project analysis) — the Tauri layer
    /// re-emits the state snapshot so the frontend never goes stale.
    state_notify: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl AppCore {
    pub fn new(settings_dir: &Path) -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState::default())),
            processes: Arc::new(ProcessManager::new()),
            settings: SettingsStore::new(settings_dir),
            inspector: InspectorManager::new(),
            editor: EditorManager::new(),
            generation: Arc::new(Mutex::new(0)),
            state_notify: Mutex::new(None),
        }
    }

    pub fn with_url_timeout(settings_dir: &Path, timeout: std::time::Duration) -> Self {
        Self {
            processes: Arc::new(ProcessManager::new().with_url_timeout(timeout)),
            ..Self::new(settings_dir)
        }
    }

    fn lock_state(&self) -> CoreResult<std::sync::MutexGuard<'_, RuntimeState>> {
        self.state
            .lock()
            .map_err(|_| CoreError::Internal("state lock poisoned".into()))
    }

    pub fn state(&self) -> RuntimeState {
        self.lock_state()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    // --- project ----------------------------------------------------------

    /// Analyzes `path` as a universal workspace, updates the state
    /// machine and records the workspace in recents.
    pub fn analyze(&self, path: &Path) -> CoreResult<WorkspaceAnalysis> {
        {
            let mut s = self.lock_state()?;
            if s.phase != RuntimePhase::Idle {
                // Re-analysis is allowed from ready/stopped/failed; blocked
                // while a server is live.
                if matches!(s.phase, RuntimePhase::Running | RuntimePhase::Starting | RuntimePhase::Stopping) {
                    return Err(CoreError::IllegalTransition {
                        from: format!("{:?}", s.phase).to_lowercase(),
                        to: "analyzing".into(),
                    });
                }
                if s.phase != RuntimePhase::Analyzing {
                    s.transition(RuntimePhase::Analyzing)?;
                }
            } else {
                s.transition(RuntimePhase::Analyzing)?;
            }
        }

        match analyze_workspace(path) {
            Ok(analysis) => {
                {
                    let mut s = self.lock_state()?;
                    s.workspace = Some(analysis.clone());
                    s.transition(RuntimePhase::Ready)?;
                }
                let _ = self.settings.push_recent_project(&analysis.root);
                self.notify_state_changed();
                Ok(analysis)
            }
            Err(e) => {
                {
                    let mut s = self.lock_state()?;
                    s.workspace = None;
                    s.set_error(CommandError::from(&e));
                    let _ = s.transition(RuntimePhase::Failed);
                }
                self.notify_state_changed();
                Err(e)
            }
        }
    }

    /// Registers the host hook fired after synchronous state mutations.
    /// Must be called after the lock is released — the host re-reads
    /// `state()` inside the callback.
    pub fn set_state_notify(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut n) = self.state_notify.lock() {
            *n = Some(notify);
        }
    }

    fn notify_state_changed(&self) {
        if let Ok(n) = self.state_notify.lock() {
            if let Some(f) = n.as_ref() {
                f();
            }
        }
    }

    // --- active target -------------------------------------------------------

    /// Switches the active target inside the current workspace.
    ///
    /// Only target-level concerns change (framework info, dev command,
    /// runtime actions). The workspace root — which is also the
    /// filesystem security root — never moves.
    pub fn set_active_target(&self, target_id: &str) -> CoreResult<WorkspaceAnalysis> {
        let mut s = self.lock_state()?;
        let workspace = s
            .workspace
            .as_mut()
            .ok_or(CoreError::NoProjectSelected)?;
        if !workspace.targets.iter().any(|t| t.id == target_id) {
            return Err(CoreError::WorkspaceTargetNotFound(target_id.to_string()));
        }
        workspace.active_target_id = Some(target_id.to_string());
        let snapshot = workspace.clone();
        drop(s);
        self.notify_state_changed();
        Ok(snapshot)
    }

    // --- process lifecycle -------------------------------------------------

    /// Starts the analyzed project's dev server. `hook` additionally
    /// receives every event (used by the Tauri layer to emit to the UI).
    ///
    /// When `inspector_enabled` and the project is inspector-compatible,
    /// RootRay starts an authenticated bridge session and launches Vite
    /// through the inspector runner; on any incompatibility it falls back
    /// to the plain dev command and reports `INSPECTOR_UNAVAILABLE`.
    pub fn start_dev_server(&self, hook: EventSink, inspector_enabled: bool) -> CoreResult<u32> {
        let (mut cmd, gen, target, workspace_root) = {
            let mut s = self.lock_state()?;
            let workspace = s
                .workspace
                .clone()
                .ok_or(CoreError::NoProjectSelected)?;
            let target = workspace
                .active_target()
                .cloned()
                .ok_or(CoreError::TargetRunnerUnavailable)?;
            let cmd = target
                .selected_runner
                .clone()
                .ok_or_else(|| Self::not_runnable_error(&target))?;
            if self.processes.is_running() {
                return Err(CoreError::ProcessAlreadyRunning);
            }
            s.transition(RuntimePhase::Starting)?;
            let mut g = self.generation.lock().map_err(|_| CoreError::Internal("generation lock".into()))?;
            *g += 1;
            (cmd, *g, target, workspace.root.clone())
        };

        if inspector_enabled
            && crate::inspector::launch::InspectorAdapter::for_framework(&target.framework)
                .is_some()
        {
            match self.inspector_launch_command(&target, &workspace_root) {
                Ok(Some(icmd)) => cmd = icmd,
                Ok(None) => {}
                Err(reason) => self.push_stderr_log(&format!(
                    "[rootray] inspector unavailable: {reason} — running without instrumentation"
                )),
            }
        }

        let sink = self.make_sink(hook, gen);
        match self.processes.start(&cmd, sink) {
            Ok(pid) => {
                let mut s = self.lock_state()?;
                if s.phase == RuntimePhase::Starting {
                    s.set_running(pid, cmd.display.clone());
                    s.transition_unchecked(RuntimePhase::Running);
                }
                Ok(pid)
            }
            Err(e) => {
                self.inspector.on_process_exit();
                let mut s = self.lock_state()?;
                s.set_error(CommandError::from(match &e {
                    CoreError::ProcessStartFailed(m) => {
                        CoreError::ProcessStartFailed(m.clone())
                    }
                    other => CoreError::Internal(other.to_string()),
                }));
                let _ = s.transition(RuntimePhase::Failed);
                Err(e)
            }
        }
    }

    /// Builds the inspector-enabled dev command for the active target.
    /// `Ok(None)` keeps the plain command silently; `Err(reason)` reports
    /// why the inspector could not be used.
    fn inspector_launch_command(
        &self,
        target: &ProjectTarget,
        workspace_root: &std::path::Path,
    ) -> Result<Option<DevCommand>, String> {
        let assets = crate::inspector::resolve_assets()
            .ok_or_else(|| "inspector assets not found (run pnpm build)".to_string())?;
        let mut info = self
            .inspector
            .start_session()
            .map_err(|e| format!("bridge failed: {e}"))?;
        info.target_root = Some(target.absolute_root.clone());
        info.workspace_root = Some(workspace_root.to_path_buf());
        self.inspector
            .set_session_roots(target.absolute_root.clone(), workspace_root.to_path_buf());
        match crate::inspector::launch::inspector_dev_command(target, &info, &assets) {
            Ok(Some((cmd, artifacts))) => {
                self.inspector.register_scratch(artifacts.scratch);
                self.inspector.register_entry_stubs(artifacts.stubs);
                Ok(Some(cmd))
            }
            Ok(None) => {
                self.inspector.on_process_exit();
                Ok(None)
            }
            Err(reason) => {
                // Tear down the just-started session so no scratch dirs,
                // bridge handle or session roots linger.
                self.inspector.on_process_exit();
                self.inspector.fail(&reason);
                Err(reason)
            }
        }
    }

    fn push_stderr_log(&self, line: &str) {
        if let Ok(mut s) = self.lock_state() {
            s.push_log(LogStream::Stderr, line.to_string());
        }
    }

    /// Stops the running dev server (no-op-safe error if none).
    pub fn stop_dev_server(&self) -> CoreResult<()> {
        {
            let mut s = self.lock_state()?;
            match s.phase {
                RuntimePhase::Running | RuntimePhase::Starting => {
                    s.transition(RuntimePhase::Stopping)?;
                }
                _ => return Err(CoreError::ProcessNotRunning),
            }
        }
        match self.processes.stop() {
            Ok(()) => {
                self.inspector.on_process_exit();
                let mut s = self.lock_state()?;
                if s.phase == RuntimePhase::Stopping {
                    s.transition(RuntimePhase::Stopped)?;
                }
                Ok(())
            }
            Err(e) => {
                let mut s = self.lock_state()?;
                s.set_error(CommandError::from(CoreError::Internal(e.to_string())));
                let _ = s.transition(RuntimePhase::Failed);
                Err(e)
            }
        }
    }

    /// Restarts the dev server — works from `running`, `stopped` and
    /// `failed` states.
    pub fn restart_dev_server(&self, hook: EventSink, inspector_enabled: bool) -> CoreResult<u32> {
        // stop() leaves phase = Stopped; start() handles the rest. From
        // Failed the process handle may be dead already — start anyway.
        if self.processes.is_running() {
            self.stop_dev_server()?;
        }
        self.start_dev_server(hook, inspector_enabled)
    }

    /// Why the active target cannot be run — a typed error, never a
    /// global "unsupported" verdict on the workspace.
    fn not_runnable_error(target: &ProjectTarget) -> CoreError {
        if !target.runner_candidates.is_empty()
            && target.package_manager == crate::project::package_manager::PackageManager::Unknown
        {
            CoreError::PackageManagerUnknown
        } else {
            CoreError::TargetRunnerUnavailable
        }
    }

    /// Builds the event sink: applies the event to the state machine, then
    /// forwards to the host hook. Generation-checked.
    fn make_sink(&self, hook: EventSink, gen: u64) -> EventSink {
        let state = self.state.clone();
        let generation = self.generation.clone();
        let inspector = self.inspector.clone();
        Arc::new(move |event: ProcessEvent| {
            {
                let current_gen = generation.lock().map(|g| *g).unwrap_or(0);
                if current_gen != gen {
                    return; // stale process generation — ignore
                }
                if let Ok(mut s) = state.lock() {
                    match &event {
                        ProcessEvent::Stdout { line } => {
                            s.push_log(LogStream::Stdout, line.clone());
                        }
                        ProcessEvent::Stderr { line } => {
                            s.push_log(LogStream::Stderr, line.clone());
                        }
                        ProcessEvent::UrlDetected { url, port } => {
                            s.set_url(url.clone(), *port);
                            s.push_log(
                                LogStream::Stdout,
                                format!("[rootray] local URL detected: {url}"),
                            );
                        }
                        ProcessEvent::UrlTimeout => {
                            s.push_log(
                                LogStream::Stderr,
                                "[rootray] no local URL detected yet — server is still running"
                                    .to_string(),
                            );
                        }
                        ProcessEvent::Exited { code, clean } => {
                            inspector.on_process_exit();
                            s.push_log(
                                LogStream::Stderr,
                                format!("[rootray] process exited (code {code:?})"),
                            );
                            match s.phase {
                                RuntimePhase::Stopping => {
                                    s.transition_unchecked(RuntimePhase::Stopped)
                                }
                                RuntimePhase::Running | RuntimePhase::Starting => {
                                    if *clean {
                                        s.transition_unchecked(RuntimePhase::Stopped);
                                    } else {
                                        // Missing node_modules is the most common
                                        // early-exit cause — tell the user the
                                        // expected fix command, never run it.
                                        let deps_hint = s.workspace.as_ref().and_then(|w| {
                                            let t = w.active_target()?;
                                            (!t.absolute_root.join("node_modules").is_dir())
                                                .then(|| {
                                                    format!(
                                                        "[rootray] dependencies appear to be \
                                                         missing — run `{} install` in this \
                                                         project, then try again",
                                                        t.package_manager.display_name()
                                                    )
                                                })
                                        });
                                        if let Some(hint) = deps_hint {
                                            s.push_log(LogStream::Stderr, hint);
                                        }
                                        s.set_error(CommandError::from(
                                            CoreError::ProcessExited(*code),
                                        ));
                                        s.transition_unchecked(RuntimePhase::Failed);
                                    }
                                }
                                _ => {}
                            }
                        }
                        ProcessEvent::StartFailed { message } => {
                            s.set_error(CommandError::from(CoreError::ProcessStartFailed(
                                message.clone(),
                            )));
                            s.transition_unchecked(RuntimePhase::Failed);
                        }
                    }
                }
            }
            hook(event);
        })
    }

    // --- launchers ---------------------------------------------------------

    pub fn detect_editors(&self) -> Vec<DetectedLauncher> {
        launcher::detect_launchers()
    }

    /// Opens the analyzed project root in the selected editor.
    /// The path is always the canonicalized, boundary-checked root.
    pub fn open_project_in_editor(&self, launcher_id: &str) -> CoreResult<()> {
        let root = {
            let s = self.lock_state()?;
            s.workspace
                .as_ref()
                .map(|p| p.root.clone())
                .ok_or(CoreError::NoProjectSelected)?
        };
        let launcher = launcher::find_launcher(launcher_id)
            .ok_or_else(|| CoreError::LauncherNotFound(launcher_id.to_string()))?;
        launcher::open_path_in_launcher(&launcher, &root)
    }

    /// Opens a file inside the project — boundary-checked against the root.
    pub fn open_path_in_editor(&self, launcher_id: &str, path: &Path) -> CoreResult<()> {
        let root = {
            let s = self.lock_state()?;
            s.workspace
                .as_ref()
                .map(|p| p.root.clone())
                .ok_or(CoreError::NoProjectSelected)?
        };
        let safe = crate::filesystem::ensure_lexically_within_root(&root, path)?;
        let launcher = launcher::find_launcher(launcher_id)
            .ok_or_else(|| CoreError::LauncherNotFound(launcher_id.to_string()))?;
        launcher::open_path_in_launcher(&launcher, &safe)
    }

    /// Opens a project file at an exact `line:column` in the editor.
    /// The path is validated inside the project root before launch.
    pub fn open_source_location(
        &self,
        launcher_id: &str,
        relative_path: &str,
        line: u32,
        column: u32,
    ) -> CoreResult<()> {
        let root = self.project_root()?;
        if !crate::inspector::protocol::is_safe_relative_path(relative_path) {
            return Err(CoreError::ProjectOutsideAllowedRoot(relative_path.to_string()));
        }
        let safe = crate::filesystem::ensure_within_root(&root, &root.join(relative_path))?;
        let launcher = launcher::find_launcher(launcher_id)
            .ok_or_else(|| CoreError::LauncherNotFound(launcher_id.to_string()))?;
        launcher::open_location_in_launcher(&launcher, &safe, line, column)
            .map_err(|e| CoreError::EditorOpenFailed(e.to_string()))
    }

    // --- inspector -----------------------------------------------------------

    /// Registers the host callback fired on every inspector state change.
    pub fn set_inspector_notify(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        self.inspector.set_notify(notify);
    }

    pub fn inspector_state(&self) -> InspectorState {
        self.inspector.state()
    }

    pub fn set_inspection(&self, enabled: bool) -> CoreResult<()> {
        self.inspector.set_inspection(enabled)
    }

    pub fn clear_inspector_selection(&self) -> CoreResult<()> {
        self.inspector.clear_selection()
    }

    /// Read-only preview around a source line. Desktop-initiated only —
    /// browser events never reach this path.
    pub fn read_source_preview(
        &self,
        relative_path: &str,
        line: u32,
    ) -> CoreResult<crate::filesystem::preview::SourcePreview> {
        let root = self.project_root()?;
        crate::filesystem::preview::read_source_preview(&root, relative_path, line)
    }

    // --- quick editor ------------------------------------------------------

    /// Registers the host callback fired on editor events (external
    /// change notifications for the open file).
    pub fn set_editor_notify(&self, notify: Arc<dyn Fn(&EditorEvent) + Send + Sync>) {
        self.editor.set_notify(notify);
    }

    /// Opens a project source file for Quick Edit: validates, reads,
    /// hashes and starts watching it for external changes.
    pub fn open_source_editor(
        &self,
        relative_path: &str,
    ) -> CoreResult<crate::editor::SourceFileRead> {
        let root = self.project_root()?;
        self.editor.open(&root, relative_path)
    }

    /// Optimistic-concurrency save through the open edit session.
    pub fn save_source_file(
        &self,
        relative_path: &str,
        content: &str,
        expected_hash: &str,
    ) -> CoreResult<crate::editor::SourceFileWrite> {
        let root = self.project_root()?;
        self.editor.save(&root, relative_path, content, expected_hash)
    }

    /// Current disk hash for the open file.
    pub fn check_source_file(
        &self,
        relative_path: &str,
    ) -> CoreResult<crate::editor::SourceFileHash> {
        let root = self.project_root()?;
        self.editor.check(&root, relative_path)
    }

    /// Re-reads the open file and rebases the session ("Reload Disk
    /// Version" — for clean auto-reload and conflict resolution alike).
    pub fn reload_source_file(
        &self,
        relative_path: &str,
    ) -> CoreResult<crate::editor::SourceFileRead> {
        let root = self.project_root()?;
        self.editor.reload(&root, relative_path)
    }

    /// Restores the bytes that preceded RootRay's last save — refused if
    /// the disk has since diverged from RootRay's last write.
    pub fn revert_source_save(
        &self,
        relative_path: &str,
    ) -> CoreResult<crate::editor::SourceFileRead> {
        let root = self.project_root()?;
        self.editor.revert_last_save(&root, relative_path)
    }

    /// Closes the edit session and stops the watcher.
    pub fn close_source_editor(&self) {
        self.editor.close();
    }

    /// Read-only fetch of a project source file that does NOT touch the
    /// edit session — used by the conflict "Compare" view so unsaved
    /// editor content and the save baseline stay intact.
    pub fn peek_source_file(
        &self,
        relative_path: &str,
    ) -> CoreResult<crate::editor::SourceFileRead> {
        let root = self.project_root()?;
        crate::editor::file::read_source_file(&root, relative_path)
    }

    // --- project navigation ---------------------------------------------------
    //
    // Read-only, project-root bounded navigation APIs for the explorer,
    // Quick Open, workspace search and component intelligence. Every call
    // re-derives the root from the trusted runtime state.

    /// Lists one directory level — lazy explorer rows.
    pub fn list_project_dir(
        &self,
        relative_dir: &str,
    ) -> CoreResult<crate::filesystem::nav::DirListing> {
        let root = self.project_root()?;
        crate::filesystem::nav::list_project_dir(&root, relative_dir)
    }

    /// Bounded flat listing of editable files — powers Ctrl+P.
    pub fn list_project_files(&self) -> CoreResult<crate::filesystem::nav::FileListing> {
        let root = self.project_root()?;
        crate::filesystem::nav::list_project_files(&root)
    }

    /// Bounded text search across safe source files.
    pub fn search_workspace(&self, query: &str) -> CoreResult<crate::filesystem::nav::SearchResult> {
        let root = self.project_root()?;
        crate::filesystem::nav::search_workspace(&root, query)
    }

    /// Bounded collection of JS/TS sources for frontend-side static
    /// analysis. Returns file contents as data — nothing is executed.
    pub fn collect_source_files(
        &self,
    ) -> CoreResult<crate::filesystem::nav::SourceCollection> {
        let root = self.project_root()?;
        crate::filesystem::nav::collect_source_files(&root)
    }

    pub fn editor_session_info(&self) -> EditorSessionInfo {
        match self.project_root() {
            Ok(root) => self.editor.info(&root),
            Err(_) => EditorSessionInfo {
                open: false,
                relative_path: None,
                base_hash: None,
                disk_hash: None,
                watching: false,
                can_revert: false,
            },
        }
    }

    /// The workspace root — also the filesystem security root. Runtime
    /// actions may target a nested package, but every file operation is
    /// still bounded by the directory the user originally selected.
    fn project_root(&self) -> CoreResult<std::path::PathBuf> {
        let s = self.lock_state()?;
        s.workspace
            .as_ref()
            .map(|w| w.root.clone())
            .ok_or(CoreError::NoProjectSelected)
    }

    // --- browser -----------------------------------------------------------

    /// Validates and opens a URL in the system browser.
    /// Only loopback http(s) URLs pass — remote URLs are refused.
    pub fn open_browser(&self, url: &str) -> CoreResult<()> {
        if !crate::process::url_detect::is_safe_local_url(url) {
            return Err(CoreError::LocalUrlNotDetected);
        }
        open_url_in_browser(url)
    }

    // --- settings ------------------------------------------------------------

    pub fn settings(&self) -> CoreResult<Settings> {
        self.settings.load()
    }

    pub fn update_settings(&self, update: SettingsUpdate) -> CoreResult<Settings> {
        if let Some(launcher) = update.preferred_launcher {
            if launcher.is_empty() {
                self.settings.set_preferred_launcher(None)?;
            } else {
                self.settings.set_preferred_launcher(Some(&launcher))?;
            }
        }
        if let Some(v) = update.open_browser_automatically {
            self.settings.set_open_browser_automatically(v)?;
        }
        if update.clear_recent_projects {
            self.settings.clear_recent_projects()?;
        }
        if let Some(p) = update.remove_recent_project {
            self.settings.remove_recent_project(Path::new(&p))?;
        }
        self.settings.load()
    }
}

/// Partial settings update from the frontend.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsUpdate {
    pub preferred_launcher: Option<String>,
    pub open_browser_automatically: Option<bool>,
    pub clear_recent_projects: bool,
    pub remove_recent_project: Option<String>,
}

/// Opens a URL with the OS handler without going through a shell string.
#[cfg(windows)]
fn open_url_in_browser(url: &str) -> CoreResult<()> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map(|_| ())
        .map_err(|e| CoreError::Internal(format!("failed to open browser: {e}")))
}

#[cfg(target_os = "macos")]
fn open_url_in_browser(url: &str) -> CoreResult<()> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| CoreError::Internal(format!("failed to open browser: {e}")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_in_browser(url: &str) -> CoreResult<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| CoreError::Internal(format!("failed to open browser: {e}")))
}
