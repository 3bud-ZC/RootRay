use std::path::{Path, PathBuf};

/// Copies the bundled inspector assets (Node runner, Vite plugin, browser
/// runtime) next to the crate so Tauri can ship them as bundle resources.
/// They are build outputs of `packages/` — run `pnpm -r --if-present build`
/// first (CI and the release workflow both do).
fn stage_inspector_assets() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let packages = manifest.join("../../../packages");
    let out = manifest.join("inspector-assets");
    std::fs::create_dir_all(&out).expect("create inspector-assets dir");

    let files = [
        "vite-plugin/dist/runner.cjs",
        "vite-plugin/dist/plugin.cjs",
        "inspector-runtime/dist/runtime.js",
    ];
    for rel in files {
        let src = packages.join(rel);
        println!("cargo:rerun-if-changed={}", src.display());
        if !src.is_file() {
            // Missing assets are only fatal for packaged builds; the dev
            // workspace resolves them directly from packages/ anyway.
            println!("cargo:warning=inspector asset missing: {}", src.display());
            continue;
        }
        let dst = out.join(Path::new(rel).file_name().unwrap());
        std::fs::copy(&src, &dst).expect("stage inspector asset");
    }
}

fn main() {
    stage_inspector_assets();
    tauri_build::build()
}
