//! Safe source editing session for Quick Edit.
//!
//! [`EditorManager`] owns at most one open file at a time (YAGNI — a
//! single Quick Edit slot). It tracks the disk baseline hash, a file
//! watcher for external changes, and one in-memory revert snapshot for
//! the last RootRay save. The frontend owns editor content and dirty
//! state; the native side owns the disk truth and pushes
//! `EditorEvent::ExternalChange` when another process touches the file.

pub mod file;
pub mod watch;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};
pub use file::{
    hash_source_file, read_source_file, LineEnding, SourceFileHash, SourceFileRead,
    SourceFileWrite, MAX_EDIT_BYTES,
};

/// Event emitted on `rootray://editor-event` when the open file changes
/// underneath the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EditorEvent {
    ExternalChange { relative_path: String, disk_hash: String },
}

type Notify = Arc<dyn Fn(&EditorEvent) + Send + Sync>;

struct EditorSession {
    relative_path: String,
    abs_path: PathBuf,
    line_ending: LineEnding,
    bom: bool,
    /// Hash the editor is based on (last load or last RootRay write).
    base_hash: String,
    /// Raw bytes on disk before the last RootRay save — the revert target.
    revert_bytes: Option<Vec<u8>>,
    /// Hash of the last RootRay-written bytes — revert requires the disk
    /// to still equal this.
    last_written_hash: Option<String>,
    /// Last disk hash we already notified about — avoids event spam while
    /// a conflict sits unresolved.
    notified_hash: Option<String>,
    watcher: Option<watch::FileWatcher>,
}

/// Snapshot for `get_editor_state` — what the native side believes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSessionInfo {
    pub open: bool,
    pub relative_path: Option<String>,
    pub base_hash: Option<String>,
    pub disk_hash: Option<String>,
    pub watching: bool,
    pub can_revert: bool,
}

#[derive(Clone)]
pub struct EditorManager {
    inner: Arc<EditorInner>,
}

struct EditorInner {
    session: Mutex<Option<EditorSession>>,
    notify: Mutex<Option<Notify>>,
}

impl Default for EditorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl EditorManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(EditorInner {
                session: Mutex::new(None),
                notify: Mutex::new(None),
            }),
        }
    }

    pub fn set_notify(&self, notify: Notify) {
        if let Ok(mut n) = self.inner.notify.lock() {
            *n = Some(notify);
        }
    }

    /// Opens `relative_path` for editing: validates, reads, hashes, and
    /// starts the external-change watcher. Reopening replaces the session.
    pub fn open(&self, root: &Path, relative_path: &str) -> CoreResult<SourceFileRead> {
        let read = read_source_file(root, relative_path)?;
        let abs_path = crate::filesystem::ensure_within_root(root, &root.join(relative_path))?;

        let weak = Arc::downgrade(&self.inner);
        let rel = relative_path.to_string();
        let watcher = watch::FileWatcher::watch(&abs_path, move || {
            if let Some(inner) = weak.upgrade() {
                on_external_change(&inner, &rel);
            }
        })
        .ok(); // watcher failure degrades gracefully — save still hash-checks

        let session = EditorSession {
            relative_path: relative_path.to_string(),
            abs_path,
            line_ending: read.line_ending,
            bom: read.bom,
            base_hash: read.hash.clone(),
            revert_bytes: None,
            last_written_hash: None,
            notified_hash: None,
            watcher,
        };
        let mut s = self
            .inner
            .session
            .lock()
            .map_err(|_| CoreError::Internal("editor session lock".into()))?;
        *s = Some(session);
        Ok(read)
    }

    /// Saves `content` (LF-normalized) iff `expected_hash` equals the
    /// current disk hash. Preserves the session's line endings and BOM.
    /// Stashes the previous disk bytes as the revert snapshot.
    pub fn save(
        &self,
        root: &Path,
        relative_path: &str,
        content: &str,
        expected_hash: &str,
    ) -> CoreResult<SourceFileWrite> {
        let (eol, bom) = {
            let s = self
                .inner
                .session
                .lock()
                .map_err(|_| CoreError::Internal("editor session lock".into()))?;
            let session = s.as_ref().ok_or(CoreError::EditorSessionClosed)?;
            if session.relative_path != relative_path {
                return Err(CoreError::EditorSessionClosed);
            }
            (session.line_ending, session.bom)
        };

        // Read the pre-save disk state for the revert snapshot and the
        // optimistic-concurrency check in one pass.
        let abs = crate::filesystem::ensure_within_root(root, &root.join(relative_path))?;
        let prior = std::fs::read(&abs).unwrap_or_default();
        let write = file::write_source_file(root, relative_path, content, expected_hash, eol, bom)?;

        let mut s = self
            .inner
            .session
            .lock()
            .map_err(|_| CoreError::Internal("editor session lock".into()))?;
        if let Some(session) = s.as_mut() {
            if session.relative_path == relative_path {
                session.revert_bytes = Some(prior);
                session.last_written_hash = Some(write.hash.clone());
                session.base_hash = write.hash.clone();
                session.notified_hash = None;
            }
        }
        Ok(write)
    }

    /// Current disk hash — lets the frontend poll if the watcher is off.
    pub fn check(&self, root: &Path, relative_path: &str) -> CoreResult<SourceFileHash> {
        hash_source_file(root, relative_path)
    }

    /// Restores the bytes that were on disk before RootRay's last save —
    /// only if the disk still equals RootRay's last write (an external
    /// edit since then makes revert a conflict).
    pub fn revert_last_save(&self, root: &Path, relative_path: &str) -> CoreResult<SourceFileRead> {
        let (abs, bytes, written_hash) = {
            let s = self
                .inner
                .session
                .lock()
                .map_err(|_| CoreError::Internal("editor session lock".into()))?;
            let session = s.as_ref().ok_or(CoreError::EditorSessionClosed)?;
            if session.relative_path != relative_path {
                return Err(CoreError::EditorSessionClosed);
            }
            let bytes = session
                .revert_bytes
                .clone()
                .ok_or_else(|| CoreError::RevertUnavailable("no previous save".into()))?;
            let hash = session
                .last_written_hash
                .clone()
                .ok_or_else(|| CoreError::RevertUnavailable("no previous save".into()))?;
            (session.abs_path.clone(), bytes, hash)
        };

        let disk = std::fs::read(&abs).map_err(|e| file_read_err(relative_path, e))?;
        let disk_hash = file::hash_bytes(&disk);
        if disk_hash != written_hash {
            return Err(CoreError::SourceEditConflict { disk_hash });
        }
        file::atomic_replace(&abs, &bytes)?;

        // Re-read through the normal path so the session base + response
        // reflect exactly what's on disk now.
        let read = read_source_file(root, relative_path)?;
        let mut s = self
            .inner
            .session
            .lock()
            .map_err(|_| CoreError::Internal("editor session lock".into()))?;
        if let Some(session) = s.as_mut() {
            session.base_hash = read.hash.clone();
            session.revert_bytes = None;
            session.last_written_hash = None;
            session.notified_hash = None;
        }
        Ok(read)
    }

    /// Re-reads the file and rebases the session — the "Reload Disk
    /// Version" path for both clean auto-reload and conflict resolution.
    pub fn reload(&self, root: &Path, relative_path: &str) -> CoreResult<SourceFileRead> {
        let read = read_source_file(root, relative_path)?;
        let mut s = self
            .inner
            .session
            .lock()
            .map_err(|_| CoreError::Internal("editor session lock".into()))?;
        if let Some(session) = s.as_mut() {
            if session.relative_path == relative_path {
                session.base_hash = read.hash.clone();
                session.line_ending = read.line_ending;
                session.bom = read.bom;
                session.revert_bytes = None;
                session.last_written_hash = None;
                session.notified_hash = None;
            }
        }
        Ok(read)
    }

    /// Stops the watcher and drops the session.
    pub fn close(&self) {
        if let Ok(mut s) = self.inner.session.lock() {
            *s = None;
        }
    }

    pub fn info(&self, root: &Path) -> EditorSessionInfo {
        let s = match self.inner.session.lock() {
            Ok(s) => s,
            Err(_) => {
                return EditorSessionInfo {
                    open: false,
                    relative_path: None,
                    base_hash: None,
                    disk_hash: None,
                    watching: false,
                    can_revert: false,
                }
            }
        };
        match s.as_ref() {
            Some(session) => {
                let disk_hash = hash_source_file(root, &session.relative_path)
                    .map(|h| h.hash)
                    .ok();
                EditorSessionInfo {
                    open: true,
                    relative_path: Some(session.relative_path.clone()),
                    base_hash: Some(session.base_hash.clone()),
                    disk_hash,
                    watching: session.watcher.is_some(),
                    can_revert: session.revert_bytes.is_some(),
                }
            }
            None => EditorSessionInfo {
                open: false,
                relative_path: None,
                base_hash: None,
                disk_hash: None,
                watching: false,
                can_revert: false,
            },
        }
    }
}

/// Watcher callback: re-hash; notify only when the disk content actually
/// diverged from the session baseline and we haven't already reported it.
fn on_external_change(inner: &EditorInner, relative_path: &str) {
    let mut s = match inner.session.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    let Some(session) = s.as_mut() else { return };
    if session.relative_path != relative_path {
        return;
    }
    let disk_hash = std::fs::read(&session.abs_path)
        .map(|b| file::hash_bytes(&b))
        .unwrap_or_default();
    if disk_hash == session.base_hash || session.notified_hash.as_deref() == Some(&*disk_hash) {
        return;
    }
    session.notified_hash = Some(disk_hash.clone());
    drop(s);
    if let Ok(n) = inner.notify.lock() {
        if let Some(n) = n.as_ref() {
            n(&EditorEvent::ExternalChange {
                relative_path: relative_path.to_string(),
                disk_hash,
            });
        }
    }
}

fn file_read_err(rel: &str, e: std::io::Error) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::SourceFileNotFound(rel.to_string()),
        std::io::ErrorKind::PermissionDenied => {
            CoreError::SourceWritePermissionDenied(rel.to_string())
        }
        _ => CoreError::SourceWriteFailed(e.to_string()),
    }
}
