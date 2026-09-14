//! `AppCore` — the single orchestrator behind every native command.
//!
//! Owns the [`RuntimeState`] machine and the [`ProcessManager`]. The Tauri
//! layer supplies an [`EventSink`] that forwards events to the frontend;
//! AppCore itself updates the authoritative state before forwarding, so the
//! UI can always re-pull a consistent snapshot.

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::error::{CommandError, CoreError, CoreResult};
use crate::launcher::{self, DetectedLauncher};
use crate::process::{EventSink, ProcessEvent, ProcessManager};
use crate::project::{analyze_project, ProjectAnalysis};
use crate::settings::{Settings, SettingsStore};
use crate::state::{LogStream, RuntimePhase, RuntimeState};

pub struct AppCore {
    state: Arc<Mutex<RuntimeState>>,
    processes: Arc<ProcessManager>,
    settings: SettingsStore,
    /// Monotonic run id — guards against events from a previous process
    /// generation landing on a newer run.
    generation: Arc<Mutex<u64>>,
}

impl AppCore {
    pub fn new(settings_dir: &Path) -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState::default())),
            processes: Arc::new(ProcessManager::new()),
            settings: SettingsStore::new(settings_dir),
            generation: Arc::new(Mutex::new(0)),
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

    /// Analyzes `path`, updates the state machine and records the project
    /// in recents when usable.
    pub fn analyze(&self, path: &Path) -> CoreResult<ProjectAnalysis> {
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

        match analyze_project(path) {
            Ok(analysis) => {
                {
                    let mut s = self.lock_state()?;
                    s.project = Some(analysis.clone());
                    s.transition(RuntimePhase::Ready)?;
                }
                let _ = self.settings.push_recent_project(&analysis.root);
                Ok(analysis)
            }
            Err(e) => {
                let mut s = self.lock_state()?;
                s.project = None;
                s.set_error(CommandError::from(&e));
                let _ = s.transition(RuntimePhase::Failed);
                Err(e)
            }
        }
    }

    // --- process lifecycle -------------------------------------------------

    /// Starts the analyzed project's dev server. `hook` additionally
    /// receives every event (used by the Tauri layer to emit to the UI).
    pub fn start_dev_server(&self, hook: EventSink) -> CoreResult<u32> {
        let (cmd, gen) = {
            let mut s = self.lock_state()?;
            let project = s
                .project
                .as_ref()
                .ok_or(CoreError::NoProjectSelected)?;
            let cmd = project
                .dev_command
                .clone()
                .ok_or_else(|| Self::not_runnable_error(project))?;
            if self.processes.is_running() {
                return Err(CoreError::ProcessAlreadyRunning);
            }
            s.transition(RuntimePhase::Starting)?;
            let mut g = self.generation.lock().map_err(|_| CoreError::Internal("generation lock".into()))?;
            *g += 1;
            (cmd, *g)
        };

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
    pub fn restart_dev_server(&self, hook: EventSink) -> CoreResult<u32> {
        // stop() leaves phase = Stopped; start() handles the rest. From
        // Failed the process handle may be dead already — start anyway.
        if self.processes.is_running() {
            self.stop_dev_server()?;
        }
        self.start_dev_server(hook)
    }

    fn not_runnable_error(project: &ProjectAnalysis) -> CoreError {
        if !project.supported {
            CoreError::UnsupportedFramework(project.reasons.join("; "))
        } else if project.dev_script.is_none() {
            CoreError::NoDevScript
        } else {
            CoreError::PackageManagerUnknown
        }
    }

    /// Builds the event sink: applies the event to the state machine, then
    /// forwards to the host hook. Generation-checked.
    fn make_sink(&self, hook: EventSink, gen: u64) -> EventSink {
        let state = self.state.clone();
        let generation = self.generation.clone();
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
            s.project
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
            s.project
                .as_ref()
                .map(|p| p.root.clone())
                .ok_or(CoreError::NoProjectSelected)?
        };
        let safe = crate::filesystem::ensure_lexically_within_root(&root, path)?;
        let launcher = launcher::find_launcher(launcher_id)
            .ok_or_else(|| CoreError::LauncherNotFound(launcher_id.to_string()))?;
        launcher::open_path_in_launcher(&launcher, &safe)
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
