//! Lightweight local settings — a single JSON file under the OS app-config
//! directory. No database, no secrets: recents, preferred launcher and
//! browser behavior only. `.env` files are never touched.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

const MAX_RECENT_PROJECTS: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub recent_projects: Vec<PathBuf>,
    pub preferred_launcher: Option<String>,
    pub open_browser_automatically: bool,
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
                Ok(s) => Ok(s),
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
    pub fn push_recent_project(&self, project: &Path) -> CoreResult<Settings> {
        let mut s = self.load()?;
        s.recent_projects.retain(|p| p != project);
        s.recent_projects.insert(0, project.to_path_buf());
        s.recent_projects.truncate(MAX_RECENT_PROJECTS);
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
        let mut s = self.load()?;
        s.open_browser_automatically = value;
        self.save(&s)?;
        Ok(s)
    }
}
