//! Last known-good local copy of a profile, evidence preservation and restore (milestone 03, steps 5–6).
//!
//! Rules:
//!  - Copies are taken only of a STOPPED profile whose browser processes have all exited (the caller checks this
//!    with the process table and holds the profile lock). Live browser databases are never copied.
//!  - Caches, crash dumps and Chromium's lock files are excluded; symbolic links are never followed.
//!  - A new copy replaces the previous one only after it is complete (write to `tmp-*`, then rename), so a crash or
//!    full disk during a backup never destroys the last good copy.
//!  - Restoring never writes into the backup: the current directory is moved aside as evidence first, then the
//!    backup is copied into a fresh directory.
//!
//! ```text
//! <data>/backups/<profile id>/last-good/backup.json
//!                                      /user-data/...
//! <data>/evidence/<profile id>/<unix time>-<reason>/user-data/...   (kept: newest 3)
//! ```

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Directory names excluded from copies (regenerable caches, crash dumps, model downloads).
pub const EXCLUDED_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Crashpad",
    "Crash Reports",
    "BrowserMetrics",
    "component_crx_cache",
    "optimization_guide_model_store",
    "Safe Browsing",
];
/// File names excluded from copies (Chromium's process singleton and lock files).
pub const EXCLUDED_FILES: &[&str] = &[
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "lockfile",
    "BrowserMetrics-spare.pma",
];
const KEEP_EVIDENCE: usize = 3;
pub const BACKUP_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("there is no backup for this profile")]
    NoBackup,
    #[error("not enough disk space: {required} bytes required, {available} available")]
    LowDisk { required: u64, available: u64 },
    #[error("the backup was cancelled")]
    Cancelled,
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
}

impl BackupError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoBackup => "NO_BACKUP",
            Self::LowDisk { .. } => "LOW_DISK_SPACE",
            Self::Cancelled => "BACKUP_CANCELLED",
            Self::Io(_) => "BACKUP_IO_ERROR",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupInfo {
    pub created_at_unix: u64,
    pub runtime_version: Option<String>,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CopyStats {
    pub bytes: u64,
    pub files: u64,
    pub skipped_links: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn excluded(name: &str, is_dir: bool) -> bool {
    if is_dir {
        EXCLUDED_DIRS.contains(&name)
    } else {
        EXCLUDED_FILES.contains(&name) || name.ends_with(".pb-tmp")
    }
}

/// Size of what [`copy_tree`] would copy.
pub fn measure(src: &Path) -> io::Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() && !excluded(&name, true) {
            total += measure(&entry.path())?;
        } else if ft.is_file() && !excluded(&name, false) {
            total += entry.metadata()?.len();
        }
    }
    Ok(total)
}

/// Copies a user-data directory, excluding caches/lock files and never following links.
pub fn copy_tree(src: &Path, dst: &Path) -> io::Result<CopyStats> {
    copy_tree_cancellable(src, dst, None)
}

/// [`copy_tree`] that stops with [`io::ErrorKind::Interrupted`] once `cancel` is set (checked before each entry).
pub fn copy_tree_cancellable(
    src: &Path,
    dst: &Path,
    cancel: Option<&AtomicBool>,
) -> io::Result<CopyStats> {
    let mut stats = CopyStats::default();
    copy_into(src, dst, &mut stats, cancel)?;
    Ok(stats)
}

fn copy_into(
    src: &Path,
    dst: &Path,
    stats: &mut CopyStats,
    cancel: Option<&AtomicBool>,
) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if ft.is_symlink() {
            stats.skipped_links += 1;
        } else if ft.is_dir() {
            if !excluded(&name_s, true) {
                copy_into(&entry.path(), &dst.join(&name), stats, cancel)?;
            }
        } else if ft.is_file() && !excluded(&name_s, false) {
            stats.bytes += fs::copy(entry.path(), dst.join(&name))?;
            stats.files += 1;
        }
    }
    Ok(())
}

pub struct Backups {
    /// `<data>/backups`
    pub root: PathBuf,
    /// `<data>/evidence`
    pub evidence: PathBuf,
}

impl Backups {
    fn profile_dir(&self, profile: &str) -> PathBuf {
        self.root.join(profile)
    }

    pub fn last_good(&self, profile: &str) -> Option<BackupInfo> {
        let dir = self.profile_dir(profile).join("last-good");
        let info: BackupInfo =
            serde_json::from_slice(&fs::read(dir.join("backup.json")).ok()?).ok()?;
        dir.join("user-data").is_dir().then_some(info)
    }

    /// Finishes or rolls back a backup interrupted by a crash (run at start-up).
    pub fn tidy(&self, profile: &str) -> io::Result<()> {
        let dir = self.profile_dir(profile);
        if !dir.is_dir() {
            return Ok(());
        }
        let mut olds = vec![];
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("tmp-") {
                fs::remove_dir_all(entry.path())?;
            } else if name.starts_with("old-") {
                olds.push(entry.path());
            }
        }
        olds.sort();
        let last_good = dir.join("last-good");
        if !last_good.exists()
            && let Some(newest) = olds.pop()
        {
            fs::rename(newest, &last_good)?;
        }
        for old in olds {
            fs::remove_dir_all(old)?;
        }
        Ok(())
    }

    /// Takes a new last-good copy of a stopped, quiesced profile. Setting `cancel` abandons the copy (the previous
    /// last-good copy stays in place) so that, for example, a launch request never waits for a routine backup.
    pub fn create(
        &self,
        profile: &str,
        user_data: &Path,
        runtime_version: Option<&str>,
        free_space: &dyn Fn(&Path) -> io::Result<u64>,
        cancel: Option<&AtomicBool>,
    ) -> Result<BackupInfo, BackupError> {
        let dir = self.profile_dir(profile);
        fs::create_dir_all(&dir)?;
        self.tidy(profile)?;
        let needed = measure(user_data)?;
        let required = needed.saturating_add(BACKUP_HEADROOM_BYTES);
        let available = free_space(&dir)?;
        if available < required {
            return Err(BackupError::LowDisk {
                required,
                available,
            });
        }
        let tmp = dir.join(format!("tmp-{}", now_unix()));
        let stats = match copy_tree_cancellable(user_data, &tmp.join("user-data"), cancel) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_dir_all(&tmp);
                return Err(if e.kind() == io::ErrorKind::Interrupted {
                    BackupError::Cancelled
                } else {
                    e.into()
                });
            }
        };
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            let _ = fs::remove_dir_all(&tmp);
            return Err(BackupError::Cancelled);
        }
        let info = BackupInfo {
            created_at_unix: now_unix(),
            runtime_version: runtime_version.map(str::to_owned),
            bytes: stats.bytes,
            files: stats.files,
        };
        fs::write(
            tmp.join("backup.json"),
            serde_json::to_vec_pretty(&info).map_err(io::Error::other)?,
        )?;
        let last_good = dir.join("last-good");
        let old = dir.join(format!("old-{}", now_unix()));
        if last_good.exists() {
            fs::rename(&last_good, &old)?;
        }
        fs::rename(&tmp, &last_good)?;
        if old.exists() {
            fs::remove_dir_all(old)?;
        }
        Ok(info)
    }

    /// Moves the profile's current data aside as evidence (never deletes it).
    pub fn preserve_evidence(
        &self,
        profile: &str,
        user_data: &Path,
        reason: &str,
    ) -> io::Result<PathBuf> {
        let dir = self.evidence.join(profile);
        fs::create_dir_all(&dir)?;
        let target = dir.join(format!("{}-{reason}", now_unix()));
        fs::create_dir_all(&target)?;
        if user_data.exists() {
            fs::rename(user_data, target.join("user-data"))?;
        }
        self.prune_evidence(profile)?;
        Ok(target)
    }

    fn prune_evidence(&self, profile: &str) -> io::Result<()> {
        let dir = self.evidence.join(profile);
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        entries.sort();
        while entries.len() > KEEP_EVIDENCE {
            let oldest = entries.remove(0);
            fs::remove_dir_all(oldest)?;
        }
        Ok(())
    }

    pub fn evidence_count(&self, profile: &str) -> usize {
        fs::read_dir(self.evidence.join(profile))
            .map(|r| r.filter_map(Result::ok).count())
            .unwrap_or(0)
    }

    /// Restores the last good copy into a fresh `user_data` directory. The current directory becomes evidence.
    pub fn restore(
        &self,
        profile: &str,
        user_data: &Path,
        free_space: &dyn Fn(&Path) -> io::Result<u64>,
    ) -> Result<PathBuf, BackupError> {
        let source = self.profile_dir(profile).join("last-good");
        if self.last_good(profile).is_none() {
            return Err(BackupError::NoBackup);
        }
        let needed = measure(&source.join("user-data"))?;
        let required = needed.saturating_add(BACKUP_HEADROOM_BYTES);
        let available = free_space(&self.root)?;
        if available < required {
            return Err(BackupError::LowDisk {
                required,
                available,
            });
        }
        let parent = user_data
            .parent()
            .ok_or_else(|| io::Error::other("no parent"))?;
        let staging = parent.join("user-data.restoring");
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        copy_tree(&source.join("user-data"), &staging)?;
        let evidence = self.preserve_evidence(profile, user_data, "restore")?;
        fs::rename(&staging, user_data)?;
        Ok(evidence)
    }

    /// Empties the profile's browser data, keeping the old data as evidence.
    pub fn start_fresh(&self, profile: &str, user_data: &Path) -> io::Result<PathBuf> {
        let evidence = self.preserve_evidence(profile, user_data, "fresh")?;
        fs::create_dir_all(user_data)?;
        Ok(evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLENTY: &dyn Fn(&Path) -> io::Result<u64> = &|_| Ok(u64::MAX / 4);

    fn sample(user_data: &Path) -> io::Result<()> {
        fs::create_dir_all(user_data.join("Default/Local Storage/leveldb"))?;
        fs::create_dir_all(user_data.join("Default/Cache/Cache_Data"))?;
        fs::write(user_data.join("Default/Cookies"), b"cookie-db")?;
        fs::write(
            user_data.join("Default/Local Storage/leveldb/000003.log"),
            b"ls",
        )?;
        fs::write(
            user_data.join("Default/Cache/Cache_Data/f_0001"),
            vec![0u8; 4096],
        )?;
        fs::write(user_data.join("Local State"), b"{}")?;
        fs::write(user_data.join("lockfile"), b"")?;
        Ok(())
    }

    fn setup() -> io::Result<(tempfile::TempDir, Backups, PathBuf)> {
        let tmp = tempfile::tempdir()?;
        let user_data = tmp.path().join("profiles/prf_X/user-data");
        sample(&user_data)?;
        let backups = Backups {
            root: tmp.path().join("backups"),
            evidence: tmp.path().join("evidence"),
        };
        Ok((tmp, backups, user_data))
    }

    #[test]
    fn backup_excludes_caches_and_locks() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        let info = b.create("prf_X", &ud, Some("155.0.0.1"), PLENTY, None)?;
        let copy = b.root.join("prf_X/last-good/user-data");
        assert!(copy.join("Default/Cookies").is_file());
        assert!(
            copy.join("Default/Local Storage/leveldb/000003.log")
                .is_file()
        );
        assert!(!copy.join("Default/Cache").exists());
        assert!(!copy.join("lockfile").exists());
        assert_eq!(info.files, 3);
        assert_eq!(b.last_good("prf_X"), Some(info));
        Ok(())
    }

    #[test]
    fn low_disk_keeps_the_previous_backup() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        let first = b.create("prf_X", &ud, None, PLENTY, None)?;
        let err = b.create("prf_X", &ud, None, &|_| Ok(1024), None);
        assert!(matches!(err, Err(BackupError::LowDisk { .. })));
        assert_eq!(b.last_good("prf_X"), Some(first));
        Ok(())
    }

    #[test]
    fn a_cancelled_backup_keeps_the_previous_copy() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        let first = b.create("prf_X", &ud, None, PLENTY, None)?;
        let cancel = AtomicBool::new(true);
        let err = b.create("prf_X", &ud, None, PLENTY, Some(&cancel));
        assert!(matches!(err, Err(BackupError::Cancelled)));
        assert_eq!(b.last_good("prf_X"), Some(first));
        let leftovers = fs::read_dir(b.root.join("prf_X"))?
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("tmp-"))
            .count();
        assert_eq!(leftovers, 0, "no partial copy left behind");
        Ok(())
    }

    #[test]
    fn an_interrupted_backup_is_rolled_back_at_startup() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        b.create("prf_X", &ud, None, PLENTY, None)?;
        let dir = b.root.join("prf_X");
        // Crash between "move old aside" and "publish new": only old-* and tmp-* exist.
        fs::rename(dir.join("last-good"), dir.join("old-1"))?;
        fs::create_dir_all(dir.join("tmp-2/user-data"))?;
        b.tidy("prf_X")?;
        assert!(b.last_good("prf_X").is_some());
        assert!(!dir.join("tmp-2").exists() && !dir.join("old-1").exists());
        Ok(())
    }

    #[test]
    fn restore_preserves_evidence_and_never_touches_the_backup() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        b.create("prf_X", &ud, None, PLENTY, None)?;
        // The profile is damaged after the backup.
        fs::write(ud.join("Default/Preferences"), b"{garbage")?;
        fs::remove_file(ud.join("Default/Cookies"))?;
        let evidence = b.restore("prf_X", &ud, PLENTY)?;
        assert!(ud.join("Default/Cookies").is_file(), "restored");
        assert!(!ud.join("Default/Preferences").exists());
        assert_eq!(
            fs::read(evidence.join("user-data/Default/Preferences"))?,
            b"{garbage",
            "damaged data kept as evidence"
        );
        assert!(
            b.root
                .join("prf_X/last-good/user-data/Default/Cookies")
                .is_file(),
            "backup unchanged"
        );
        Ok(())
    }

    #[test]
    fn start_fresh_and_evidence_retention() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        assert!(matches!(
            b.restore("prf_X", &ud, PLENTY),
            Err(BackupError::NoBackup)
        ));
        for i in 0..5 {
            fs::write(ud.join(format!("marker-{i}")), b"x")?;
            let dir = b.evidence.join("prf_X");
            fs::create_dir_all(&dir)?;
            // distinct names even within the same second
            fs::create_dir_all(dir.join(format!("0-{i}")))?;
        }
        b.start_fresh("prf_X", &ud)?;
        assert!(ud.is_dir() && fs::read_dir(&ud)?.next().is_none(), "empty");
        assert_eq!(
            b.evidence_count("prf_X"),
            3,
            "only the newest evidence is kept"
        );
        Ok(())
    }
}
