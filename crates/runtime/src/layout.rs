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
//!
//! On Windows, `canonicalize` returns verbatim paths (`\\?\C:\...`). Chromium and many Windows programs do not
//! handle that form (the suspected cause of the first Windows test failures), so canonical paths are converted back
//! to the ordinary form whenever that form means exactly the same file ([`simplify_path`]).

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
        let canonical = simplify_path(&path.canonicalize().map_err(|_| LayoutError::BadRoot)?);
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
        let canonical = simplify_path(&dirs.root.canonicalize()?);
        if canonical.parent() != Some(self.canonical.as_path()) {
            return Err(LayoutError::Escape);
        }
        Ok(())
    }

    /// First step of a permanent deletion: moves `<root>/<id>` to `<root>/.deleting-<id>` (same volume, atomic),
    /// so no launch can find the directory any more. Returns the new path, or `None` if there was no directory.
    /// The caller has verified that no process uses the profile and does not hold its lock (Windows cannot rename a
    /// directory containing an open file).
    pub fn retire(&self, id: &ProfileId) -> Result<Option<PathBuf>, LayoutError> {
        let dirs = self.dirs(id);
        if !dirs.root.exists() {
            return Ok(None);
        }
        self.verify(&dirs)?;
        let target = self.canonical.join(format!(".deleting-{}", id.as_str()));
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&dirs.root, &target)?;
        Ok(Some(target))
    }

    /// Removes directories left by deletions that were interrupted (run at start-up and after each deletion).
    pub fn purge_retired(&self) -> std::io::Result<usize> {
        let mut removed = 0;
        for entry in std::fs::read_dir(&self.canonical)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".deleting-prf_") && entry.file_type()?.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
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

/// Converts a Windows verbatim path (`\\?\C:\dir`, `\\?\UNC\server\share\dir`) to its ordinary form when
/// the ordinary form names the same file: shorter than `MAX_PATH`, and no component that Windows would reinterpret
/// (reserved device names, trailing dots or spaces). Anything else is returned unchanged. No-op on other platforms.
pub fn simplify_path(path: &Path) -> PathBuf {
    if cfg!(windows)
        && let Some(simple) = path.to_str().and_then(simplify_verbatim)
    {
        return PathBuf::from(simple);
    }
    path.to_path_buf()
}

fn simplify_verbatim(s: &str) -> Option<String> {
    let rest = s.strip_prefix(r"\\?\")?;
    let (prefix_len, simple) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        (2, format!(r"\\{unc}"))
    } else {
        let b = rest.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return None;
        }
        (3, rest.to_owned())
    };
    if simple.len() >= 260 || simple.contains('/') {
        return None;
    }
    let reserved = |name: &str| {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
    };
    let ok = simple[prefix_len..]
        .split('\\')
        .filter(|c| !c.is_empty())
        .all(|c| c != "." && c != ".." && !c.ends_with('.') && !c.ends_with(' ') && !reserved(c));
    ok.then_some(simple)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_windows_paths_are_simplified_only_when_equivalent() {
        assert_eq!(
            simplify_verbatim(r"\\?\C:\Users\me\AppData\profiles").as_deref(),
            Some(r"C:\Users\me\AppData\profiles")
        );
        assert_eq!(
            simplify_verbatim(r"\\?\UNC\server\share\dir").as_deref(),
            Some(r"\\server\share\dir")
        );
        for unchanged in [
            r"C:\already\simple",
            r"\\?\C:\dir\nul",
            r"\\?\C:\dir\com1.txt",
            r"\\?\C:\trailing.\x",
            r"\\?\C:\trailing \x",
            r"\\?\Volume{0b1e}\x",
        ] {
            assert_eq!(simplify_verbatim(unchanged), None, "{unchanged}");
        }
        let long = format!(r"\\?\C:\{}", "a\\".repeat(200));
        assert_eq!(simplify_verbatim(&long), None);
        if !cfg!(windows) {
            assert_eq!(
                simplify_path(Path::new(r"\\?\C:\x")),
                PathBuf::from(r"\\?\C:\x")
            );
        }
    }

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

    #[test]
    fn retire_moves_the_directory_aside_and_purge_removes_it() -> Result<(), LayoutError> {
        let tmp = tempfile::tempdir()?;
        let root = ProfilesRoot::open(tmp.path())?;
        let dirs = root.ensure(&id())?;
        std::fs::write(dirs.user_data.join("Cookies"), b"x")?;
        let retired = root.retire(&id())?.ok_or(LayoutError::Escape)?;
        assert!(!dirs.root.exists() && retired.join("user-data/Cookies").is_file());
        assert_eq!(root.retire(&id())?, None, "nothing left to retire");
        assert_eq!(root.purge_retired()?, 1);
        assert!(!retired.exists());
        Ok(())
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
