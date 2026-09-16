//! Read-only workspace scan CLI — `cargo run -p rootray-core --example scan -- <dir>`.
//! Prints the WorkspaceAnalysis summary the desktop app would receive.
//! Executes nothing; only reads manifests within the bounded caps.

use std::path::Path;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: scan <directory>");
    match rootray_core::project::analyze_workspace(Path::new(&dir)) {
        Ok(a) => {
            println!("workspace : {} ({})", a.name.as_deref().unwrap_or("?"), a.root.display());
            println!("kind      : {}", a.workspace_kind.display());
            println!("pkg-mgr   : {}", a.package_manager.display_name());
            println!("manifests : {:?}", a.manifests);
            println!("targets   : {} (active: {:?})", a.targets.len(), a.active_target_id);
            for t in &a.targets {
                println!(
                    "  - {:20} kind={:9} fw={:10} pm={:6} run={}",
                    t.id,
                    t.kind.display(),
                    match t.framework_version {
                        Some(ref v) => format!("{} {}", t.framework.display(), v),
                        None => t.framework.display().to_string(),
                    },
                    t.package_manager.display_name(),
                    t.selected_runner
                        .as_ref()
                        .map(|r| r.display.as_str())
                        .unwrap_or("—"),
                );
            }
            println!(
                "metrics   : {} dirs, {} manifests, {}B metadata, {}ms{}",
                a.discovery.dirs_visited,
                a.discovery.manifests_read,
                a.discovery.metadata_bytes,
                a.discovery.elapsed_ms,
                if a.discovery.truncated { " (truncated)" } else { "" },
            );
            if !a.warnings.is_empty() {
                println!("warnings  : {:?}", a.warnings);
            }
        }
        Err(e) => {
            eprintln!("error: {} [{}]", e, e.code());
            std::process::exit(1);
        }
    }
}
