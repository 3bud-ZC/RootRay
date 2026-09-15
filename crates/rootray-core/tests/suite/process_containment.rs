//! Windows Job Object containment tests.
//!
//! Proves the abnormal-exit guarantee: when the ProcessManager's job handle
//! is closed — which is what the OS does when the RootRay process dies —
//! every member of the job, including descendants, is terminated.
//!
//! Windows-only: the containment mechanism is a Windows API. The no-op
//! stub keeps other platforms compiling.

#![cfg(windows)]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rootray_core::process::job::Job;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const STILL_ACTIVE: i32 = 259;
const T: Duration = Duration::from_secs(15);

fn process_alive(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

fn wait_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !process_alive(pid)
}

fn spawn_sleeper() -> Child {
    Command::new(env!("CARGO_BIN_EXE_test-sleeper"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test-sleeper")
}

#[test]
fn job_close_terminates_member() {
    let mut child = spawn_sleeper();
    let pid = child.id();
    assert!(process_alive(pid));

    let job = Job::create().expect("job creation failed");
    assert!(job.assign_pid(pid), "failed to assign sleeper to job");

    // Simulates abnormal host death: the last job handle closes.
    drop(job);
    assert!(
        wait_dead(pid, T),
        "job member survived KILL_ON_JOB_CLOSE"
    );
    let _ = child.kill();
}

#[test]
fn job_close_terminates_descendants() {
    // cmd.exe runs the sleeper as a grandchild — the exact shape of
    // `pnpm dev` spawning cmd → node → vite.
    let mut cmd = Command::new("cmd")
        .args([
            "/d",
            "/s",
            "/c",
            env!("CARGO_BIN_EXE_test-sleeper"),
            "--print-url",
            "http://localhost:4399/",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn cmd wrapper");
    let cmd_pid = cmd.id();

    // Assign immediately — only descendants created *after* assignment
    // join the job, which is also the production ordering in `start()`.
    let job = Job::create().expect("job creation failed");
    assert!(job.assign_pid(cmd_pid), "failed to assign cmd to job");

    // The sleeper prints its own pid inside "(pid N)" on the ready line.
    // Read it on a channel — a descendant that never prints must not
    // hang the test.
    let stdout = cmd.stdout.take().expect("stdout pipe");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("sleeper ready line");
    let grandchild_pid: u32 = line
        .split("(pid ")
        .nth(1)
        .and_then(|s| s.trim().trim_end_matches(')').parse().ok())
        .unwrap_or_else(|| panic!("no grandchild pid in sleeper output: {line:?}"));
    assert!(process_alive(grandchild_pid));

    drop(job);
    assert!(wait_dead(cmd_pid, T), "job member survived close");
    assert!(
        wait_dead(grandchild_pid, T),
        "grandchild escaped job containment"
    );
    let _ = cmd.kill();
}

#[test]
fn process_manager_drop_terminates_child() {
    use rootray_core::process::ProcessManager;
    use rootray_core::project::DevCommand;

    let pm = ProcessManager::new();
    let cmd = DevCommand {
        executable: env!("CARGO_BIN_EXE_test-sleeper").to_string(),
        args: Vec::new(),
        display: "test-sleeper".into(),
        cwd: std::env::temp_dir(),
        env: Vec::new(),
    };
    let pid = pm.start(&cmd, std::sync::Arc::new(|_| {})).unwrap();
    assert!(process_alive(pid));

    // Dropping the manager is what process teardown looks like — the job
    // handle closes and the OS reaps the whole tree.
    drop(pm);
    assert!(
        wait_dead(pid, T),
        "dev-server child survived ProcessManager teardown"
    );
}

#[test]
fn unrelated_processes_are_never_touched() {
    // A sleeper that is NOT assigned to the job must survive the close.
    let mut outsider = spawn_sleeper();
    let outsider_pid = outsider.id();

    let job = Job::create().expect("job creation failed");
    let mut member = spawn_sleeper();
    let member_pid = member.id();
    assert!(job.assign_pid(member_pid));

    drop(job);
    assert!(wait_dead(member_pid, T));
    assert!(
        process_alive(outsider_pid),
        "unrelated process was killed by job close"
    );

    let _ = outsider.kill();
    let _ = member.kill();
}
