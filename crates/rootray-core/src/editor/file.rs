//! Boundary-checked, size-capped, encoding-safe source file access for the
//! Quick Edit feature.
//!
//! Rules enforced on every operation:
//! - path is project-relative, canonicalized inside the selected root
//! - sensitive names and build/.git directories are denied
//! - size-capped, UTF-8 only, NUL-byte sniff rejects binaries
//! - line-ending convention and UTF-8 BOM are preserved across saves
//! - writes are optimistic-concurrency checked (expected SHA-256) and
//!   written via a same-directory temp file + rename so a failed write
//!   never truncates the user's file

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::filesystem::ensure_within_root;
use crate::inspector::protocol::is_safe_relative_path;

/// Largest file the quick editor will touch — 2 MiB.
pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
/// Bytes sniffed for NUL when deciding binary-vs-text.
const BINARY_SNIFF_BYTES: usize = 8192;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileRead {
    /// Project-relative path echoed back (forward slashes).
    pub relative_path: String,
    /// File text normalized to `\n` line endings — the editor works on LF.
    pub content: String,
    /// SHA-256 of the raw on-disk bytes — the optimistic-concurrency token.
    pub hash: String,
    pub line_ending: LineEnding,
    pub bom: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileWrite {
    pub relative_path: String,
    /// SHA-256 of the bytes now on disk.
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileHash {
    pub relative_path: String,
    pub hash: String,
    pub size_bytes: u64,
}

// --- deny lists ---------------------------------------------------------------

/// Filenames RootRay never reads into the editor or writes, even inside the
/// project root. Secret material stays secret.
pub fn is_denied_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.ends_with(".kdbx")
        || lower.ends_with(".keystore")
        || lower.ends_with(".jks")
        || lower == "id_rsa"
        || lower == "id_dsa"
        || lower == "id_ed25519"
        || lower == "id_ecdsa"
        || lower.starts_with("credentials")
        || lower.starts_with("secrets")
}

/// Path segments that mark generated/vendored areas — never edited.
const DENIED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".cache"];

/// Extensions the quick editor accepts as text source.
const EDITABLE_EXTS: &[&str] = &[
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "css", "scss", "less", "html", "htm",
    "json", "jsonc", "json5", "md", "txt", "svg", "xml", "yaml", "yml", "toml", "env.example",
];

fn is_denied_dir_path(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .any(|seg| DENIED_DIRS.contains(&seg.to_ascii_lowercase().as_str()))
}

pub(crate) fn is_editable_ext(name: &str) -> bool {
    match name.rsplit('.').next() {
        Some(ext) => EDITABLE_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Full validation for a candidate project-relative path.
/// Returns the canonicalized absolute path on success.
fn resolve_editable(root: &Path, relative_path: &str) -> CoreResult<PathBuf> {
    if !is_safe_relative_path(relative_path) {
        return Err(CoreError::ProjectOutsideAllowedRoot(relative_path.to_string()));
    }
    if is_denied_dir_path(relative_path) {
        return Err(CoreError::SourceFileDenied(relative_path.to_string()));
    }
    let name = Path::new(relative_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_denied_name(&name) {
        return Err(CoreError::SourceFileDenied(relative_path.to_string()));
    }
    if !is_editable_ext(&name) {
        return Err(CoreError::SourceFileDenied(relative_path.to_string()));
    }
    let candidate = ensure_within_root(root, &root.join(relative_path))?;
    if !candidate.is_file() {
        return Err(CoreError::SourceFileNotFound(relative_path.to_string()));
    }
    Ok(candidate)
}

// --- hashing ------------------------------------------------------------------

/// SHA-256 of raw file bytes — the optimistic-concurrency token.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Hashes the raw bytes of a project file — boundary-checked.
pub fn hash_source_file(root: &Path, relative_path: &str) -> CoreResult<SourceFileHash> {
    let path = resolve_editable(root, relative_path)?;
    let bytes = std::fs::read(&path)
        .map_err(|e| CoreError::SourceWriteFailed(format!("read for hash: {e}")))?;
    Ok(SourceFileHash {
        relative_path: relative_path.to_string(),
        hash: hash_bytes(&bytes),
        size_bytes: bytes.len() as u64,
    })
}

// --- read ---------------------------------------------------------------------

fn detect_line_ending(text: &str) -> LineEnding {
    // Convention = the dominant line ending; a lone LF file stays LF.
    let crlf = text.matches("\r\n").count();
    let bare_lf = text.matches('\n').count() - crlf;
    if crlf > bare_lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Reads a project source file for editing. Returns LF-normalized content
/// plus enough metadata to write it back byte-faithfully.
pub fn read_source_file(root: &Path, relative_path: &str) -> CoreResult<SourceFileRead> {
    let path = resolve_editable(root, relative_path)?;
    let size = path
        .metadata()
        .map_err(|e| CoreError::SourceWriteFailed(e.to_string()))?
        .len();
    if size > MAX_EDIT_BYTES {
        return Err(CoreError::SourceFileTooLarge(size));
    }
    let raw = std::fs::read(&path)
        .map_err(|e| map_read_err(relative_path, e))?;
    if looks_binary(&raw) {
        return Err(CoreError::SourceFileBinary(relative_path.to_string()));
    }
    let (bom, body) = match raw.strip_prefix(UTF8_BOM) {
        Some(rest) => (true, rest),
        None => (false, raw.as_slice()),
    };
    let text = String::from_utf8(body.to_vec())
        .map_err(|_| CoreError::SourceFileEncodingUnsupported(relative_path.to_string()))?;
    let line_ending = detect_line_ending(&text);
    let content = if line_ending == LineEnding::Crlf {
        text.replace("\r\n", "\n")
    } else {
        text
    };
    Ok(SourceFileRead {
        relative_path: relative_path.to_string(),
        content,
        hash: hash_bytes(&raw),
        line_ending,
        bom,
        size_bytes: size,
    })
}

fn map_read_err(relative_path: &str, e: std::io::Error) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::SourceFileNotFound(relative_path.to_string()),
        std::io::ErrorKind::PermissionDenied => {
            CoreError::SourceWritePermissionDenied(relative_path.to_string())
        }
        _ => CoreError::SourceWriteFailed(e.to_string()),
    }
}

// --- write --------------------------------------------------------------------

/// Re-encodes LF-normalized editor content into the on-disk convention.
fn encode_disk(content: &str, eol: LineEnding, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 3);
    if bom {
        out.extend_from_slice(UTF8_BOM);
    }
    let body = match eol {
        LineEnding::Lf => content.to_string(),
        LineEnding::Crlf => content.replace('\n', "\r\n"),
    };
    out.extend_from_slice(body.as_bytes());
    out
}

/// Atomically replaces `abs` with `bytes` via a same-directory temp file +
/// rename. The original is never partially truncated; a failed replace
/// leaves it intact and the temp file is cleaned up.
pub fn atomic_replace(abs: &Path, bytes: &[u8]) -> CoreResult<()> {
    let dir = abs.parent().ok_or_else(|| {
        CoreError::SourceWriteFailed("file has no parent directory".into())
    })?;
    let file_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "rootray".into());
    let mut nonce = [0u8; 8];
    let _ = getrandom::fill(&mut nonce);
    let tmp = dir.join(format!(
        ".{file_name}.rootray-{:x}.tmp",
        u64::from_le_bytes(nonce)
    ));

    let write_result = (|| -> CoreResult<()> {
        let mut f = std::fs::File::create(&tmp).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                CoreError::SourceWritePermissionDenied(tmp.display().to_string())
            }
            _ => CoreError::SourceWriteFailed(format!("temp create: {e}")),
        })?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| CoreError::SourceWriteFailed(format!("temp write: {e}")))?;
        drop(f);
        std::fs::rename(&tmp, abs).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                CoreError::SourceWritePermissionDenied(abs.display().to_string())
            }
            _ => CoreError::SourceWriteFailed(format!("replace: {e}")),
        })
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    write_result
}

/// Optimistic-concurrency write: re-reads the file, compares the current
/// disk hash to `expected_hash`, refuses to clobber an external change,
/// then atomically writes `content` re-encoded to `eol`/`bom`.
pub fn write_source_file(
    root: &Path,
    relative_path: &str,
    content: &str,
    expected_hash: &str,
    eol: LineEnding,
    bom: bool,
) -> CoreResult<SourceFileWrite> {
    let path = resolve_editable(root, relative_path)?;
    let disk = std::fs::read(&path).map_err(|e| map_read_err(relative_path, e))?;
    let disk_hash = hash_bytes(&disk);
    if disk_hash != expected_hash {
        return Err(CoreError::SourceEditConflict { disk_hash });
    }
    let bytes = encode_disk(content, eol, bom);
    atomic_replace(&path, &bytes)?;
    Ok(SourceFileWrite {
        relative_path: relative_path.to_string(),
        hash: hash_bytes(&bytes),
    })
}
