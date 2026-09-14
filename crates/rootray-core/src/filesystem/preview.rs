//! Boundary-checked, read-only source preview for the inspector.
//!
//! The desktop UI requests a preview *after* validating a browser-reported
//! selection — the browser event itself can never trigger a read. Every
//! path is canonicalized inside the project root, size-capped, UTF-8-only,
//! and sensitive filenames are refused outright.

use std::path::Path;

use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::filesystem::ensure_within_root;
use crate::inspector::protocol::is_safe_relative_path;

const MAX_FILE_BYTES: u64 = 512 * 1024;
const CONTEXT_LINES: u32 = 7;
const MAX_LINE_CHARS: usize = 400;
const MAX_LINES_TOTAL: u32 = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    pub n: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreview {
    /// Project-relative path echoed back (forward slashes).
    pub relative_path: String,
    pub selected_line: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub lines: Vec<PreviewLine>,
}

/// Filenames RootRay never previews, even inside the project root.
fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.ends_with(".kdbx")
        || lower == "id_rsa"
        || lower == "id_dsa"
        || lower == "id_ed25519"
        || lower.ends_with(".keystore")
        || lower.ends_with(".jks")
}

/// Reads up to `2*CONTEXT+1` lines around `line` of a project file.
pub fn read_source_preview(
    root: &Path,
    relative_path: &str,
    line: u32,
) -> CoreResult<SourcePreview> {
    if !is_safe_relative_path(relative_path) {
        return Err(CoreError::ProjectOutsideAllowedRoot(relative_path.to_string()));
    }
    let candidate = ensure_within_root(root, &root.join(relative_path))?;
    if !candidate.is_file() {
        return Err(CoreError::InspectorSourceNotFound(relative_path.to_string()));
    }
    let name = candidate
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_sensitive_name(&name) {
        return Err(CoreError::ProjectOutsideAllowedRoot(relative_path.to_string()));
    }

    let size = candidate
        .metadata()
        .map_err(|e| CoreError::SourcePreviewFailed(e.to_string()))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(CoreError::SourcePreviewFailed(format!(
            "file too large for preview ({size} bytes)"
        )));
    }
    let bytes = std::fs::read(&candidate)
        .map_err(|e| CoreError::SourcePreviewFailed(e.to_string()))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| CoreError::SourcePreviewFailed("not a UTF-8 text file".into()))?;

    let all: Vec<&str> = text.lines().collect();
    let total = all.len() as u32;
    if total == 0 || total > MAX_LINES_TOTAL {
        return Err(CoreError::SourcePreviewFailed("unexpected file shape".into()));
    }
    let selected = line.clamp(1, total);
    let start = selected.saturating_sub(CONTEXT_LINES).max(1);
    let end = (selected + CONTEXT_LINES).min(total);
    let lines = (start..=end)
        .map(|n| PreviewLine {
            n,
            text: all[(n - 1) as usize]
                .chars()
                .take(MAX_LINE_CHARS)
                .collect(),
        })
        .collect();

    Ok(SourcePreview {
        relative_path: relative_path.to_string(),
        selected_line: selected,
        start_line: start,
        end_line: end,
        lines,
    })
}
