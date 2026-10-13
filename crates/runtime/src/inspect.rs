//! Process inspection used by the manager's supervisor.
//!
//! A tracked browser process is identified by (pid, OS start time, executable name), never by pid alone: after a
//! manager restart or crash the pid may have been reused by an unrelated program, which must never be adopted or
//! signalled.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};

/// One entry of a full process-table snapshot (used to find a profile's browser and its helper processes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcRecord {
    pub pid: u32,
    pub parent: Option<u32>,
    pub start_time: u64,
    pub exe: Option<PathBuf>,
    pub args: Vec<String>,
    /// Resident memory (RSS; the working set on Windows). Shared pages count in every process that maps them.
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    /// Seconds since the Unix epoch, as reported by the OS.
    pub start_time: u64,
    pub exe: Option<PathBuf>,
    pub memory_bytes: u64,
}

pub trait ProcessInspector: Send + Sync {
    /// `None` if no such process is running.
    fn inspect(&self, pid: u32) -> Option<ProcessInfo>;
    /// Ask the process to exit cleanly (SIGTERM on macOS/Linux, WM_CLOSE via taskkill on Windows).
    fn request_exit(&self, pid: u32) -> bool;
    /// Force termination. Only used after a graceful request timed out.
    fn kill(&self, pid: u32) -> bool;
    /// Every process visible to this user, with parent and command line, taken in one refresh.
    fn snapshot(&self) -> Vec<ProcRecord>;

    /// True if `pid` is still the same process we started (start time and executable name agree when known).
    fn is_same(&self, pid: u32, start_time: Option<u64>, exe: Option<&str>) -> bool {
        let Some(info) = self.inspect(pid) else {
            return false;
        };
        if let Some(expected) = start_time
            && expected.abs_diff(info.start_time) > 2
        {
            return false;
        }
        match (
            exe.map(Path::new).and_then(Path::file_name),
            info.exe.as_deref().and_then(Path::file_name),
        ) {
            (Some(expected), Some(actual)) => expected == actual,
            _ => true, // executable unknown on one side (e.g. permissions): fall back to start time only
        }
    }
}

pub struct SystemInspector {
    system: Mutex<System>,
}

impl Default for SystemInspector {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

impl SystemInspector {
    fn refresh(&self, pid: u32) -> Option<std::sync::MutexGuard<'_, System>> {
        let mut sys = self.system.lock().ok()?;
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet),
        );
        Some(sys)
    }
}

impl SystemInspector {
    #[cfg(not(windows))]
    fn sigterm(&self, pid: u32) -> bool {
        let Some(sys) = self.refresh(pid) else {
            return false;
        };
        sys.process(Pid::from_u32(pid))
            .and_then(|p| p.kill_with(Signal::Term))
            .unwrap_or(false)
    }
}

/// Sends the quit Apple event to one running application, identified by pid, via the system's JavaScript for
/// Automation (no shell, the pid is passed as an argument). Returns true if the event was sent.
#[cfg(target_os = "macos")]
fn macos_quit(pid: u32) -> bool {
    const SCRIPT: &str = "function run(argv) { ObjC.import('AppKit'); \
        var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(parseInt(argv[0], 10)); \
        if (app.isNil()) { return 'none'; } return app.terminate ? 'sent' : 'refused'; }";
    std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT, &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "sent")
        .unwrap_or(false)
}

impl ProcessInspector for SystemInspector {
    fn inspect(&self, pid: u32) -> Option<ProcessInfo> {
        let sys = self.refresh(pid)?;
        let p = sys.process(Pid::from_u32(pid))?;
        Some(ProcessInfo {
            pid,
            start_time: p.start_time(),
            exe: p.exe().map(Path::to_path_buf),
            memory_bytes: p.memory(),
        })
    }

    fn request_exit(&self, pid: u32) -> bool {
        #[cfg(windows)]
        {
            // taskkill without /F posts WM_CLOSE to the process's windows: Chromium shuts down and flushes state.
            // Only the browser main process is asked (no /T): its helper processes have no windows, and the browser
            // ends them itself as part of an orderly shutdown.
            let system_root =
                std::env::var_os("SYSTEMROOT").unwrap_or_else(|| "C:\\Windows".into());
            let taskkill = PathBuf::from(system_root)
                .join("System32")
                .join("taskkill.exe");
            std::process::Command::new(taskkill)
                .args(["/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
        #[cfg(target_os = "macos")]
        {
            // The standard "quit" Apple event, sent to this exact process (like Cmd+Q): Chromium closes its windows
            // and flushes cookies and site data. SIGTERM would take Chromium's faster "session ending" path, which
            // can drop the last seconds of cookie writes, so it is only the fallback.
            if macos_quit(pid) {
                return true;
            }
            self.sigterm(pid)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            // Linux (development/CI only): SIGTERM. Chromium treats it as the session ending; cookie writes from
            // the last ~30 seconds may not be flushed.
            self.sigterm(pid)
        }
    }

    fn kill(&self, pid: u32) -> bool {
        let Some(sys) = self.refresh(pid) else {
            return false;
        };
        sys.process(Pid::from_u32(pid))
            .map(|p| p.kill_with(Signal::Kill).unwrap_or_else(|| p.kill()))
            .unwrap_or(false)
    }

    fn snapshot(&self) -> Vec<ProcRecord> {
        let Ok(mut sys) = self.system.lock() else {
            return vec![];
        };
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet),
        );
        sys.processes()
            .iter()
            // On Linux the table also lists threads (tasks) with their process's command line: skip them.
            .filter(|(_, p)| p.thread_kind().is_none())
            .map(|(pid, p)| ProcRecord {
                pid: pid.as_u32(),
                parent: p.parent().map(|pp| pp.as_u32()),
                start_time: p.start_time(),
                exe: p.exe().map(Path::to_path_buf),
                args: p
                    .cmd()
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
                memory_bytes: p.memory(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_the_current_process_and_rejects_mismatches() {
        let inspector = SystemInspector::default();
        let me = std::process::id();
        let info = inspector
            .inspect(me)
            .unwrap_or_else(|| panic!("current process must be visible"));
        assert!(info.start_time > 0);
        assert!(inspector.is_same(me, Some(info.start_time), None));
        assert!(
            !inspector.is_same(me, Some(info.start_time + 3600), None),
            "pid reuse is detected by start time"
        );
        assert!(
            !inspector.is_same(me, None, Some("definitely-not-this-binary")),
            "executable name must match"
        );
        assert!(inspector.inspect(u32::MAX - 7).is_none());
    }
}
