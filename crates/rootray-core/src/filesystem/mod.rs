//! Filesystem boundary enforcement.
//!
//! The selected project root is the only region of the disk RootRay may
//! touch. All paths are canonicalized before comparison, which resolves
//! `..`, `.` and symlinks — so traversal and symlink-escape attempts fail
//! closed.

pub mod nav;
pub mod preview;

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};

/// Canonicalizes a project root. Rejects non-existent paths, non-directories
/// and anything the OS refuses to resolve.
pub fn canonicalize_root(root: &Path) -> CoreResult<PathBuf> {
    if root.as_os_str().is_empty() {
        return Err(CoreError::InvalidProjectPath("(empty path)".to_string()));
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| CoreError::InvalidProjectPath(format!("{}: {e}", root.display())))?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidProjectPath(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    Ok(strip_verbatim(&canonical))
}

/// Canonicalizes `candidate` and verifies it lives inside `root`.
/// `candidate` must already exist (canonicalization requires it); callers
/// that only need lexical validation use [`ensure_lexically_within_root`].
pub fn ensure_within_root(root: &Path, candidate: &Path) -> CoreResult<PathBuf> {
    let root = canonicalize_root(root)?;
    let resolved = candidate.canonicalize().map_err(|e| {
        CoreError::ProjectOutsideAllowedRoot(format!("{}: {e}", candidate.display()))
    })?;
    let resolved = strip_verbatim(&resolved);
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(CoreError::ProjectOutsideAllowedRoot(candidate.display().to_string()))
    }
}

/// Validates a *possibly non-existent* path against the root by normalizing
/// `.` / `..` lexically and resolving the nearest existing ancestor.
/// Used for "open file at line" style paths the inspector will produce.
pub fn ensure_lexically_within_root(root: &Path, candidate: &Path) -> CoreResult<PathBuf> {
    let root = canonicalize_root(root)?;

    // Reject verbatim/UNC prefixes we didn't produce ourselves.
    if candidate.has_root() && !candidate.is_absolute() {
        return Err(CoreError::ProjectOutsideAllowedRoot(candidate.display().to_string()));
    }

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let normalized = normalize(&joined);

    // Walk up to the nearest existing ancestor and canonicalize that; the
    // non-existent tail is then re-appended. This catches symlink escapes
    // even for paths that don't exist yet.
    let mut existing = normalized.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => {
                return Err(CoreError::ProjectOutsideAllowedRoot(
                    candidate.display().to_string(),
                ))
            }
        }
        existing = existing.parent().map(Path::to_path_buf).ok_or_else(|| {
            CoreError::ProjectOutsideAllowedRoot(candidate.display().to_string())
        })?;
    }
    let mut resolved = strip_verbatim(&existing.canonicalize().map_err(|e| {
        CoreError::ProjectOutsideAllowedRoot(format!("{}: {e}", candidate.display()))
    })?);
    for part in tail.iter().rev() {
        resolved.push(part);
    }

    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(CoreError::ProjectOutsideAllowedRoot(candidate.display().to_string()))
    }
}

/// Lexically normalizes a path: resolves `.` and `..` components without
/// touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Removes the `\\?\` verbatim prefix Windows adds on canonicalization so
/// serialized paths look normal to users.
fn strip_verbatim(path: &Path) -> PathBuf {
    strip_verbatim_pub(path)
}

/// `pub(crate)` twin of `strip_verbatim` for the workspace discovery engine.
pub(crate) fn strip_verbatim_pub(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}
