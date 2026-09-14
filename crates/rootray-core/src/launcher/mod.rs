//! External code-editor ("launcher") detection.
//!
//! Detection is data-driven: each [`LauncherSpec`] lists PATH names and
//! well-known install locations. Adding an editor later means appending a
//! spec — no machine-wide recursive search is ever performed.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLauncher {
    pub id: String,
    pub name: String,
    /// Best executable to launch (install location preferred, else PATH shim).
    pub executable_path: Option<PathBuf>,
    pub available: bool,
}

struct LauncherSpec {
    id: &'static str,
    name: &'static str,
    /// Executable names to look up on PATH (without extension).
    path_names: &'static [&'static str],
    /// Install locations relative to env vars like LOCALAPPDATA.
    /// (env var, relative path)
    known_locations: &'static [(&'static str, &'static str)],
}

/// Registry of supported editors. Extend here for new launchers.
const LAUNCHERS: &[LauncherSpec] = &[
    LauncherSpec {
        id: "vscode",
        name: "Visual Studio Code",
        path_names: &["code"],
        known_locations: &[
            ("LOCALAPPDATA", r"Programs\Microsoft VS Code\Code.exe"),
            ("ProgramFiles", r"Microsoft VS Code\Code.exe"),
            ("ProgramFiles(x86)", r"Microsoft VS Code\Code.exe"),
        ],
    },
    LauncherSpec {
        id: "cursor",
        name: "Cursor",
        path_names: &["cursor"],
        known_locations: &[("LOCALAPPDATA", r"Programs\cursor\Cursor.exe")],
    },
    LauncherSpec {
        id: "windsurf",
        name: "Windsurf",
        path_names: &["windsurf"],
        known_locations: &[("LOCALAPPDATA", r"Programs\Windsurf\Windsurf.exe")],
    },
];

/// Looks up `name` in the given directories, trying each PATHEXT extension.
/// Returns the first existing match.
fn which_in(dirs: &[PathBuf], name: &str, pathext: &[String]) -> Option<PathBuf> {
    for dir in dirs {
        // Exact name first (already has an extension).
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in pathext {
            let candidate = dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default()
}

fn pathext() -> Vec<String> {
    #[cfg(windows)]
    {
        std::env::var("PATHEXT")
            .map(|v| v.split(';').map(|s| s.trim_start_matches('.').to_string()).collect())
            .unwrap_or_else(|_| vec!["COM".into(), "EXE".into(), "BAT".into(), "CMD".into()])
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Detects every registered launcher. Fast: checks PATH entries and a
/// handful of well-known install dirs only.
pub fn detect_launchers() -> Vec<DetectedLauncher> {
    let dirs = path_dirs();
    let exts = pathext();
    LAUNCHERS
        .iter()
        .map(|spec| {
            // Prefer real install locations over PATH shims.
            let installed = spec.known_locations.iter().find_map(|(env, rel)| {
                std::env::var_os(env).map(|base| Path::new(&base).join(rel)).and_then(
                    |p| if p.is_file() { Some(p) } else { None },
                )
            });
            let on_path = spec
                .path_names
                .iter()
                .find_map(|n| which_in(&dirs, n, &exts));
            let executable_path = installed.or(on_path);
            DetectedLauncher {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                available: executable_path.is_some(),
                executable_path,
            }
        })
        .collect()
}

/// Finds one launcher by id among detected ones.
pub fn find_launcher(id: &str) -> Option<DetectedLauncher> {
    detect_launchers()
        .into_iter()
        .find(|l| l.id == id && l.available)
}

/// Opens `path` in the given launcher. `path` must already be validated
/// against the project root by the caller.
pub fn open_path_in_launcher(launcher: &DetectedLauncher, path: &Path) -> CoreResult<()> {
    let exe = launcher
        .executable_path
        .as_ref()
        .ok_or_else(|| CoreError::LauncherNotFound(launcher.id.clone()))?;

    let mut command = if exe
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        let mut c = Command::new("cmd");
        c.arg("/d").arg("/s").arg("/c").arg(format!("\"{}\"", exe.display()));
        c
    } else {
        Command::new(exe)
    };
    command
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| CoreError::Internal(format!("failed to launch {}: {e}", launcher.name)))
}
