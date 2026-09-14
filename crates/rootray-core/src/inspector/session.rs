//! Inspector session state — separate from the dev-server runtime state.
//!
//! A project can be *running* while the inspector is *waiting for a
//! browser*; these are different axes and are tracked independently.

use serde::Serialize;

use crate::error::CommandError;
use crate::inspector::protocol::ElementSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InspectorPhase {
    Inactive,
    Starting,
    WaitingForBrowser,
    Connected,
    Inspecting,
    Disconnected,
    Failed,
}

/// Serializable snapshot pushed to the frontend on every change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorState {
    pub phase: InspectorPhase,
    pub session_id: Option<String>,
    /// Loopback bridge port, when a session is live.
    pub port: Option<u16>,
    /// URL of the page that authenticated.
    pub page_url: Option<String>,
    /// Unix epoch millis when the runtime authenticated.
    pub connected_at: Option<u64>,
    pub inspection_enabled: bool,
    pub last_selection: Option<ElementSelection>,
    /// Machine-readable reason the inspector is unavailable/failed.
    pub error: Option<CommandError>,
}

impl Default for InspectorState {
    fn default() -> Self {
        Self {
            phase: InspectorPhase::Inactive,
            session_id: None,
            port: None,
            page_url: None,
            connected_at: None,
            inspection_enabled: false,
            last_selection: None,
            error: None,
        }
    }
}

impl InspectorState {
    pub fn connected(&self) -> bool {
        matches!(
            self.phase,
            InspectorPhase::Connected | InspectorPhase::Inspecting
        )
    }
}
