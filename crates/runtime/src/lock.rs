//! Per-profile manager lock (milestone 03, step 3): serializes launches and recovery for one profile.
//!
//! An exclusive OS file lock on `<profile>/manager.lock`, held from the start of a launch until the profile is
//! stopped (and during recovery). A second launch request for the same profile, from this or another manager
//! process, cannot acquire it. The lock is released automatically if the manager exits; on restart the manager
//! re-acquires it for every browser it re-attaches to.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

#[derive(Debug)]
pub struct ProfileLock {
    _file: File,
}

impl ProfileLock {
    /// `Ok(None)` if another holder has the lock.
    pub fn try_acquire(profile_root: &Path) -> io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(profile_root.join("manager.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(e)) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_is_refused_until_release() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let first = ProfileLock::try_acquire(dir.path())?;
        assert!(first.is_some());
        assert!(
            ProfileLock::try_acquire(dir.path())?.is_none(),
            "same process, second handle"
        );
        drop(first);
        assert!(ProfileLock::try_acquire(dir.path())?.is_some());
        Ok(())
    }
}
