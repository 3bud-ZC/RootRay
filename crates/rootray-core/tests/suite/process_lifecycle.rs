//! Lifecycle tests for ProcessManager using the `test-sleeper` fixture
//! binary — a deterministic stand-in for a dev server.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rootray_core::process::{EventSink, ProcessEvent, ProcessManager};
use rootray_core::project::DevCommand;

fn sleeper(args: &[&str]) -> DevCommand {
    DevCommand {
        executable: env!("CARGO_BIN_EXE_test-sleeper").to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        display: format!("test-sleeper {}", args.join(" ")),
        cwd: std::env::temp_dir(),
        env: Vec::new(),
    }
}

/// Records every event so assertions can inspect the full stream.
struct Seen {
    events: Arc<Mutex<Vec<ProcessEvent>>>,
}

fn recorder() -> (Seen, EventSink) {
    let events: Arc<Mutex<Vec<ProcessEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let shared = events.clone();
    let sink: EventSink = Arc::new(move |e| {
        shared.lock().unwrap().push(e);
    });
    (Seen { events }, sink)
}

fn wait_for(
    seen: &Seen,
    pred: impl Fn(&ProcessEvent) -> bool,
    timeout: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if seen.events.lock().unwrap().iter().any(|e| pred(e)) {
            return true;
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

const T: Duration = Duration::from_secs(10);

#[test]
fn spawn_captures_logs_and_url() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    let pid = pm
        .start(&sleeper(&["--print-url", "http://localhost:4399/"]), sink)
        .unwrap();
    assert!(pid > 0);
    assert!(pm.is_running());
    assert_eq!(pm.current_pid(), Some(pid));

    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::Stdout { line } if line.contains("Local:")
    ), T));
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::Stderr { line } if line.contains("heartbeat")
    ), T));
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::UrlDetected { url, .. } if url == "http://localhost:4399/"
    ), T));

    pm.stop().unwrap();
    assert!(!pm.is_running());
    assert!(wait_for(&seen, |e| matches!(e, ProcessEvent::Exited { .. }), T));
}

#[test]
fn url_detected_event_fires() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    pm.start(&sleeper(&["--print-url", "http://127.0.0.1:5555/"]), sink)
        .unwrap();
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::UrlDetected { url, port } if url == "http://127.0.0.1:5555/" && *port == Some(5555)
    ), T));
    pm.stop().unwrap();
}

#[test]
fn clean_exit_is_reported_clean() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    pm.start(&sleeper(&["--exit-after", "150"]), sink).unwrap();
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::Exited { code: Some(0), clean: true }
    ), T));
}

#[test]
fn crash_is_reported_unclean() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    pm.start(&sleeper(&["--fail"]), sink).unwrap();
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::Exited { code: Some(3), clean: false }
    ), T));
    assert!(!pm.is_running());
}

#[test]
fn duplicate_start_is_rejected() {
    let pm = ProcessManager::new();
    let (_seen, sink) = recorder();
    pm.start(&sleeper(&[]), sink.clone()).unwrap();
    let err = pm.start(&sleeper(&[]), sink).unwrap_err();
    assert_eq!(err.code(), "PROCESS_ALREADY_RUNNING");
    pm.stop().unwrap();
}

#[test]
fn stop_without_process_errors() {
    let pm = ProcessManager::new();
    let err = pm.stop().unwrap_err();
    assert_eq!(err.code(), "PROCESS_NOT_RUNNING");
}

#[test]
fn restart_replaces_process() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    let pid1 = pm.start(&sleeper(&[]), sink.clone()).unwrap();
    let pid2 = pm.restart(&sleeper(&[]), sink).unwrap();
    assert_ne!(pid1, pid2);
    assert!(pm.is_running());
    assert!(wait_for(&seen, |e| matches!(e, ProcessEvent::Exited { .. }), T));
    pm.stop().unwrap();
}

#[test]
fn restart_after_failed_start_works() {
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    // First run crashes immediately.
    pm.start(&sleeper(&["--fail"]), sink.clone()).unwrap();
    assert!(wait_for(&seen, |e| matches!(
        e,
        ProcessEvent::Exited { clean: false, .. }
    ), T));
    // Restart must be allowed even though the previous run failed.
    let pid = pm.restart(&sleeper(&[]), sink).unwrap();
    assert!(pm.is_running());
    assert_eq!(pm.current_pid(), Some(pid));
    pm.stop().unwrap();
}

/// `.cmd`/`.bat` shims spawn through `cmd.exe /c`; the dev command's args
/// must reach the shim exactly once — duplicated args turn
/// `npm run dev` into `vite run dev` (Vite then serves `run/` as root).
#[cfg(windows)]
#[test]
fn cmd_shim_args_are_not_duplicated() {
    let dir = tempfile::tempdir().unwrap();
    let bat = dir.path().join("shim.bat");
    std::fs::write(&bat, "@echo %*\r\n").unwrap();
    let cmd = DevCommand {
        executable: bat.to_string_lossy().to_string(),
        args: vec!["alpha".to_string(), "beta".to_string()],
        display: "shim".into(),
        cwd: std::env::temp_dir(),
        env: Vec::new(),
    };
    let pm = ProcessManager::new();
    let (seen, sink) = recorder();
    pm.start(&cmd, sink).unwrap();
    assert!(
        wait_for(
            &seen,
            |e| matches!(e, ProcessEvent::Stdout { line } if line.trim() == "alpha beta"),
            T
        ),
        "shim must receive args exactly once"
    );
    pm.stop().ok();
}

#[test]
fn url_watchdog_times_out() {
    let pm = ProcessManager::new().with_url_timeout(Duration::from_millis(200));
    let (seen, sink) = recorder();
    // A sleeper that prints no URL.
    let cmd = sleeper(&["--print-url", ""]);
    pm.start(&cmd, sink).unwrap();
    assert!(wait_for(&seen, |e| matches!(e, ProcessEvent::UrlTimeout), T));
    assert!(pm.is_running()); // still running — timeout is informational
    pm.stop().unwrap();
}
