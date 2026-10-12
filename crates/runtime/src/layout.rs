//! On-disk layout for local profiles.
//!
//! ```text
//! <profiles_root>/                 (inside the OS app-data directory, created by the desktop shell)
//!   prf_<26>/
//!     user-data/                  Chromium --user-data-dir for exactly one profile
//!     cache/                      --disk-cache-dir, excluded from snapshots
//! ```
//!
//! The directory name is the validated `ProfileId` and nothing else. After resolution the path is
//! canonicalised and must remain a direct child of the canonical root; symlinks are refused.

use crate::id::ProfileId;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("profiles root must be an absolute, existing directory")]
    BadRoot,
    #[error("profile directory escapes the profiles root")]
    Escape,
    #[error("profile directory is a symbolic link")]
    Symlink,
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Clone, Debug)]
pub struct ProfilesRoot {
    canonical: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileDirs {
    pub root: PathBuf,
    pub user_data: PathBuf,
    pub cache: PathBuf,
}

impl ProfilesRoot {
    pub fn open(path: &Path) -> Result<Self, LayoutError> {
        if !path.is_absolute() {
            return Err(LayoutError::BadRoot);
        }
        let canonical = path.canonicalize().map_err(|_| LayoutError::BadRoot)?;
        if !canonical.is_dir() {
            return Err(LayoutError::BadRoot);
        }
        Ok(Self { canonical })
    }

    pub fn path(&self) -> &Path {
        &self.canonical
    }

    /// Resolves (without creating) the directories for a profile.
    pub fn dirs(&self, id: &ProfileId) -> ProfileDirs {
        let root = self.canonical.join(id.as_str());
        ProfileDirs {
            user_data: root.join("user-data"),
            cache: root.join("cache"),
            root,
        }
    }

    /// Creates the profile directories if needed and verifies containment after creation.
    pub fn ensure(&self, id: &ProfileId) -> Result<ProfileDirs, LayoutError> {
        let dirs = self.dirs(id);
        self.check_not_symlink(&dirs.root)?;
        std::fs::create_dir_all(&dirs.user_data)?;
        std::fs::create_dir_all(&dirs.cache)?;
        self.verify(&dirs)?;
        Ok(dirs)
    }

    /// Verifies an existing profile directory is a real directory directly under the root.
    pub fn verify(&self, dirs: &ProfileDirs) -> Result<(), LayoutError> {
        for p in [&dirs.root, &dirs.user_data, &dirs.cache] {
            self.check_not_symlink(p)?;
        }
        let canonical = dirs.root.canonicalize()?;
        if canonical.parent() != Some(self.canonical.as_path()) {
            return Err(LayoutError::Escape);
        }
        Ok(())
    }

    fn check_not_symlink(&self, p: &Path) -> Result<(), LayoutError> {
        match std::fs::symlink_metadata(p) {
            Ok(meta) if meta.file_type().is_symlink() => Err(LayoutError::Symlink),
            Ok(_) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> ProfileId {
        ProfileId::parse("prf_01J9ZSEED0A010000000000000").unwrap_or_else(|_| panic!("id"))
    }

    #[test]
    fn creates_directories_named_only_by_id() -> Result<(), LayoutError> {
        let tmp = tempfile::tempdir()?;
        let root = ProfilesRoot::open(tmp.path())?;
        let dirs = root.ensure(&id())?;
        assert!(dirs.user_data.is_dir());
        assert_eq!(
            dirs.root.file_name().and_then(|n| n.to_str()),
            Some(id().as_str())
        );
        Ok(())
    }

    #[test]
    fn refuses_relative_root() {
        assert!(matches!(
            ProfilesRoot::open(Path::new("relative/root")),
            Err(LayoutError::BadRoot)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_profile_directory() -> Result<(), LayoutError> {
        let tmp = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        let root = ProfilesRoot::open(tmp.path())?;
        std::os::unix::fs::symlink(outside.path(), tmp.path().join(id().as_str()))?;
        assert!(matches!(root.ensure(&id()), Err(LayoutError::Symlink)));
        Ok(())
    }
}
