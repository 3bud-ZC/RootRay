//! Inspector engine: local bridge, session model, launch plumbing.
//!
//! The browser runtime connects to [`bridge::BridgeHandle`] over an
//! authenticated loopback WebSocket. [`InspectorManager`] owns the session
//! lifecycle and the serializable [`InspectorState`] pushed to the
//! frontend.

pub mod bridge;
pub mod launch;
pub mod protocol;
pub mod session;

use std::sync::{Arc, Mutex};

use bridge::{BridgeEvent, BridgeHandle};
pub use launch::{resolve_assets, InspectorAssets, InspectorLaunchInfo};
pub use session::{InspectorPhase, InspectorState};

use crate::error::{CommandError, CoreError, CoreResult};

/// Credentials + endpoint for a live session, passed to the dev runner.
pub struct SessionInfo {
    pub session_id: String,
    pub token: String,
    pub port: u16,
    /// Absolute active-target root — stamped into the runtime bootstrap so
    /// adapters can relativize paths the browser reports back.
    pub target_root: Option<std::path::PathBuf>,
    /// Workspace root — bounds adapter ancestor searches (monorepo
    /// hoisting). Never escaped.
    pub workspace_root: Option<std::path::PathBuf>,
}

type Notify = Arc<dyn Fn() + Send + Sync>;

/// Owns the inspector session for the current project run.
/// Internally shared (`Clone`) so the process-event sink can shut it down.
#[derive(Clone)]
pub struct InspectorManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    state: Mutex<InspectorState>,
    bridge: Mutex<Option<BridgeHandle>>,
    notify: Mutex<Option<Notify>>,
    /// Session-owned scratch dirs (e.g. the Next adapter's generated
    /// entry under `node_modules/.cache/rootray-<sid>`). Removed on
    /// shutdown and swept before the next session starts.
    scratch: Mutex<Vec<std::path::PathBuf>>,
}

impl Default for InspectorManager {
    fn default() -> Self {
        Self::new()
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cryptographically strong ephemeral token (32 bytes → hex).
fn random_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::fill(&mut buf).is_err() {
        // getrandom only fails when the OS has no RNG — degrade to a
        // still-unguessable-enough fallback rather than panic.
        return format!("{:x}{:x}", now_millis(), std::process::id());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_session_id() -> String {
    let mut buf = [0u8; 8];
    let _ = getrandom::fill(&mut buf);
    format!(
        "rs-{}",
        buf.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

impl InspectorManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                state: Mutex::new(InspectorState::default()),
                bridge: Mutex::new(None),
                notify: Mutex::new(None),
                scratch: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Registers the host callback fired after every state change
    /// (the Tauri layer re-emits a fresh `InspectorState` snapshot).
    pub fn set_notify(&self, notify: Notify) {
        if let Ok(mut slot) = self.inner.notify.lock() {
            *slot = Some(notify);
        }
    }

    fn emit(&self) {
        if let Ok(guard) = self.inner.notify.lock() {
            if let Some(n) = guard.as_ref() {
                n();
            }
        }
    }

    fn lock_state(&self) -> CoreResult<std::sync::MutexGuard<'_, InspectorState>> {
        self.inner
            .state
            .lock()
            .map_err(|_| CoreError::Internal("inspector state lock poisoned".into()))
    }

    pub fn state(&self) -> InspectorState {
        self.lock_state()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    /// Registers adapter-owned scratch dirs for removal when the session
    /// ends. Never used for project files — only dirs the adapter itself
    /// created (node_modules/.cache/rootray-*, .next/rootray-*).
    pub fn register_scratch(&self, dirs: Vec<std::path::PathBuf>) {
        if let Ok(mut slot) = self.inner.scratch.lock() {
            slot.extend(dirs);
        }
    }

    /// Deletes every registered scratch dir (idempotent, missing-ok).
    fn cleanup_scratch(inner: &ManagerInner) {
        let dirs = match inner.scratch.lock() {
            Ok(mut slot) => std::mem::take(&mut *slot),
            Err(_) => return,
        };
        for d in dirs {
            // Only ever remove RootRay-named dirs — a misregistered path
            // must never turn session cleanup into arbitrary deletion.
            let ours = d
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rootray-"));
            if ours {
                let _ = std::fs::remove_dir_all(&d);
            }
        }
    }

    /// Starts a fresh inspector session: dynamic loopback port + new
    /// credentials. Any previous session is torn down first.
    pub fn start_session(&self) -> CoreResult<SessionInfo> {
        self.shutdown();

        let session_id = random_session_id();
        let token = random_token();

        {
            let mut s = self.lock_state()?;
            s.phase = InspectorPhase::Starting;
            s.session_id = Some(session_id.clone());
        }

        let inner = self.inner.clone();
        let on_event: bridge::BridgeEventSink = Arc::new(move |ev| {
            Self::handle_bridge_event(&inner, ev);
        });

        match BridgeHandle::start(session_id.clone(), token.clone(), on_event) {
            Ok(handle) => {
                let port = handle.port();
                if let Ok(mut slot) = self.inner.bridge.lock() {
                    *slot = Some(handle);
                }
                {
                    let mut s = self.lock_state()?;
                    s.phase = InspectorPhase::WaitingForBrowser;
                    s.port = Some(port);
                    s.error = None;
                }
                self.emit();
                Ok(SessionInfo {
                    session_id,
                    token,
                    port,
                    target_root: None,
                    workspace_root: None,
                })
            }
            Err(e) => {
                self.fail(&format!("{e}"));
                Err(e)
            }
        }
    }

    fn handle_bridge_event(inner: &Arc<ManagerInner>, ev: BridgeEvent) {
        let notify = {
            let mut s = match inner.state.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            match ev {
                BridgeEvent::Connected { page_url } => {
                    s.page_url = Some(page_url);
                    s.connected_at = Some(now_millis());
                    s.phase = if s.inspection_enabled {
                        InspectorPhase::Inspecting
                    } else {
                        InspectorPhase::Connected
                    };
                }
                BridgeEvent::Disconnected => {
                    if s.connected() {
                        s.phase = InspectorPhase::Disconnected;
                    }
                }
                BridgeEvent::Selection(sel) => {
                    s.last_selection = Some(sel);
                }
                BridgeEvent::InspectRequested { enabled } => {
                    s.inspection_enabled = enabled;
                    if s.connected() {
                        s.phase = if enabled {
                            InspectorPhase::Inspecting
                        } else {
                            InspectorPhase::Connected
                        };
                    }
                }
            }
            inner.notify.lock().ok().and_then(|g| g.clone())
        };
        if let Some(n) = notify {
            n();
        }
    }

    /// Turns inspection on/off. The flag is stored even while waiting for
    /// the browser — it syncs on connect.
    pub fn set_inspection(&self, enabled: bool) -> CoreResult<()> {
        {
            let mut s = self.lock_state()?;
            if !matches!(
                s.phase,
                InspectorPhase::WaitingForBrowser
                    | InspectorPhase::Connected
                    | InspectorPhase::Inspecting
                    | InspectorPhase::Disconnected
            ) {
                return Err(CoreError::InspectorNotActive);
            }
            s.inspection_enabled = enabled;
            if s.connected() {
                s.phase = if enabled {
                    InspectorPhase::Inspecting
                } else {
                    InspectorPhase::Connected
                };
            }
        }
        if let Ok(guard) = self.inner.bridge.lock() {
            if let Some(b) = guard.as_ref() {
                b.send_inspect(enabled);
            }
        }
        self.emit();
        Ok(())
    }

    pub fn clear_selection(&self) -> CoreResult<()> {
        {
            let mut s = self.lock_state()?;
            s.last_selection = None;
        }
        self.emit();
        Ok(())
    }

    /// Marks the session failed with a curated reason (e.g. launch fell
    /// back to the plain dev server).
    pub fn fail(&self, reason: &str) {
        if let Ok(mut slot) = self.inner.bridge.lock() {
            if let Some(b) = slot.take() {
                b.shutdown();
            }
        }
        if let Ok(mut s) = self.inner.state.lock() {
            s.phase = InspectorPhase::Failed;
            s.error = Some(CommandError::from(&CoreError::InspectorUnavailable(
                reason.to_string(),
            )));
        }
        self.emit();
    }

    /// Tears down the session entirely (dev server stopped/exited).
    /// `last_selection` is retained so the UI keeps showing context.
    pub fn shutdown(&self) {
        Self::cleanup_scratch(&self.inner);
        if let Ok(mut slot) = self.inner.bridge.lock() {
            if let Some(b) = slot.take() {
                b.shutdown();
            }
        }
        if let Ok(mut s) = self.inner.state.lock() {
            s.phase = InspectorPhase::Inactive;
            s.session_id = None;
            s.port = None;
            s.page_url = None;
            s.connected_at = None;
            s.inspection_enabled = false;
        }
        self.emit();
    }

    /// Process exited or was stopped — same as `shutdown` but keeps the
    /// phase semantics explicit for callers.
    pub fn on_process_exit(&self) {
        self.shutdown();
    }
}
