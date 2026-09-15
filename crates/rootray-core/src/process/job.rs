//! Windows Job Object containment — the abnormal-exit backstop.
//!
//! Every dev server RootRay spawns is assigned to a Job Object configured
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The handle lives for the
//! lifetime of the [`super::ProcessManager`]; if the RootRay process dies
//! for any reason — crash, forced kill, power transition — the last handle
//! closes and Windows terminates every member of the job, including
//! descendants (cmd → node → vite grandchildren cannot escape the job
//! unless they are already members of another job, which package-manager
//! shims are not).
//!
//! Graceful `stop()` still uses `taskkill /T`; the job is the guarantee
//! that an *ungraceful* RootRay exit cannot orphan the user's dev server.
//! Unrelated user processes are never touched — only processes RootRay
//! spawned are ever assigned.
//!
//! Non-Windows builds compile a no-op stub; Windows is the MVP target.

#[cfg(windows)]
mod imp {
    use std::mem::zeroed;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// RAII job handle. `Drop` closes the handle — with KILL_ON_JOB_CLOSE
    /// set, that is exactly what terminates every member process.
    pub struct Job {
        handle: HANDLE,
    }

    // HANDLE is a kernel handle value; the job is only ever configured and
    // assigned under the ProcessManager mutex.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Creates an anonymous job with KILL_ON_JOB_CLOSE. `None` means
        /// containment is unavailable — callers must still work (graceful
        /// taskkill remains the fallback).
        pub fn create() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self { handle })
            }
        }

        /// Assigns a running process (by pid) to the job. Returns false when
        /// the process cannot be contained — e.g. it already exited or is
        /// a member of another non-nested job.
        pub fn assign_pid(&self, pid: u32) -> bool {
            unsafe {
                let proc = OpenProcess(
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                    0,
                    pid,
                );
                if proc.is_null() {
                    return false;
                }
                let ok = AssignProcessToJobObject(self.handle, proc);
                CloseHandle(proc);
                ok != 0
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// No-op stub — Windows is the MVP containment target. POSIX lifecycle
    /// keeps the existing TERM-signal behavior.
    pub struct Job;

    impl Job {
        pub fn create() -> Option<Self> {
            None
        }
        pub fn assign_pid(&self, _pid: u32) -> bool {
            false
        }
    }
}

pub use imp::Job;
