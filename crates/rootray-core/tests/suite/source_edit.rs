//! Safe source editing: boundary-checked read, optimistic-concurrency
//! atomic write, deny lists, encoding/line-ending preservation, watcher.

use std::fs;
use std::sync::mpsc::channel;
use std::time::Duration;

use rootray_core::editor::file::{
    atomic_replace, hash_source_file, read_source_file, write_source_file, LineEnding,
    MAX_EDIT_BYTES,
};
use rootray_core::editor::watch::FileWatcher;
use rootray_core::editor::EditorManager;

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/components")).unwrap();
    dir
}

fn code(err: &rootray_core::CoreError) -> &'static str {
    err.code()
}

// --- reads --------------------------------------------------------------------

#[test]
fn reads_valid_source_file() {
    let dir = project();
    fs::write(dir.path().join("src/App.tsx"), "export {}\n").unwrap();
    let r = read_source_file(dir.path(), "src/App.tsx").unwrap();
    assert_eq!(r.content, "export {}\n");
    assert_eq!(r.hash.len(), 64);
    assert_eq!(r.line_ending, LineEnding::Lf);
    assert!(!r.bom);
}

#[test]
fn rejects_traversal_and_absolute() {
    let dir = project();
    for p in ["../secret.ts", "..\\secret.ts", "src/../../x.ts"] {
        let err = read_source_file(dir.path(), p).unwrap_err();
        assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT", "{p}");
    }
    let outside = tempfile::tempdir().unwrap();
    let f = outside.path().join("x.ts");
    fs::write(&f, "x").unwrap();
    // Absolute paths are rejected by the relative-path contract up front.
    let err = read_source_file(dir.path(), &f.to_string_lossy().replace('\\', "/")).unwrap_err();
    assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[cfg(windows)]
#[test]
fn rejects_symlink_escape() {
    let dir = project();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("secret.ts");
    fs::write(&target, "x").unwrap();
    let link = dir.path().join("src/link.ts");
    // Symlink creation needs SeCreateSymbolicLinkPrivilege or Developer
    // Mode; skip rather than fail where the OS refuses.
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        eprintln!("symlink creation not permitted — skipping escape check");
        return;
    }
    let err = read_source_file(dir.path(), "src/link.ts").unwrap_err();
    assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn denies_secret_files() {
    let dir = project();
    for name in [".env", ".env.local", "id_rsa", "id_ed25519", "server.pem", "app.key", "store.p12", "credentials.json", "secrets.yaml"] {
        fs::write(dir.path().join(name), "x").unwrap();
        let err = read_source_file(dir.path(), name).unwrap_err();
        assert_eq!(code(&err), "SOURCE_FILE_DENIED", "{name}");
    }
}

#[test]
fn denies_generated_and_vendored_dirs() {
    let dir = project();
    for p in ["node_modules/react/index.js", "dist/app.js", "build/out.css", ".git/config.ts", "target/x.ts"] {
        let abs = dir.path().join(p);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, "x").unwrap();
        let err = read_source_file(dir.path(), p).unwrap_err();
        assert_eq!(code(&err), "SOURCE_FILE_DENIED", "{p}");
    }
}

#[test]
fn denies_binary_files() {
    let dir = project();
    fs::write(dir.path().join("src/blob.js"), b"a\0b\0c").unwrap();
    let err = read_source_file(dir.path(), "src/blob.js").unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_BINARY");
}

#[test]
fn denies_unsupported_extension() {
    let dir = project();
    fs::write(dir.path().join("logo.png"), "not really a png").unwrap();
    let err = read_source_file(dir.path(), "logo.png").unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_DENIED");
}

#[test]
fn denies_oversized_file() {
    let dir = project();
    fs::write(
        dir.path().join("src/big.ts"),
        vec![b'x'; (MAX_EDIT_BYTES + 1) as usize],
    )
    .unwrap();
    let err = read_source_file(dir.path(), "src/big.ts").unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_TOO_LARGE");
}

#[test]
fn rejects_invalid_utf8() {
    let dir = project();
    fs::write(dir.path().join("src/latin1.ts"), b"caf\xe9\n").unwrap();
    let err = read_source_file(dir.path(), "src/latin1.ts").unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_ENCODING_UNSUPPORTED");
}

#[test]
fn detects_and_normalizes_crlf() {
    let dir = project();
    fs::write(dir.path().join("src/win.ts"), "a\r\nb\r\nc\r\n").unwrap();
    let r = read_source_file(dir.path(), "src/win.ts").unwrap();
    assert_eq!(r.line_ending, LineEnding::Crlf);
    assert_eq!(r.content, "a\nb\nc\n");
}

#[test]
fn detects_utf8_bom() {
    let dir = project();
    fs::write(dir.path().join("src/bom.ts"), b"\xef\xbb\xbfhello\n").unwrap();
    let r = read_source_file(dir.path(), "src/bom.ts").unwrap();
    assert!(r.bom);
    assert_eq!(r.content, "hello\n");
}

// --- writes -------------------------------------------------------------------

#[test]
fn writes_with_matching_hash() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "v1\n").unwrap();
    let read = read_source_file(dir.path(), rel).unwrap();
    let w = write_source_file(dir.path(), rel, "v2\n", &read.hash, LineEnding::Lf, false).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join(rel)).unwrap(), "v2\n");
    assert_eq!(w.hash, hash_source_file(dir.path(), rel).unwrap().hash);
}

#[test]
fn wrong_hash_is_conflict_and_file_untouched() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "original\n").unwrap();
    let err = write_source_file(dir.path(), rel, "clobber\n", "deadbeef", LineEnding::Lf, false)
        .unwrap_err();
    assert_eq!(code(&err), "SOURCE_EDIT_CONFLICT");
    assert_eq!(fs::read_to_string(dir.path().join(rel)).unwrap(), "original\n");
}

#[test]
fn external_edit_between_load_and_save_conflicts() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "one\n").unwrap();
    let read = read_source_file(dir.path(), rel).unwrap();
    // VS Code (or anything else) edits the file after RootRay loaded it.
    fs::write(dir.path().join(rel), "external\n").unwrap();
    let err = write_source_file(dir.path(), rel, "mine\n", &read.hash, LineEnding::Lf, false)
        .unwrap_err();
    assert_eq!(code(&err), "SOURCE_EDIT_CONFLICT");
    assert_eq!(fs::read_to_string(dir.path().join(rel)).unwrap(), "external\n");
}

#[test]
fn preserves_crlf_on_save() {
    let dir = project();
    let rel = "src/win.ts";
    fs::write(dir.path().join(rel), "a\r\nb\r\n").unwrap();
    let read = read_source_file(dir.path(), rel).unwrap();
    write_source_file(dir.path(), rel, "a\nb\nc\n", &read.hash, LineEnding::Crlf, false).unwrap();
    let raw = fs::read(dir.path().join(rel)).unwrap();
    assert_eq!(raw, b"a\r\nb\r\nc\r\n");
}

#[test]
fn preserves_bom_on_save() {
    let dir = project();
    let rel = "src/bom.ts";
    fs::write(dir.path().join(rel), b"\xef\xbb\xbfhi\n").unwrap();
    let read = read_source_file(dir.path(), rel).unwrap();
    write_source_file(dir.path(), rel, "hi\nbye\n", &read.hash, LineEnding::Lf, true).unwrap();
    let raw = fs::read(dir.path().join(rel)).unwrap();
    assert_eq!(&raw[..3], b"\xef\xbb\xbf");
    assert_eq!(&raw[3..], b"hi\nbye\n");
}

#[test]
fn atomic_replace_leaves_no_temp_files() {
    let dir = project();
    let target = dir.path().join("src/App.tsx");
    fs::write(&target, "old\n").unwrap();
    atomic_replace(&target, b"new\n").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "new\n");
    let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("rootray-"))
        .collect();
    assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
}

#[test]
fn write_rejects_denied_and_outside_paths() {
    let dir = project();
    fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
    let err = write_source_file(dir.path(), ".env", "x", "h", LineEnding::Lf, false).unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_DENIED");
    let err = write_source_file(dir.path(), "../out.ts", "x", "h", LineEnding::Lf, false)
        .unwrap_err();
    assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[cfg(windows)]
#[test]
fn write_to_readonly_file_reports_permission_denied() {
    let dir = project();
    let rel = "src/locked.ts";
    let abs = dir.path().join(rel);
    fs::write(&abs, "ro\n").unwrap();
    let mut perms = fs::metadata(&abs).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&abs, perms.clone()).unwrap();
    let read = read_source_file(dir.path(), rel).unwrap();
    let err = write_source_file(dir.path(), rel, "x\n", &read.hash, LineEnding::Lf, false)
        .unwrap_err();
    // Readonly on Windows → AccessDenied on rename; accept the typed
    // permission error, or a write failure — never a silent clobber.
    assert!(
        code(&err) == "SOURCE_WRITE_PERMISSION_DENIED" || code(&err) == "SOURCE_WRITE_FAILED",
        "unexpected: {err:?}"
    );
    assert_eq!(fs::read_to_string(&abs).unwrap(), "ro\n");
    let mut p = perms;
    p.set_readonly(false);
    fs::set_permissions(&abs, p).unwrap();
}

// --- session + watcher ---------------------------------------------------------

#[test]
fn session_save_updates_base_hash() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "v1\n").unwrap();
    let mgr = EditorManager::new();
    let read = mgr.open(dir.path(), rel).unwrap();
    let w = mgr.save(dir.path(), rel, "v2\n", &read.hash).unwrap();
    let info = mgr.info(dir.path());
    assert_eq!(info.base_hash.as_deref(), Some(w.hash.as_str()));
    assert!(info.can_revert);
}

#[test]
fn session_revert_restores_previous_save() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "v1\n").unwrap();
    let mgr = EditorManager::new();
    let read = mgr.open(dir.path(), rel).unwrap();
    mgr.save(dir.path(), rel, "v2\n", &read.hash).unwrap();
    let reverted = mgr.revert_last_save(dir.path(), rel).unwrap();
    assert_eq!(reverted.content, "v1\n");
    assert_eq!(fs::read_to_string(dir.path().join(rel)).unwrap(), "v1\n");
    // Second revert is unavailable — snapshot consumed.
    assert!(mgr.revert_last_save(dir.path(), rel).is_err());
}

#[test]
fn revert_rejected_after_external_change() {
    let dir = project();
    let rel = "src/App.tsx";
    fs::write(dir.path().join(rel), "v1\n").unwrap();
    let mgr = EditorManager::new();
    let read = mgr.open(dir.path(), rel).unwrap();
    mgr.save(dir.path(), rel, "v2\n", &read.hash).unwrap();
    fs::write(dir.path().join(rel), "external\n").unwrap();
    let err = mgr.revert_last_save(dir.path(), rel).unwrap_err();
    assert_eq!(code(&err), "SOURCE_EDIT_CONFLICT");
    assert_eq!(fs::read_to_string(dir.path().join(rel)).unwrap(), "external\n");
}

#[test]
fn save_requires_open_session_for_same_file() {
    let dir = project();
    fs::write(dir.path().join("src/a.ts"), "a\n").unwrap();
    fs::write(dir.path().join("src/b.ts"), "b\n").unwrap();
    let mgr = EditorManager::new();
    let read = mgr.open(dir.path(), "src/a.ts").unwrap();
    let err = mgr.save(dir.path(), "src/b.ts", "x", &read.hash).unwrap_err();
    assert_eq!(code(&err), "EDITOR_SESSION_CLOSED");
}

#[test]
fn watcher_reports_external_change() {
    let dir = project();
    let rel = "src/watched.ts";
    let abs = dir.path().join(rel);
    fs::write(&abs, "v1\n").unwrap();
    let (tx, rx) = channel();
    let watcher = FileWatcher::watch(&abs, move || {
        let _ = tx.send(());
    })
    .unwrap();
    fs::write(&abs, "v2\n").unwrap();
    let fired = rx.recv_timeout(Duration::from_secs(5));
    assert!(fired.is_ok(), "watcher did not fire on external write");
    drop(watcher);
}

#[test]
fn watcher_stops_on_drop() {
    let dir = project();
    let abs = dir.path().join("src/w2.ts");
    fs::write(&abs, "v1\n").unwrap();
    let watcher = FileWatcher::watch(&abs, || {}).unwrap();
    drop(watcher); // must not hang — join returns promptly
}

#[test]
fn session_watcher_survives_save_then_external_edit() {
    let dir = project();
    let rel = "src/e.ts";
    fs::write(dir.path().join(rel), "v1\n").unwrap();
    let mgr = EditorManager::new();
    let (tx, rx) = channel::<()>();
    let mgr2 = mgr.clone();
    mgr.set_notify(std::sync::Arc::new(move |_| {
        let _ = tx.send(());
    }));
    let read = mgr2.open(dir.path(), rel).unwrap();
    // RootRay's own save must NOT surface as an external change (hash
    // re-bases to the new disk state).
    mgr.save(dir.path(), rel, "v2\n", &read.hash).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());
    // An external edit after the save must notify.
    std::thread::sleep(Duration::from_millis(200));
    fs::write(dir.path().join(rel), "v3\n").unwrap();
    assert!(
        rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "no external-change event after foreign write"
    );
    mgr.close();
}
