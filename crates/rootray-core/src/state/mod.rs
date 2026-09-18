//! Runtime state machine.
//!
//! A single explicit phase model — no `isLoading`/`isStarted` booleans.
//! Illegal transitions return [`CoreError::IllegalTransition`] instead of
//! silently corrupting state.

use std::collections::VecDeque;

use serde::Serialize;

use crate::error::{CommandError, CoreError, CoreResult};
use crate::project::WorkspaceAnalysis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePhase {
    Idle,
    Analyzing,
    Ready,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl RuntimePhase {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Analyzing => "analyzing",
            Self::Ready => "ready",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

/// Legal transitions. Anything not listed here is rejected.
fn can_transition(from: RuntimePhase, to: RuntimePhase) -> bool {
    use RuntimePhase::*;
    matches!(
        (from, to),
        (Idle, Analyzing)
            | (Analyzing, Ready)
            | (Analyzing, Failed)
            | (Analyzing, Idle)
            | (Ready, Starting)
            | (Ready, Analyzing) // re-analyze
            | (Ready, Idle)
            | (Starting, Running)
            | (Starting, Failed)
            | (Starting, Stopping) // user aborts mid-start
            | (Starting, Stopped) // process exited cleanly during start
            | (Running, Stopping)
            | (Running, Failed) // crash
            | (Running, Stopped) // clean spontaneous exit
            | (Stopping, Stopped)
            | (Stopping, Failed)
            | (Stopped, Starting) // restart
            | (Stopped, Analyzing)
            | (Stopped, Idle)
            | (Failed, Starting) // retry
            | (Failed, Analyzing)
            | (Failed, Idle)
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: LogStream,
    pub line: String,
    /// Unix epoch milliseconds.
    pub at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Serializable snapshot the frontend renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    /// Monotonic snapshot sequence — the UI drops stale events that
    /// arrive out of order from concurrent emit paths.
    pub seq: u64,
    pub phase: RuntimePhase,
    /// The authoritative workspace snapshot — `None` before analysis.
    pub workspace: Option<WorkspaceAnalysis>,
    pub pid: Option<u32>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub port: Option<u16>,
    /// Unix epoch milliseconds when the process started.
    pub started_at: Option<u64>,
    pub error: Option<CommandError>,
    /// Bounded in-memory log tail (newest last).
    pub recent_logs: VecDeque<LogLine>,
}

const LOG_CAPACITY: usize = 500;

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            seq: 0,
            phase: RuntimePhase::Idle,
            workspace: None,
            pid: None,
            command: None,
            url: None,
            port: None,
            started_at: None,
            error: None,
            recent_logs: VecDeque::with_capacity(LOG_CAPACITY),
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RuntimeState {
    /// Moves to `to`, clearing per-run fields when leaving a live phase.
    pub fn transition(&mut self, to: RuntimePhase) -> CoreResult<()> {
        if !can_transition(self.phase, to) {
            return Err(CoreError::IllegalTransition {
                from: self.phase.as_str().to_string(),
                to: to.as_str().to_string(),
            });
        }
        self.phase = to;
        match to {
            RuntimePhase::Idle => {
                self.workspace = None;
                self.clear_run_fields();
                self.recent_logs.clear();
            }
            RuntimePhase::Analyzing => {
                self.error = None;
            }
            RuntimePhase::Starting => {
                self.error = None;
                self.url = None;
                self.port = None;
                self.pid = None;
                self.started_at = None;
                self.recent_logs.clear();
            }
            RuntimePhase::Stopped | RuntimePhase::Failed => {
                self.pid = None;
            }
            _ => {}
        }
        Ok(())
    }

    /// Force transition, used internally for process-event-driven changes
    /// where the event itself is authoritative (e.g. the OS reported exit).
    pub(crate) fn transition_unchecked(&mut self, to: RuntimePhase) {
        let _ = self.transition(to);
    }

    fn clear_run_fields(&mut self) {
        self.pid = None;
        self.command = None;
        self.url = None;
        self.port = None;
        self.started_at = None;
        self.error = None;
    }

    pub fn set_error(&mut self, err: CommandError) {
        self.error = Some(err);
    }

    pub fn set_running(&mut self, pid: u32, command: String) {
        self.pid = Some(pid);
        self.command = Some(command);
        self.started_at = Some(now_millis());
    }

    /// Marks the runtime live without an OS process — the RootRay-owned
    /// static server runs in-process, so there is no pid to report.
    pub fn set_running_detached(&mut self, command: String) {
        self.pid = None;
        self.command = Some(command);
        self.started_at = Some(now_millis());
    }

    pub fn set_url(&mut self, url: String, port: Option<u16>) {
        self.url = Some(url);
        self.port = port;
    }

    pub fn push_log(&mut self, stream: LogStream, line: String) {
        if self.recent_logs.len() >= LOG_CAPACITY {
            self.recent_logs.pop_front();
        }
        self.recent_logs.push_back(LogLine { stream, line, at: now_millis() });
    }
}
