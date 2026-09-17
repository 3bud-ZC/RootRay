use rootray_core::settings::SettingsStore;

#[test]
fn defaults_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    let s = store.load().unwrap();
    assert!(s.recent_projects.is_empty());
    assert!(s.preferred_launcher.is_none());
    // The internal preview is the primary surface — on for fresh installs.
    assert_eq!(s.open_preview_automatically, Some(true));
    // The deprecated key stays in sync for backward-compatible readers.
    assert!(s.open_browser_automatically);
}

#[test]
fn legacy_browser_setting_migrates_to_preview() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());

    // A v0.2 file with auto-open disabled: the user's "don't open
    // things automatically" choice carries over to the preview.
    std::fs::write(
        store.path(),
        r#"{"recentProjects":[],"preferredLauncher":null,"openBrowserAutomatically":false,"lastProject":null}"#,
    )
    .unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.open_preview_automatically, Some(false));
    assert!(!s.open_browser_automatically);

    // And the enabled case migrates identically.
    std::fs::write(
        store.path(),
        r#"{"recentProjects":[],"preferredLauncher":null,"openBrowserAutomatically":true,"lastProject":null}"#,
    )
    .unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.open_preview_automatically, Some(true));

    // Once both keys exist the new one wins — no flip-flopping.
    std::fs::write(
        store.path(),
        r#"{"recentProjects":[],"preferredLauncher":null,"openBrowserAutomatically":true,"openPreviewAutomatically":false,"lastProject":null}"#,
    )
    .unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.open_preview_automatically, Some(false));
    assert!(!s.open_browser_automatically);
}

#[test]
fn preview_preference_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    store.set_open_preview_automatically(false).unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.open_preview_automatically, Some(false));
    // Legacy callers writing the old field land on the same setting.
    store.set_open_browser_automatically(true).unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.open_preview_automatically, Some(true));
}

#[test]
fn recents_dedupe_and_cap() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    for i in 0..15 {
        store
            .push_recent_project(&dir.path().join(format!("proj-{i}")))
            .unwrap();
    }
    let s = store.load().unwrap();
    assert_eq!(s.recent_projects.len(), 10);
    // Re-push an existing one → moves to front, no duplicate.
    let again = dir.path().join("proj-14");
    store.push_recent_project(&again).unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.recent_projects[0], again);
    assert_eq!(
        s.recent_projects.iter().filter(|p| **p == again).count(),
        1
    );
}

#[test]
fn corrupt_settings_fall_back_to_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    std::fs::write(store.path(), "{{{{ garbage").unwrap();
    let s = store.load().unwrap();
    assert!(s.recent_projects.is_empty());
    // corrupt file preserved for diagnostics
    assert!(store.path().with_extension("json.corrupt").exists());
}

#[test]
fn remove_and_clear_recents() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    store.push_recent_project(std::path::Path::new("a")).unwrap();
    store.push_recent_project(std::path::Path::new("b")).unwrap();
    store.remove_recent_project(std::path::Path::new("a")).unwrap();
    let s = store.load().unwrap();
    assert_eq!(s.recent_projects.len(), 1);
    store.clear_recent_projects().unwrap();
    assert!(store.load().unwrap().recent_projects.is_empty());
}
