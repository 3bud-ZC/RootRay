//! Managed dev-server lifecycle.
//!
//! Owns spawned processes: captures stdout/stderr line-by-line, detects the
//! loopback URL, tracks the PID, kills the whole process tree on Windows,
//! and reports every lifecycle change as a typed [`ProcessEvent`].
//!
//! The frontend never gets a generic shell — it only ever sees the narrow
//! commands in `src-tauri`, which delegate here.

pub mod job;
pub mod url_detect;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::error::{CoreError, CoreResult};
use crate::project::DevCommand;

/// Events emitted for a running dev server. Serialized to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProcessEvent {
    Stdout { line: String },
    Stderr { line: String },
    UrlDetected { url: String, port: Option<u16> },
    /// The URL watchdog fired — server runs but printed no local URL in time.
    UrlTimeout,
    /// `clean` = exit code 0, or an intentional stop.
    Exited { code: Option<i32>, clean: bool },
    StartFailed { message: String },
}

/// Callback the host layer registers to observe a run.
pub type EventSink = Arc<dyn Fn(ProcessEvent) + Send + Sync>;

struct Running {
    pid: u32,
    /// Set when `stop()` was requested — the eventual exit is then "clean".
    stopping: AtomicBool,
    /// Set once a loopback URL has been seen in the output.
    url_seen: AtomicBool,
    /// Set when the waiter thread observes process exit.
    exited: AtomicBool,
}

/// Spawns, supervises and kills dev servers. At most one child at a time.
///
/// Every spawned process is assigned to a Windows Job Object with
/// KILL_ON_JOB_CLOSE (see [`job`]). Graceful stop still goes through
/// `taskkill /T`; the job guarantees that an abnormal RootRay exit —
/// crash, force-kill — cannot orphan the dev-server tree.
pub struct ProcessManager {
    running: Mutex<Option<Arc<Running>>>,
    /// How long to wait for a loopback URL before emitting `UrlTimeout`.
    url_timeout: Duration,
    /// Containment for spawned dev servers. `None` = unavailable (job
    /// creation failed or non-Windows) — lifecycle still works, the
    /// abnormal-exit guarantee is just absent.
    containment: Option<job::Job>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            url_timeout: Duration::from_secs(60),
            containment: job::Job::create(),
        }
    }

    /// Test hook: shorten the URL watchdog.
    pub fn with_url_timeout(mut self, timeout: Duration) -> Self {
        self.url_timeout = timeout;
        self
    }

    pub fn is_running(&self) -> bool {
        self.running
            .lock()
            .map(|g| g.as_ref().is_some_and(|r| !r.exited.load(Ordering::SeqCst)))
            .unwrap_or(false)
    }

    pub fn current_pid(&self) -> Option<u32> {
        self.running.lock().ok()?.as_ref().map(|r| r.pid)
    }

    /// Spawns the dev command. Errors on duplicate starts.
    /// `sink` receives every subsequent [`ProcessEvent`].
    pub fn start(&self, cmd: &DevCommand, sink: EventSink) -> CoreResult<u32> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| CoreError::Internal("process lock poisoned".into()))?;
        if guard.as_ref().is_some_and(|r| !r.exited.load(Ordering::SeqCst)) {
            return Err(CoreError::ProcessAlreadyRunning);
        }

        let mut command = build_command(cmd);
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                sink(ProcessEvent::StartFailed { message: e.to_string() });
                return Err(CoreError::ProcessStartFailed(format!(
                    "{}: {e}",
                    cmd.display
                )));
            }
        };
        let pid = child.id();

        // Job containment is best-effort — failure (already in another job,
        // exotic sandbox) must never block a normal run; taskkill still
        // covers the graceful path and the UI is told honestly.
        if let Some(job) = &self.containment {
            if !job.assign_pid(pid) {
                sink(ProcessEvent::Stderr {
                    line: "[rootray] process could not be added to the containment job; abnormal-exit cleanup is unavailable for this run".into(),
                });
            }
        }

        let running = Arc::new(Running {
            pid,
            stopping: AtomicBool::new(false),
            url_seen: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        });

        // stdout reader
        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, LogKind::Stdout, running.clone(), sink.clone());
        }
        // stderr reader
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, LogKind::Stderr, running.clone(), sink.clone());
        }
        // waiter: reports exit, distinguishes clean stop from crash
        {
            let running = running.clone();
            let sink = sink.clone();
            thread::spawn(move || {
                let status = child.wait();
                running.exited.store(true, Ordering::SeqCst);
                let (code, clean) = match status {
                    Ok(s) => (s.code(), s.success() || running.stopping.load(Ordering::SeqCst)),
                    Err(_) => (None, running.stopping.load(Ordering::SeqCst)),
                };
                sink(ProcessEvent::Exited { code, clean });
            });
        }
        // URL watchdog
        {
            let running = running.clone();
            let timeout = self.url_timeout;
            thread::spawn(move || {
                thread::sleep(timeout);
                if !running.url_seen.load(Ordering::SeqCst)
                    && !running.exited.load(Ordering::SeqCst)
                {
                    sink(ProcessEvent::UrlTimeout);
                }
            });
        }

        *guard = Some(running);
        Ok(pid)
    }

    /// Terminates the process tree. Blocks until exit is observed or a
    /// grace period expires.
    pub fn stop(&self) -> CoreResult<()> {
        let running = {
            let guard = self
                .running
                .lock()
                .map_err(|_| CoreError::Internal("process lock poisoned".into()))?;
            match guard.as_ref() {
                Some(r) if !r.exited.load(Ordering::SeqCst) => r.clone(),
                _ => return Err(CoreError::ProcessNotRunning),
            }
        };
        running.stopping.store(true, Ordering::SeqCst);
        kill_process_tree(running.pid)?;

        // Wait for the waiter thread to flag the exit (bounded).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !running.exited.load(Ordering::SeqCst) {
            if std::time::Instant::now() > deadline {
                return Err(CoreError::Internal(
                    "process did not exit within grace period".into(),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    /// Stops (if running) then starts again with the same command.
    /// Safe to call after a failed startup — the dead handle is replaced.
    pub fn restart(&self, cmd: &DevCommand, sink: EventSink) -> CoreResult<u32> {
        if self.is_running() {
            self.stop()?;
        }
        self.start(cmd, sink)
    }
}

#[derive(Clone, Copy)]
enum LogKind {
    Stdout,
    Stderr,
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    reader: R,
    kind: LogKind,
    running: Arc<Running>,
    sink: EventSink,
) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            let Ok(line) = line else { break };
            if running.exited.load(Ordering::SeqCst) {
                // Keep draining briefly? Exit is imminent; still forward —
                // last lines often carry the crash reason.
            }
            match kind {
                LogKind::Stdout => sink(ProcessEvent::Stdout { line: line.clone() }),
                LogKind::Stderr => sink(ProcessEvent::Stderr { line: line.clone() }),
            }
            if !running.url_seen.load(Ordering::SeqCst) {
                if let Some(found) = url_detect::detect_local_url(&line) {
                    running.url_seen.store(true, Ordering::SeqCst);
                    sink(ProcessEvent::UrlDetected { url: found.url, port: found.port });
                }
            }
        }
    });
}

/// Builds a `Command` for the dev command.
///
/// On Windows, `.cmd`/`.bat` shims (which is what `npm`, `pnpm`, `yarn`
/// resolve to) must run through `cmd.exe` — CreateProcess cannot execute
/// batch files directly. Args stay an array; nothing is interpolated into
/// a shell string beyond joining for `cmd /c`.
fn build_command(cmd: &DevCommand) -> Command {
    #[cfg(windows)]
    {
        let lower = cmd.executable.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new("cmd");
            // `/s` makes cmd treat the whole remainder literally; Rust adds
            // quoting only where the executable path itself needs it.
            c.arg("/d").arg("/s").arg("/c").arg(&cmd.executable).args(&cmd.args);
            return configure(c, cmd);
        }
        return configure(Command::new(&cmd.executable), cmd);
    }
    #[cfg(not(windows))]
    {
        configure(Command::new(&cmd.executable), cmd)
    }
}

fn configure(mut c: Command, cmd: &DevCommand) -> Command {
    c.args(&cmd.args)
        .envs(cmd.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&cmd.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // New console-less process group so `taskkill /T` has a clean tree.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    c
}

/// Kills a PID and all its descendants.
/// Windows: `taskkill /T` walks the tree — required because `npm run dev`
/// spawns cmd → node → vite grandchildren.
fn kill_process_tree(pid: u32) -> CoreResult<()> {
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(CoreError::Internal(format!("taskkill exited with {s}"))),
            Err(e) => Err(CoreError::Internal(format!("taskkill failed: {e}"))),
        }
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(CoreError::Internal(format!("kill exited with {s}"))),
            Err(e) => Err(CoreError::Internal(format!("kill failed: {e}"))),
        }
    }
}
