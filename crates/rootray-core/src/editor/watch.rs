//! Single-file watcher for the open edit session.
//!
//! Watches the file's *parent directory* non-recursively (watching a file
//! directly is unreliable across save-by-rename editors) and reports only
//! events that touch the open file. Debounced briefly because editors
//! typically emit create+write+rename bursts per save.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// Handle for a running watcher; dropping it stops the thread.
pub struct FileWatcher {
    // Option so Drop can release the watcher (and its channel sender)
    // before joining the thread — otherwise recv() never wakes.
    watcher: Option<RecommendedWatcher>,
    join: Option<JoinHandle<()>>,
}

const DEBOUNCE: Duration = Duration::from_millis(120);

impl FileWatcher {
    /// Watches `file`'s parent dir; calls `on_change` (debounced) whenever
    /// the file's content may have changed. Events stop when dropped.
    pub fn watch(file: &Path, on_change: impl Fn() + Send + 'static) -> Result<Self, notify::Error> {
        let parent = file.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        let target = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());

        let (tx, rx) = channel::<()>();

        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }
            if event.paths.iter().any(|p| same_file(p, &target)) {
                let _ = tx.send(());
            }
        })?;
        watcher.watch(&parent, RecursiveMode::NonRecursive)?;

        let join = std::thread::spawn(move || loop {
            // Wait for the first signal, then drain the debounce window.
            if rx.recv().is_err() {
                return;
            }
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => {
                        on_change();
                        break;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        });

        Ok(Self {
            watcher: Some(watcher),
            join: Some(join),
        })
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        // Dropping the watcher drops the closure's sender → rx.recv()
        // returns Err(Disconnected) → the thread exits → join succeeds.
        drop(self.watcher.take());
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Path equality tolerant of verbatim-prefix / case differences.
fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let s = p.to_string_lossy().to_string();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
        s.replace('/', "\\").to_lowercase()
    };
    norm(a) == norm(b)
}
