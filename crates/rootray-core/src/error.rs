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

    #[error("inspector bridge failed to start: {0}")]
    InspectorBridgeStartFailed(String),

    #[error("inspector is unavailable: {0}")]
    InspectorUnavailable(String),

    #[error("no inspector session is active")]
    InspectorNotActive,

    #[error("inspector source not found: {0}")]
    InspectorSourceNotFound(String),

    #[error("source preview failed: {0}")]
    SourcePreviewFailed(String),

    #[error("source file not found: {0}")]
    SourceFileNotFound(String),

    #[error("source file is not editable inside RootRay: {0}")]
    SourceFileDenied(String),

    #[error("source file too large to edit safely ({0} bytes)")]
    SourceFileTooLarge(u64),

    #[error("source file is binary, not text: {0}")]
    SourceFileBinary(String),

    #[error("source file encoding is not supported: {0}")]
    SourceFileEncodingUnsupported(String),

    #[error("file changed outside RootRay since it was loaded")]
    SourceEditConflict { disk_hash: String },

    #[error("file changed outside RootRay (still unsaved content is safe)")]
    SourceExternalChange { disk_hash: String },

    #[error("source write failed: {0}")]
    SourceWriteFailed(String),

    #[error("permission denied writing source file: {0}")]
    SourceWritePermissionDenied(String),

    #[error("no editor session is open")]
    EditorSessionClosed,

    #[error("revert is not possible: {0}")]
    RevertUnavailable(String),

    #[error("failed to open editor: {0}")]
    EditorOpenFailed(String),

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
            Self::InspectorBridgeStartFailed(_) => "INSPECTOR_BRIDGE_START_FAILED",
            Self::InspectorUnavailable(_) => "INSPECTOR_UNAVAILABLE",
            Self::InspectorNotActive => "INSPECTOR_NOT_ACTIVE",
            Self::InspectorSourceNotFound(_) => "INSPECTOR_SOURCE_NOT_FOUND",
            Self::SourcePreviewFailed(_) => "SOURCE_PREVIEW_FAILED",
            Self::SourceFileNotFound(_) => "SOURCE_FILE_NOT_FOUND",
            Self::SourceFileDenied(_) => "SOURCE_FILE_DENIED",
            Self::SourceFileTooLarge(_) => "SOURCE_FILE_TOO_LARGE",
            Self::SourceFileBinary(_) => "SOURCE_FILE_BINARY",
            Self::SourceFileEncodingUnsupported(_) => {
                "SOURCE_FILE_ENCODING_UNSUPPORTED"
            }
            Self::SourceEditConflict { .. } => "SOURCE_EDIT_CONFLICT",
            Self::SourceExternalChange { .. } => "SOURCE_EXTERNAL_CHANGE",
            Self::SourceWriteFailed(_) => "SOURCE_WRITE_FAILED",
            Self::SourceWritePermissionDenied(_) => "SOURCE_WRITE_PERMISSION_DENIED",
            Self::EditorSessionClosed => "EDITOR_SESSION_CLOSED",
            Self::RevertUnavailable(_) => "REVERT_UNAVAILABLE",
            Self::EditorOpenFailed(_) => "EDITOR_OPEN_FAILED",
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
