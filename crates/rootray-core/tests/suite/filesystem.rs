use std::fs;
use std::path::Path;

use rootray_core::filesystem::{
    canonicalize_root, ensure_lexically_within_root, ensure_within_root,
};

#[test]
fn accepts_valid_child_path() {
    let dir = tempfile::tempdir().unwrap();
    let child = dir.path().join("src/main.ts");
    fs::create_dir_all(child.parent().unwrap()).unwrap();
    fs::write(&child, "x").unwrap();
    let resolved = ensure_within_root(dir.path(), &child).unwrap();
    assert!(resolved.ends_with("main.ts"));
}

#[test]
fn rejects_dotdot_escape() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let escape = dir.path().join("..").join(
        outside.path().file_name().unwrap(),
    );
    let err = ensure_lexically_within_root(dir.path(), &escape).unwrap_err();
    assert_eq!(err.code(), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn rejects_absolute_path_outside_root() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("secret.txt");
    fs::write(&file, "x").unwrap();
    let err = ensure_within_root(dir.path(), &file).unwrap_err();
    assert_eq!(err.code(), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn normalizes_internal_dotdot_within_root() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("src/deep/../main.ts");
    // `src/main.ts` must exist for full canonicalization
    fs::create_dir_all(dir.path().join("src/deep")).unwrap();
    fs::write(dir.path().join("src/main.ts"), "x").unwrap();
    let resolved = ensure_within_root(dir.path(), &file).unwrap();
    assert!(resolved.ends_with("src\\main.ts") || resolved.ends_with("src/main.ts"));
}

#[test]
fn rejects_nonexistent_root_and_file_root() {
    let dir = tempfile::tempdir().unwrap();
    assert!(canonicalize_root(&dir.path().join("nope")).is_err());
    let file = dir.path().join("a.txt");
    fs::write(&file, "x").unwrap();
    assert!(canonicalize_root(&file).is_err());
}

#[test]
fn symlink_escape_is_rejected_when_symlinks_supported() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "x").unwrap();
    let link = dir.path().join("link-out");

    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok();
    #[cfg(unix)]
    let created = std::os::unix::fs::symlink(outside.path(), &link).is_ok();

    if !created {
        eprintln!("symlink creation unavailable (needs privilege) — skipping");
        return;
    }
    let through_link = link.join("secret.txt");
    let err = ensure_within_root(dir.path(), &through_link).unwrap_err();
    assert_eq!(err.code(), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn lexical_check_allows_not_yet_existing_child() {
    let dir = tempfile::tempdir().unwrap();
    let future = Path::new("src/new-file.ts");
    let resolved = ensure_lexically_within_root(dir.path(), &dir.path().join(future)).unwrap();
    assert!(resolved.ends_with("new-file.ts"));
}
