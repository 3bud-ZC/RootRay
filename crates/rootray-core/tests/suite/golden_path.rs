//! Live golden-path check: analyze the real fixture, start its actual
//! Vite dev server, wait for a detected loopback URL, then stop/restart.
//!
//! Requires `node_modules` installed in `fixtures/vite-react-basic`
//! (`npm install`) — run manually with:
//!   cargo test -p rootray-core --test suite golden_path -- --ignored

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rootray_core::process::{EventSink, ProcessEvent};
use rootray_core::state::RuntimePhase;
use rootray_core::AppCore;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vite-react-basic")
}

struct Seen {
    events: Arc<Mutex<Vec<ProcessEvent>>>,
}

fn recorder() -> (Seen, EventSink) {
    let events: Arc<Mutex<Vec<ProcessEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let shared = events.clone();
    let sink: EventSink = Arc::new(move |e| shared.lock().unwrap().push(e));
    (Seen { events }, sink)
}

fn wait_for(seen: &Seen, pred: impl Fn(&ProcessEvent) -> bool, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if seen.events.lock().unwrap().iter().any(|e| pred(e)) {
            return true;
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "requires npm install in fixture; run with --ignored"]
fn golden_path_real_vite_server() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());

    // 1. analyze
    let analysis = core.analyze(&fixture()).unwrap();
    assert!(analysis.supported);
    assert!(analysis.capabilities.can_run);
    assert_eq!(core.state().phase, RuntimePhase::Ready);

    // 2. start — real `npm.cmd run dev` → real Vite
    let (seen, sink) = recorder();
    let pid = core.start_dev_server(sink).unwrap();
    assert_eq!(core.state().phase, RuntimePhase::Running);
    assert_eq!(core.state().pid, Some(pid));

    // 3. Vite's real URL must be detected from its actual stdout
    let got_url = wait_for(
        &seen,
        |e| matches!(e, ProcessEvent::UrlDetected { .. }),
        Duration::from_secs(60),
    );
    assert!(got_url, "no local URL detected within 60s");
    let state = core.state();
    let url = state.url.clone().expect("url in state");
    assert!(url.starts_with("http://"));
    assert!(state.port.is_some());

    // 4. real logs flowed through
    assert!(wait_for(
        &seen,
        |e| matches!(e, ProcessEvent::Stdout { line } if line.contains("Local")),
        Duration::from_secs(5),
    ));

    // 5. stop → clean stopped state, no orphan
    core.stop_dev_server().unwrap();
    assert_eq!(core.state().phase, RuntimePhase::Stopped);
    assert!(!process_alive(pid));

    // 6. restart works and gets a fresh URL
    let (seen2, sink2) = recorder();
    core.restart_dev_server(sink2).unwrap();
    assert_eq!(core.state().phase, RuntimePhase::Running);
    assert!(wait_for(
        &seen2,
        |e| matches!(e, ProcessEvent::UrlDetected { .. }),
        Duration::from_secs(60),
    ));

    core.stop_dev_server().unwrap();
    assert_eq!(core.state().phase, RuntimePhase::Stopped);
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    // tasklist exit code: non-zero/empty output when PID is gone.
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}
