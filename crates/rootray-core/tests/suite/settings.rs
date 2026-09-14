use rootray_core::settings::SettingsStore;

#[test]
fn defaults_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path());
    let s = store.load().unwrap();
    assert!(s.recent_projects.is_empty());
    assert!(s.preferred_launcher.is_none());
    assert!(!s.open_browser_automatically);
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
