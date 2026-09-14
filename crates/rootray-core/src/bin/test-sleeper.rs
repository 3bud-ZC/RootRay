//! Deterministic fixture process for lifecycle tests.
//!
//! Behaviour is controlled by args:
//!   test-sleeper [--print-url <url>] [--exit-after <ms>] [--fail]
//!
//! It prints a fake "server ready" line (optionally with a URL), writes a
//! stderr line, then either sleeps forever or exits after `--exit-after`.

use std::io::Write;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    if args.iter().any(|a| a == "--fail") {
        eprintln!("test-sleeper: fatal fixture error");
        std::process::exit(3);
    }

    let url = get("--print-url").unwrap_or_else(|| "http://localhost:4399/".into());
    let pid = std::process::id();
    // Mimic Vite's "Local:" output, including an ANSI color code.
    println!("\x1b[32m➜\x1b[0m  Local:   {url}  (pid {pid})");
    let _ = std::io::stdout().flush();
    eprintln!("test-sleeper: stderr heartbeat");
    let _ = std::io::stderr().flush();

    match get("--exit-after").and_then(|v| v.parse::<u64>().ok()) {
        Some(ms) => {
            std::thread::sleep(Duration::from_millis(ms));
            println!("test-sleeper: done");
            std::process::exit(0);
        }
        None => loop {
            std::thread::sleep(Duration::from_secs(60));
        },
    }
}
