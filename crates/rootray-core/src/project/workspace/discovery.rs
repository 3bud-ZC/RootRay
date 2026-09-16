//! Bounded, read-only workspace scan.
//!
//! Hard caps keep discovery deterministic on huge repositories. Generated
//! output and dependency directories are never entered. Symlinked or
//! junctioned directories are only followed when they canonicalize inside
//! the selected workspace root — escapes are skipped with a warning.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

use super::DiscoveryMetrics;

/// Directories never entered during discovery — dependency, VCS, build
/// and tool-output locations.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".output",
    ".vercel",
    ".cache",
    ".turbo",
    ".expo",
    "playwright-report",
    "test-results",
    ".e2e-work",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
];

/// Files whose contents are never opened — only their existence may be
/// recorded as evidence. Secrets stay untouched by construction.
const SECRET_FILE_PREFIXES: &[&str] = &[".env", "id_rsa", "id_ed25519", "credentials"];

/// Hard discovery bounds.
pub const MAX_DEPTH: usize = 4;
pub const MAX_DIRS: usize = 400;
pub const MAX_MANIFESTS: usize = 64;
/// Total bytes of metadata (package.json / workspace yaml) read.
pub const MAX_METADATA_BYTES: u64 = 256 * 1024;
/// Single metadata file byte cap — a package.json should never be huge.
pub const MAX_FILE_BYTES: u64 = 64 * 1024;

/// What the bounded scan found.
#[derive(Debug, Default)]
pub struct Scan {
    /// `root/package.json` exists.
    pub root_manifest: bool,
    /// Canonical dirs containing a package.json (root first when present).
    pub manifest_dirs: Vec<PathBuf>,
    /// `pnpm-workspace.yaml` / `.yml` at the workspace root.
    pub pnpm_workspace_file: Option<PathBuf>,
    /// `package` globs declared by pnpm-workspace.yaml.
    pub pnpm_globs: Vec<String>,
    /// `turbo.json` at the workspace root.
    pub has_turbo: bool,
    /// `tsconfig.json` at the workspace root.
    pub has_root_tsconfig: bool,
    /// `jsconfig.json` at the workspace root.
    pub has_root_jsconfig: bool,
    /// Dirs (root or shallow) containing an `index.html`.
    pub index_html_dirs: Vec<PathBuf>,
}

/// Reads a metadata file, charging bytes to the metrics cap.
/// Returns `None` past the byte cap or when the file itself is oversized.
pub fn read_metadata(path: &Path, metrics: &mut DiscoveryMetrics) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_FILE_BYTES || metrics.metadata_bytes + size > MAX_METADATA_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    metrics.metadata_bytes += size;
    Some(text)
}

/// True when the name looks like a secret/credential file we must not read.
fn is_secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    SECRET_FILE_PREFIXES
        .iter()
        .any(|p| lower == *p || lower.starts_with(&format!("{p}.")) )
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

/// Bounded breadth-first scan under `root` (already canonicalized).
pub fn scan(root: &Path, metrics: &mut DiscoveryMetrics, warnings: &mut Vec<String>) -> Scan {
    let mut scan = Scan::default();
    scan.root_manifest = root.join("package.json").is_file();
    if scan.root_manifest {
        metrics.manifests_read += 1;
        scan.manifest_dirs.push(root.to_path_buf());
    }
    for name in ["pnpm-workspace.yaml", "pnpm-workspace.yml"] {
        let path = root.join(name);
        if path.is_file() {
            scan.pnpm_workspace_file = Some(path.clone());
            if let Some(text) = read_metadata(&path, metrics) {
                scan.pnpm_globs = parse_pnpm_globs(&text);
            }
            break;
        }
    }
    scan.has_turbo = root.join("turbo.json").is_file();
    scan.has_root_tsconfig = root.join("tsconfig.json").is_file();
    scan.has_root_jsconfig = root.join("jsconfig.json").is_file();
    if root.join("index.html").is_file() {
        scan.index_html_dirs.push(root.to_path_buf());
    }

    // --- BFS over directories ---------------------------------------------
    let mut seen: HashSet<PathBuf> = HashSet::new();
    seen.insert(root.to_path_buf());
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if metrics.dirs_visited >= MAX_DIRS {
            metrics.truncated = true;
            warnings.push(format!(
                "discovery truncated after {MAX_DIRS} directories"
            ));
            break;
        }
        metrics.dirs_visited += 1;
        if depth >= MAX_DEPTH {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // unreadable dirs are skipped silently
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if ft.is_dir() && !ft.is_symlink() {
                if IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                // Canonicalize: junctions/symlinks resolving outside the
                // selected root are never followed.
                let canonical = match path.canonicalize() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let canonical = crate::filesystem::strip_verbatim_pub(&canonical);
                if !canonical.starts_with(root) {
                    warnings.push(format!(
                        "skipped directory escaping the workspace root: {}",
                        super::rel(root, &path)
                    ));
                    continue;
                }
                if !seen.insert(canonical.clone()) {
                    continue; // already queued (hardlink/junction cycle)
                }

                if canonical.join("package.json").is_file() {
                    if scan.manifest_dirs.len() >= MAX_MANIFESTS {
                        metrics.truncated = true;
                        warnings.push(format!(
                            "manifest discovery truncated after {MAX_MANIFESTS} manifests"
                        ));
                        continue;
                    }
                    metrics.manifests_read += 1;
                    scan.manifest_dirs.push(canonical.clone());
                }
                if canonical.join("index.html").is_file() {
                    scan.index_html_dirs.push(canonical.clone());
                }
                queue.push_back((canonical, depth + 1));
            } else if ft.is_symlink() {
                // A symlinked *directory* — follow only if it stays inside.
                if path.is_dir() {
                    if IGNORED_DIRS.contains(&name.as_str()) {
                        continue;
                    }
                    let canonical = match path.canonicalize() {
                        Ok(c) => crate::filesystem::strip_verbatim_pub(&c),
                        Err(_) => continue,
                    };
                    if !canonical.starts_with(root) {
                        warnings.push(format!(
                            "skipped link escaping the workspace root: {}",
                            super::rel(root, &path)
                        ));
                        continue;
                    }
                    if seen.insert(canonical.clone()) {
                        if canonical.join("package.json").is_file()
                            && scan.manifest_dirs.len() < MAX_MANIFESTS
                        {
                            metrics.manifests_read += 1;
                            scan.manifest_dirs.push(canonical.clone());
                        }
                        if canonical.join("index.html").is_file() {
                            scan.index_html_dirs.push(canonical.clone());
                        }
                        queue.push_back((canonical, depth + 1));
                    }
                }
            }
            // file-level secret names are noted but never read.
            if ft.is_file() && is_secret_name(&name) {
                // Existence only — contents are never opened.
            }
        }
    }

    // --- declared workspace globs supplement the walk ---------------------
    // (globs from pnpm-workspace.yaml / package.json workspaces may point
    // at directories the bounded walk did not reach).
    for pattern in scan.pnpm_globs.clone() {
        expand_glob(root, &pattern, metrics, warnings, &mut seen, &mut scan);
    }

    scan.manifest_dirs.sort();
    scan.manifest_dirs.dedup();
    scan
}

/// `pnpm-workspace.yaml` `packages:` list — deliberately a tolerant line
/// scan, not a YAML dependency.
fn parse_pnpm_globs(text: &str) -> Vec<String> {
    let mut globs = Vec::new();
    let mut in_packages = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("packages:") {
            in_packages = true;
            continue;
        }
        if in_packages {
            if let Some(item) = trimmed.strip_prefix('-') {
                let item = item.trim().trim_matches(|c| c == '\'' || c == '"');
                if !item.is_empty() && !item.starts_with('!') {
                    globs.push(item.to_string());
                }
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                break; // left the packages: block
            }
        }
    }
    globs
}

/// Expands one declared workspace glob (`apps/*`, `packages/**`) into
/// manifest dirs — bounded by the same caps.
fn expand_glob(
    root: &Path,
    pattern: &str,
    metrics: &mut DiscoveryMetrics,
    warnings: &mut Vec<String>,
    seen: &mut HashSet<PathBuf>,
    scan: &mut Scan,
) {
    // Support the two shapes workspaces actually use: single `*` segments
    // (one directory level) and a trailing `**` (any depth within caps).
    let recursive = pattern.ends_with("/**");
    let pat = pattern.trim_end_matches("/**").trim_end_matches('/');
    let parts: Vec<&str> = pat.split('/').collect();
    let mut frontier: Vec<PathBuf> = vec![root.to_path_buf()];
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        let mut next = Vec::new();
        for base in &frontier {
            if *part == "*" {
                if let Ok(entries) = std::fs::read_dir(base) {
                    for e in entries.flatten() {
                        let p = e.path();
                        if p.is_dir()
                            && !IGNORED_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
                        {
                            next.push(p);
                        }
                    }
                }
            } else {
                let p = base.join(part);
                if p.is_dir() {
                    next.push(p);
                }
            }
            if next.len() > MAX_MANIFESTS * 4 {
                metrics.truncated = true;
                break;
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
        if last && recursive {
            // `**`: also gather nested dirs one more bounded level deep.
            let mut deep = Vec::new();
            for base in &frontier {
                if let Ok(entries) = std::fs::read_dir(base) {
                    for e in entries.flatten() {
                        let p = e.path();
                        if p.is_dir()
                            && !IGNORED_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
                        {
                            deep.push(p);
                        }
                    }
                }
            }
            frontier.extend(deep);
        }
    }
    for dir in frontier {
        let canonical = match dir.canonicalize() {
            Ok(c) => crate::filesystem::strip_verbatim_pub(&c),
            Err(_) => continue,
        };
        if !canonical.starts_with(root) {
            warnings.push(format!(
                "skipped workspace package outside the root: {}",
                super::rel(root, &dir)
            ));
            continue;
        }
        if canonical.join("package.json").is_file() && seen.insert(canonical.clone()) {
            if scan.manifest_dirs.len() >= MAX_MANIFESTS {
                metrics.truncated = true;
                break;
            }
            metrics.manifests_read += 1;
            scan.manifest_dirs.push(canonical);
        }
    }
}
