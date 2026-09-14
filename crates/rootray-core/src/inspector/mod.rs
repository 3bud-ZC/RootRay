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
                Ok(SessionInfo { session_id, token, port })
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
