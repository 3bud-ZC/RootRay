//! Lightweight local settings — a single JSON file under the OS app-config
//! directory. No database, no secrets: recents, preferred launcher and
//! browser behavior only. `.env` files are never touched.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

const MAX_RECENT_PROJECTS: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub recent_projects: Vec<PathBuf>,
    pub preferred_launcher: Option<String>,
    /// Deprecated v0.2 key — kept so old settings files migrate instead
    /// of crashing. Always normalized to match `open_preview_automatically`
    /// on load/save; never read directly.
    pub open_browser_automatically: bool,
    /// `None` in files written before the internal preview existed —
    /// `load()` migrates the legacy `open_browser_automatically` value.
    /// `Some` is the authoritative preference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_preview_automatically: Option<bool>,
    /// Last successfully analyzed project — used to restore context on
    /// the next launch. Read-only restore: nothing is ever started
    /// automatically.
    pub last_project: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recent_projects: Vec::new(),
            preferred_launcher: None,
            open_browser_automatically: true,
            // The internal preview is the primary surface — on for a
            // fresh install, migrated (not reset) for existing users.
            open_preview_automatically: Some(true),
            last_project: None,
        }
    }
}

impl Settings {
    /// Folds the legacy `openBrowserAutomatically` value into the new
    /// `openPreviewAutomatically` field and keeps the two in sync on the
    /// way back out so neither an old nor a new reader sees drift.
    fn normalize(mut self) -> Self {
        let resolved = self
            .open_preview_automatically
            .unwrap_or(self.open_browser_automatically);
        self.open_preview_automatically = Some(resolved);
        self.open_browser_automatically = resolved;
        self
    }
}

/// JSON-file-backed settings store. The path is injected so tests can use
/// temp dirs and the Tauri layer can pass its app-config dir.
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("settings.json") }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads settings; a missing file yields defaults, a corrupt file is
    /// backed up and replaced with defaults rather than failing.
    pub fn load(&self) -> CoreResult<Settings> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
                Ok(s) => Ok(s.normalize()),
                Err(_) => {
                    let backup = self.path.with_extension("json.corrupt");
                    let _ = std::fs::rename(&self.path, &backup);
                    Ok(Settings::default())
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(CoreError::SettingsIo(format!("{}: {e}", self.path.display()))),
        }
    }

    pub fn save(&self, settings: &Settings) -> CoreResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CoreError::SettingsIo(format!("{}: {e}", parent.display()))
            })?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let raw = serde_json::to_string_pretty(settings)
            .map_err(|e| CoreError::SettingsIo(e.to_string()))?;
        std::fs::write(&tmp, raw)
            .and_then(|_| std::fs::rename(&tmp, &self.path))
            .map_err(|e| CoreError::SettingsIo(format!("{}: {e}", self.path.display())))
    }

    /// Records `project` as most-recent (deduped, capped at 10) and saves.
    /// Also becomes the last-opened project for session restore.
    pub fn push_recent_project(&self, project: &Path) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.recent_projects.retain(|p| p != project);
        s.recent_projects.insert(0, project.to_path_buf());
        s.recent_projects.truncate(MAX_RECENT_PROJECTS);
        s.last_project = Some(project.to_path_buf());
        self.save(&s)?;
        Ok(s)
    }

    pub fn remove_recent_project(&self, project: &Path) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.recent_projects.retain(|p| p != project);
        self.save(&s)?;
        Ok(s)
    }

    pub fn clear_recent_projects(&self) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.recent_projects.clear();
        self.save(&s)?;
        Ok(s)
    }

    pub fn set_preferred_launcher(&self, id: Option<&str>) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.preferred_launcher = id.map(str::to_string);
        self.save(&s)?;
        Ok(s)
    }

    pub fn set_open_browser_automatically(&self, value: bool) -> CoreResult<Settings> {
        self.set_open_preview_automatically(value)
    }

    pub fn set_open_preview_automatically(&self, value: bool) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.open_preview_automatically = Some(value);
        s.open_browser_automatically = value;
        self.save(&s)?;
        Ok(s)
    }
}
