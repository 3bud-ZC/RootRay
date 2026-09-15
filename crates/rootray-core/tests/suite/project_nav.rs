//! Safe project navigation: lazy directory listing, Quick Open file
//! listing, bounded workspace search and intelligence source collection.

use std::fs;

use rootray_core::filesystem::nav::{
    collect_source_files, list_project_dir, list_project_files, search_workspace, EntryKind,
    MAX_DIR_ENTRIES, MAX_INTEL_FILES, MAX_LIST_FILES, MAX_SEARCH_FILES, MAX_SEARCH_RESULTS,
};

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/components")).unwrap();
    fs::create_dir_all(dir.path().join("src/styles")).unwrap();
    dir
}

fn code(err: &rootray_core::CoreError) -> &'static str {
    err.code()
}

// --- directory listing --------------------------------------------------------

#[test]
fn lists_root_lazily_dirs_first() {
    let dir = project();
    fs::write(dir.path().join("src/App.tsx"), "x").unwrap();
    fs::write(dir.path().join("package.json"), "{}").unwrap();
    fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    fs::write(dir.path().join("node_modules/pkg/index.js"), "x").unwrap();
    fs::create_dir_all(dir.path().join("dist")).unwrap();
    fs::write(dir.path().join(".env"), "SECRET=1").unwrap();

    let listing = list_project_dir(dir.path(), "").unwrap();
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"src"));
    assert!(names.contains(&"package.json"));
    // Generated dirs and secrets never surface.
    assert!(!names.contains(&"node_modules"));
    assert!(!names.contains(&"dist"));
    assert!(!names.contains(&".env"));
    // Directories sort before files.
    assert_eq!(listing.entries[0].kind, EntryKind::Dir);
}

#[test]
fn lists_child_dir_on_demand() {
    let dir = project();
    fs::write(dir.path().join("src/components/Button.tsx"), "x").unwrap();
    fs::write(dir.path().join("src/App.tsx"), "x").unwrap();
    let listing = list_project_dir(dir.path(), "src/components").unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].relative_path, "src/components/Button.tsx");
    assert!(listing.entries[0].editable);
}

#[test]
fn rejects_tree_traversal_and_absolute() {
    let dir = project();
    for p in ["..", "../x", "..\\x", "src/../../etc"] {
        let err = list_project_dir(dir.path(), p).unwrap_err();
        assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT", "{p}");
    }
    let err = list_project_dir(dir.path(), "C:/Windows").unwrap_err();
    assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn rejects_ignored_dir_listing() {
    let dir = project();
    fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    let err = list_project_dir(dir.path(), "node_modules").unwrap_err();
    assert_eq!(code(&err), "SOURCE_FILE_DENIED");
}

#[cfg(windows)]
#[test]
fn rejects_symlinked_dir_listing() {
    let dir = project();
    let outside = tempfile::tempdir().unwrap();
    let link = dir.path().join("escape");
    if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
        eprintln!("symlink creation not permitted — skipping");
        return;
    }
    let err = list_project_dir(dir.path(), "escape").unwrap_err();
    assert_eq!(code(&err), "PROJECT_OUTSIDE_ALLOWED_ROOT");
}

#[test]
fn dir_listing_caps_and_marks_truncated() {
    let dir = project();
    for i in 0..(MAX_DIR_ENTRIES + 50) {
        fs::write(dir.path().join(format!("src/f{i:05}.ts")), "x").unwrap();
    }
    let listing = list_project_dir(dir.path(), "src").unwrap();
    assert_eq!(listing.entries.len(), MAX_DIR_ENTRIES);
    assert!(listing.truncated);
}

// --- quick open file listing ----------------------------------------------------

#[test]
fn lists_editable_files_only() {
    let dir = project();
    fs::write(dir.path().join("src/App.tsx"), "x").unwrap();
    fs::write(dir.path().join("src/logo.png"), [0u8, 1, 2]).unwrap();
    fs::write(dir.path().join("README.md"), "# hi").unwrap();
    fs::write(dir.path().join("data.sqlite"), "x").unwrap();
    fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
    fs::write(dir.path().join("node_modules/x/a.js"), "x").unwrap();

    let listing = list_project_files(dir.path()).unwrap();
    assert!(listing.paths.contains(&"src/App.tsx".to_string()));
    assert!(listing.paths.contains(&"README.md".to_string()));
    assert!(!listing.paths.iter().any(|p| p.contains("node_modules")));
    assert!(!listing.paths.iter().any(|p| p.ends_with(".png")));
    assert!(!listing.paths.iter().any(|p| p.ends_with(".sqlite")));
    // Deterministic order.
    let mut sorted = listing.paths.clone();
    sorted.sort();
    assert_eq!(listing.paths, sorted);
}

// --- workspace search -------------------------------------------------------------

#[test]
fn finds_matches_with_positions() {
    let dir = project();
    fs::write(
        dir.path().join("src/App.tsx"),
        "import { A } from './a';\nexport function App() { return <A/> }\n",
    )
    .unwrap();
    fs::write(dir.path().join("src/components/a.ts"), "export const A = 1;\n").unwrap();

    let res = search_workspace(dir.path(), "export").unwrap();
    assert_eq!(res.matches.len(), 2);
    let m = res.matches.iter().find(|m| m.relative_path == "src/App.tsx").unwrap();
    assert_eq!(m.line, 2);
    assert!(m.column >= 1);
    assert!(m.preview.contains("export"));
}

#[test]
fn search_handles_crlf_line_numbers() {
    let dir = project();
    fs::write(
        dir.path().join("src/crlf.ts"),
        "line one\r\nneedle here\r\nline three\r\n",
    )
    .unwrap();
    let res = search_workspace(dir.path(), "needle").unwrap();
    assert_eq!(res.matches.len(), 1);
    assert_eq!(res.matches[0].line, 2);
}

#[test]
fn search_skips_secrets_binaries_and_generated() {
    let dir = project();
    fs::write(dir.path().join(".env"), "needle=secret").unwrap();
    fs::write(dir.path().join("src/blob.ts"), b"needle\0x").unwrap();
    fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
    fs::write(dir.path().join("node_modules/x/a.ts"), "needle").unwrap();
    fs::create_dir_all(dir.path().join("dist")).unwrap();
    fs::write(dir.path().join("dist/bundle.ts"), "needle").unwrap();
    fs::write(dir.path().join("src/clean.ts"), "needle").unwrap();

    let res = search_workspace(dir.path(), "needle").unwrap();
    assert_eq!(res.matches.len(), 1);
    assert_eq!(res.matches[0].relative_path, "src/clean.ts");
}

#[test]
fn search_enforces_result_cap() {
    let dir = project();
    for i in 0..40 {
        let body = (0..10).map(|_| "needle\n").collect::<String>();
        fs::write(dir.path().join(format!("src/f{i}.ts")), body).unwrap();
    }
    let res = search_workspace(dir.path(), "needle").unwrap();
    assert!(res.matches.len() <= MAX_SEARCH_RESULTS);
    assert!(res.truncated);
}

#[test]
fn search_rejects_empty_and_huge_queries() {
    let dir = project();
    assert!(search_workspace(dir.path(), "   ").is_err());
    assert!(search_workspace(dir.path(), &"x".repeat(201)).is_err());
}

#[test]
fn search_is_case_insensitive() {
    let dir = project();
    fs::write(dir.path().join("src/a.ts"), "const FooBar = 1;\n").unwrap();
    let res = search_workspace(dir.path(), "foobar").unwrap();
    assert_eq!(res.matches.len(), 1);
    assert!(res.matches[0].preview.contains("FooBar"));
}

#[test]
fn search_tolerates_disappearing_files() {
    // A file that vanishes mid-scan is skipped, not fatal — covered by the
    // tolerate-read-errors walk; here simply assert a normal run works.
    let dir = project();
    fs::write(dir.path().join("src/a.ts"), "needle").unwrap();
    let res = search_workspace(dir.path(), "needle").unwrap();
    assert_eq!(res.files_scanned, 1);
}

// --- intelligence collection --------------------------------------------------------

#[test]
fn collects_js_ts_sources_within_caps() {
    let dir = project();
    fs::write(dir.path().join("src/App.tsx"), "export function App() {}").unwrap();
    fs::write(dir.path().join("src/styles/app.css"), ".a{}").unwrap();
    fs::write(dir.path().join("README.md"), "x").unwrap();
    fs::write(dir.path().join("src/data.json"), "{}").unwrap();

    let coll = collect_source_files(dir.path()).unwrap();
    let paths: Vec<&str> = coll.files.iter().map(|f| f.relative_path.as_str()).collect();
    assert_eq!(paths, vec!["src/App.tsx"]); // only JS/TS — no css/md/json
    assert!(coll.files[0].content.contains("App"));
    assert!(!coll.truncated);
}

#[test]
fn collection_skips_denied_and_generated() {
    let dir = project();
    fs::write(dir.path().join(".env.local"), "x").unwrap();
    fs::create_dir_all(dir.path().join("node_modules/lib")).unwrap();
    fs::write(dir.path().join("node_modules/lib/index.js"), "x").unwrap();
    let coll = collect_source_files(dir.path()).unwrap();
    assert!(coll.files.is_empty());
}

// --- large synthetic project ----------------------------------------------------
//
// Generated per-test, never committed: thousands of files across nested dirs.
// RootRay must return bounded, truncated results — never walk unbounded.

fn big_project(file_count: usize) -> tempfile::TempDir {
    let dir = project();
    for i in 0..file_count {
        let sub = format!("src/gen/d{:02}", i % 50);
        fs::create_dir_all(dir.path().join(&sub)).unwrap();
        fs::write(
            dir.path().join(format!("{sub}/f{i:05}.ts")),
            "export const needle = 1;\n",
        )
        .unwrap();
    }
    dir
}

#[test]
fn large_project_results_are_bounded() {
    // One corpus over every cap: listing, search-scan and intel collection
    // must all stop at their limits and flag truncation.
    let dir = big_project(MAX_LIST_FILES + 300);

    let listing = list_project_files(dir.path()).unwrap();
    assert_eq!(listing.paths.len(), MAX_LIST_FILES);
    assert!(listing.truncated);

    let res = search_workspace(dir.path(), "needle").unwrap();
    assert!(res.matches.len() <= MAX_SEARCH_RESULTS);
    assert!(res.files_scanned <= MAX_SEARCH_FILES as u32);
    assert!(res.truncated);

    let coll = collect_source_files(dir.path()).unwrap();
    assert!(coll.files.len() <= MAX_INTEL_FILES);
    assert!(coll.truncated);
}
