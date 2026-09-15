//! Safe project navigation: lazy directory listing, bounded file listing
//! for Quick Open, bounded text search, and a bounded source-file
//! collection that feeds the frontend's component intelligence.
//!
//! Everything here is read-only, project-root bounded, and applies the
//! same deny rules as the Quick Edit file layer: generated directories
//! and sensitive names are never surfaced, binaries and oversized files
//! are skipped, and every returned path is project-relative with forward
//! slashes.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::editor::file::{is_denied_name, is_editable_ext};
use crate::error::{CoreError, CoreResult};
use crate::filesystem::ensure_within_root;
use crate::inspector::protocol::is_safe_relative_path;

/// Entries returned per directory before `truncated` flips on.
pub const MAX_DIR_ENTRIES: usize = 2_000;
/// Total files the Quick Open listing returns.
pub const MAX_LIST_FILES: usize = 8_000;
/// Files the workspace search will open at most.
pub const MAX_SEARCH_FILES: usize = 2_000;
/// Per-file byte cap for search — bigger files are skipped, not scanned.
pub const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;
/// Total matches a single search returns.
pub const MAX_SEARCH_RESULTS: usize = 200;
/// Per-file match cap — one file can never starve the result list.
pub const MAX_SEARCH_MATCHES_PER_FILE: usize = 10;
/// Chars kept around a match for the preview snippet.
const SEARCH_PREVIEW_CHARS: usize = 160;
/// Source files fed to component intelligence.
pub const MAX_INTEL_FILES: usize = 600;
/// Per-file byte cap for intelligence collection.
pub const MAX_INTEL_FILE_BYTES: u64 = 256 * 1024;
/// Total analyzed bytes per intelligence snapshot.
pub const MAX_INTEL_TOTAL_BYTES: usize = 4 * 1024 * 1024;

/// Directories the explorer/search never descend into. Union of the
/// editor's generated-dir deny list and navigation-specific artifacts.
pub const NAV_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".e2e-work",
    "playwright-report",
    "test-results",
    ".next",
    ".cache",
    ".turbo",
    ".idea",
    ".vscode",
    "out",
];

/// Extensions the component-intelligence collector parses.
const INTEL_EXTS: &[&str] = &["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    /// Forward-slash path relative to the project root.
    pub relative_path: String,
    pub kind: EntryKind,
    /// True when the file passes the Quick Edit extension/name rules.
    pub editable: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// The directory that was listed ("" = project root).
    pub relative_path: String,
    pub entries: Vec<ProjectEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListing {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub relative_path: String,
    /// 1-based line number (CRLF-safe).
    pub line: u32,
    /// 1-based column of the match start.
    pub column: u32,
    /// Bounded snippet around the match.
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub files_scanned: u32,
    /// True when a cap (files/results) cut the scan short.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBlob {
    pub relative_path: String,
    /// LF-normalized text.
    pub content: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCollection {
    pub files: Vec<SourceBlob>,
    /// True when file/byte caps cut the collection short.
    pub truncated: bool,
    pub total_bytes: u64,
}

// --- shared helpers -------------------------------------------------------------

fn is_ignored_dir(name: &str) -> bool {
    NAV_IGNORED_DIRS.contains(&name.to_ascii_lowercase().as_str())
}

/// Pushes a path's project-relative form (forward slashes) — the wire
/// contract for every navigation payload.
fn relative_str(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Depth-first walk of editable project files. Never follows directory
/// symlinks (junction/reparse points included) so the walk can never
/// escape the canonical root. Errors on individual entries are skipped.
fn walk_files(root: &Path, mut visit: impl FnMut(&Path, &str, u64) -> bool) {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_denied_name(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let abs = entry.path();
            if meta.is_dir() {
                if ft.is_symlink() || is_ignored_dir(&name) {
                    continue;
                }
                stack.push(abs);
            } else if meta.is_file() {
                if !is_editable_ext(&name) {
                    continue;
                }
                let rel = relative_str(root, &abs);
                if !visit(&abs, &rel, meta.len()) {
                    return;
                }
            }
        }
    }
}

// --- directory listing ----------------------------------------------------------

/// Lists ONE directory level — lazy by design, no recursion.
pub fn list_project_dir(root: &Path, relative_dir: &str) -> CoreResult<DirListing> {
    if !relative_dir.is_empty() && !is_safe_relative_path(relative_dir) {
        return Err(CoreError::ProjectOutsideAllowedRoot(relative_dir.to_string()));
    }
    if relative_dir
        .split('/')
        .filter(|s| !s.is_empty())
        .any(|seg| is_ignored_dir(seg))
    {
        return Err(CoreError::SourceFileDenied(relative_dir.to_string()));
    }
    let dir = if relative_dir.is_empty() {
        ensure_within_root(root, root)?
    } else {
        ensure_within_root(root, &root.join(relative_dir))?
    };
    if !dir.is_dir() {
        return Err(CoreError::ProjectTreeFailed(format!(
            "not a directory: {relative_dir}"
        )));
    }

    let mut entries: Vec<ProjectEntry> = Vec::new();
    let mut truncated = false;
    let read_dir =
        std::fs::read_dir(&dir).map_err(|e| CoreError::ProjectTreeFailed(e.to_string()))?;
    for entry in read_dir.flatten() {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_denied_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue; // disappeared mid-listing
        };
        let rel = relative_str(&dir, &entry.path());
        let relative_path = if relative_dir.is_empty() {
            rel
        } else {
            format!("{relative_dir}/{rel}")
        };
        if meta.is_dir() {
            if is_ignored_dir(&name) {
                continue;
            }
            entries.push(ProjectEntry {
                name,
                relative_path,
                kind: EntryKind::Dir,
                editable: false,
                size_bytes: None,
            });
        } else if meta.is_file() {
            entries.push(ProjectEntry {
                editable: is_editable_ext(&name),
                name,
                relative_path,
                kind: EntryKind::File,
                size_bytes: Some(meta.len()),
            });
        }
    }
    // Deterministic order: directories first, then case-insensitive name.
    entries.sort_by(|a, b| {
        (b.kind == EntryKind::Dir)
            .cmp(&(a.kind == EntryKind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(DirListing {
        relative_path: relative_dir.to_string(),
        entries,
        truncated,
    })
}

/// Bounded flat listing of editable files — powers Ctrl+P Quick Open.
pub fn list_project_files(root: &Path) -> CoreResult<FileListing> {
    let root = crate::filesystem::canonicalize_root(root)?;
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    walk_files(&root, |_, rel, _| {
        if paths.len() >= MAX_LIST_FILES {
            truncated = true;
            return false;
        }
        paths.push(rel.to_string());
        true
    });
    paths.sort();
    Ok(FileListing { paths, truncated })
}

// --- workspace search -------------------------------------------------------------

/// Bounded case-insensitive text search over safe source files.
/// `query` longer than 200 chars or empty is refused.
pub fn search_workspace(root: &Path, query: &str) -> CoreResult<SearchResult> {
    let root = crate::filesystem::canonicalize_root(root)?;
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err(CoreError::WorkspaceSearchFailed(
            "query must be 1–200 characters".into(),
        ));
    }
    let needle = query.to_lowercase();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut files_scanned = 0u32;
    let mut truncated = false;

    walk_files(&root, |abs, rel, size| {
        if files_scanned as usize >= MAX_SEARCH_FILES || matches.len() >= MAX_SEARCH_RESULTS {
            truncated = true;
            return false;
        }
        if size > MAX_SEARCH_FILE_BYTES {
            return true; // too large — skip silently
        }
        let Ok(raw) = std::fs::read(abs) else {
            return true; // unreadable/disappeared — tolerate
        };
        if raw[..raw.len().min(8192)].contains(&0) {
            return true; // binary
        }
        let Ok(text) = String::from_utf8(raw) else {
            return true;
        };
        files_scanned += 1;
        let mut in_file = 0usize;
        for (idx, line) in text.lines().enumerate() {
            if in_file >= MAX_SEARCH_MATCHES_PER_FILE || matches.len() >= MAX_SEARCH_RESULTS {
                break;
            }
            let hay = line.to_lowercase();
            if let Some(pos) = hay.find(&needle) {
                in_file += 1;
                matches.push(SearchMatch {
                    relative_path: rel.to_string(),
                    line: idx as u32 + 1,
                    column: pos as u32 + 1,
                    preview: preview_of(line, pos),
                });
            }
        }
        true
    });
    if matches.len() >= MAX_SEARCH_RESULTS {
        truncated = true;
    }
    Ok(SearchResult {
        query: query.to_string(),
        matches,
        files_scanned,
        truncated,
    })
}

fn preview_of(line: &str, match_pos: usize) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= SEARCH_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    // Window centered on the match where possible.
    let half = SEARCH_PREVIEW_CHARS / 2;
    let start = match_pos.saturating_sub(half);
    trimmed
        .chars()
        .skip(start.min(trimmed.chars().count().saturating_sub(SEARCH_PREVIEW_CHARS)))
        .take(SEARCH_PREVIEW_CHARS)
        .collect()
}

// --- source collection for intelligence -------------------------------------------

/// Bounded collection of JS/TS sources for static component analysis.
/// Files are read as data only — nothing here executes project code.
pub fn collect_source_files(root: &Path) -> CoreResult<SourceCollection> {
    let root = crate::filesystem::canonicalize_root(root)?;
    let mut files: Vec<SourceBlob> = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated = false;

    walk_files(&root, |abs, rel, size| {
        if files.len() >= MAX_INTEL_FILES || total_bytes >= MAX_INTEL_TOTAL_BYTES {
            truncated = true;
            return false;
        }
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !INTEL_EXTS.contains(&ext.as_str()) {
            return true;
        }
        if size > MAX_INTEL_FILE_BYTES {
            return true;
        }
        let Ok(raw) = std::fs::read(abs) else {
            return true;
        };
        if raw[..raw.len().min(8192)].contains(&0) {
            return true;
        }
        let Ok(text) = String::from_utf8(raw) else {
            return true;
        };
        let content = text.replace("\r\n", "\n");
        total_bytes += content.len();
        files.push(SourceBlob {
            relative_path: rel.to_string(),
            content,
            size_bytes: size,
        });
        true
    });
    Ok(SourceCollection {
        total_bytes: total_bytes as u64,
        files,
        truncated,
    })
}
