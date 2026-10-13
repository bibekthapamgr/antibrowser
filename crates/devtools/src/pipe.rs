//! The browser's DevTools protocol over a protected pipe (milestone 10, ADR-0017).
//!
//! Chromium's `--remote-debugging-pipe` reads commands from one pipe and writes answers to another. Only the process
//! holding the other ends — this app — can talk to it: there is no port for other programs, websites or other users
//! of the computer to connect to. (`--remote-debugging-port` is never used.)
//!
//! - Linux and macOS: the browser expects its ends as descriptors 3 (read) and 4 (write).
//! - Windows: the ends are inheritable pipe handles named on the command line with `--remote-debugging-io-pipes`
//!   (`<read>,<write>`); this app's ends are not inheritable.
//!
//! This is the only module of the workspace that uses `unsafe` (descriptor duplication in the child before `exec`,
//! and Win32 pipe creation). Each block states why it is sound.
#![allow(unsafe_code)]

use std::fs::File;
use std::io;
use std::process::Command;

/// This app's two ends: write commands to the browser, read its answers.
pub struct PipeEnds {
    pub to_browser: File,
    pub from_browser: File,
}

/// Both pipes, before the browser is started. `attach` gives the browser its ends; after spawning, `into_ends`
/// closes the browser's ends in this process (so a closed browser is seen as end-of-file).
pub struct DevtoolsPipes {
    ours: PipeEnds,
    child: ChildEnds,
}

impl DevtoolsPipes {
    pub fn into_ends(self) -> PipeEnds {
        drop(self.child);
        self.ours
    }
}

// ------------------------------------------------------------------------------------------------- unix
#[cfg(unix)]
struct ChildEnds {
    read: std::os::fd::OwnedFd,
    write: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl DevtoolsPipes {
    pub fn create() -> io::Result<Self> {
        // std creates both pipes with close-on-exec set.
        let (browser_reads, we_write) = io::pipe()?;
        let (we_read, browser_writes) = io::pipe()?;
        Ok(Self {
            ours: PipeEnds {
                to_browser: File::from(std::os::fd::OwnedFd::from(we_write)),
                from_browser: File::from(std::os::fd::OwnedFd::from(we_read)),
            },
            child: ChildEnds {
                read: browser_reads.into(),
                write: browser_writes.into(),
            },
        })
    }

    /// Adds the pipe switch and, in the child just before `exec`, places the browser's ends at descriptors 3 and 4.
    pub fn attach(&self, cmd: &mut Command) {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        cmd.arg("--remote-debugging-pipe");
        let r = self.child.read.as_raw_fd();
        let w = self.child.write.as_raw_fd();
        // SAFETY: the closure runs in the forked child before exec and calls only async-signal-safe functions
        // (fcntl, dup2, close) on descriptors that are open in the parent and therefore in the child. The ends are
        // first copied above 10 so that placing one at 3 or 4 cannot overwrite the other; dup2 clears close-on-exec
        // on the copies at 3 and 4, so exactly these two are inherited by the browser.
        unsafe {
            cmd.pre_exec(move || {
                let r2 = libc::fcntl(r, libc::F_DUPFD_CLOEXEC, 10);
                let w2 = libc::fcntl(w, libc::F_DUPFD_CLOEXEC, 10);
                if r2 < 0 || w2 < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::dup2(r2, 3) < 0 || libc::dup2(w2, 4) < 0 {
                    return Err(io::Error::last_os_error());
                }
                libc::close(r2);
                libc::close(w2);
                Ok(())
            });
        }
    }
}

// ------------------------------------------------------------------------------------------------- windows
#[cfg(windows)]
struct ChildEnds {
    read: std::os::windows::io::OwnedHandle,
    write: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl DevtoolsPipes {
    pub fn create() -> io::Result<Self> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
        use windows_sys::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
        use windows_sys::Win32::System::Pipes::CreatePipe;

        fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
            let mut read: HANDLE = std::ptr::null_mut();
            let mut write: HANDLE = std::ptr::null_mut();
            // SAFETY: both out-pointers point to valid HANDLE slots; no security attributes (not inheritable);
            // the default buffer size. On success both handles are owned by us exactly once.
            let ok = unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreatePipe returned two fresh, valid handles that nothing else owns.
            Ok(unsafe {
                (
                    OwnedHandle::from_raw_handle(read as RawHandle),
                    OwnedHandle::from_raw_handle(write as RawHandle),
                )
            })
        }
        fn inheritable(h: &OwnedHandle) -> io::Result<()> {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the handle is valid and owned by us for the duration of the call.
            let ok = unsafe {
                SetHandleInformation(h.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
            };
            if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
        }

        let (browser_reads, we_write) = pipe()?;
        let (we_read, browser_writes) = pipe()?;
        // Only the browser's ends are inherited (std starts children with handle inheritance on).
        inheritable(&browser_reads)?;
        inheritable(&browser_writes)?;
        Ok(Self {
            ours: PipeEnds {
                to_browser: File::from(we_write),
                from_browser: File::from(we_read),
            },
            child: ChildEnds {
                read: browser_reads,
                write: browser_writes,
            },
        })
    }

    /// Adds the pipe switches naming the browser's inheritable handles (`<read>,<write>`).
    pub fn attach(&self, cmd: &mut Command) {
        use std::os::windows::io::AsRawHandle;
        cmd.arg("--remote-debugging-pipe");
        cmd.arg(format!(
            "--remote-debugging-io-pipes={},{}",
            self.child.read.as_raw_handle() as usize,
            self.child.write.as_raw_handle() as usize
        ));
    }
}
