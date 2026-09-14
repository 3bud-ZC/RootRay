use serde::Serialize;
use thiserror::Error;

/// Typed failures produced by the core. Each variant maps to a stable
/// machine-readable `code` so the frontend can render precise diagnostics
/// without parsing messages.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("project path is not a readable directory: {0}")]
    InvalidProjectPath(String),

    #[error("package.json not found in project root")]
    PackageJsonNotFound,

    #[error("package.json is not valid JSON: {0}")]
    PackageJsonInvalid(String),

    #[error("unsupported project: {0}")]
    UnsupportedFramework(String),

    #[error("no \"dev\" script found in package.json")]
    NoDevScript,

    #[error("package manager could not be determined")]
    PackageManagerUnknown,

    #[error("no project has been analyzed yet")]
    NoProjectSelected,

    #[error("a development server is already running")]
    ProcessAlreadyRunning,

    #[error("no development server is running")]
    ProcessNotRunning,

    #[error("failed to start development server: {0}")]
    ProcessStartFailed(String),

    #[error("development server exited with code {0:?}")]
    ProcessExited(Option<i32>),

    #[error("no local URL was detected in dev server output")]
    LocalUrlNotDetected,

    #[error("path escapes the allowed project root: {0}")]
    ProjectOutsideAllowedRoot(String),

    #[error("launcher is not available: {0}")]
    LauncherNotFound(String),

    #[error("illegal runtime state transition: {from} -> {to}")]
    IllegalTransition { from: String, to: String },

    #[error("settings storage error: {0}")]
    SettingsIo(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl CoreError {
    /// Stable machine-readable error code surfaced to the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidProjectPath(_) => "INVALID_PROJECT_PATH",
            Self::PackageJsonNotFound => "PACKAGE_JSON_NOT_FOUND",
            Self::PackageJsonInvalid(_) => "PACKAGE_JSON_INVALID",
            Self::UnsupportedFramework(_) => "UNSUPPORTED_FRAMEWORK",
            Self::NoDevScript => "NO_DEV_SCRIPT",
            Self::PackageManagerUnknown => "PACKAGE_MANAGER_UNKNOWN",
            Self::NoProjectSelected => "NO_PROJECT_SELECTED",
            Self::ProcessAlreadyRunning => "PROCESS_ALREADY_RUNNING",
            Self::ProcessNotRunning => "PROCESS_NOT_RUNNING",
            Self::ProcessStartFailed(_) => "PROCESS_START_FAILED",
            Self::ProcessExited(_) => "PROCESS_EXITED",
            Self::LocalUrlNotDetected => "LOCAL_URL_NOT_DETECTED",
            Self::ProjectOutsideAllowedRoot(_) => "PROJECT_OUTSIDE_ALLOWED_ROOT",
            Self::LauncherNotFound(_) => "LAUNCHER_NOT_FOUND",
            Self::IllegalTransition { .. } => "ILLEGAL_STATE_TRANSITION",
            Self::SettingsIo(_) => "SETTINGS_IO",
            Self::Internal(_) => "INTERNAL",
        }
    }
}

/// Serializable error shape returned by every Tauri command.
/// Never carries OS internals — only a code and a curated message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        Self::from(&err)
    }
}

impl From<&CoreError> for CommandError {
    fn from(err: &CoreError) -> Self {
        Self {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        Self::Internal(format!("io error: {err}"))
    }
}

pub type CoreResult<T> = Result<T, CoreError>;
