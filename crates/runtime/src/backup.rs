//! Last known-good local copy of a profile, evidence preservation and restore (milestone 03, steps 5–6), sealed
//! with this device's key since milestone 07.
//!
//! Rules:
//!  - Copies are taken only of a STOPPED profile whose browser processes have all exited (the caller checks this
//!    with the process table and holds the profile lock). Live browser databases are never copied.
//!  - Caches, crash dumps and Chromium's lock files are excluded; symbolic links are never followed.
//!  - A new copy replaces the previous one only after it is complete (write to `tmp-*`, then rename), so a crash or
//!    full disk during a backup never destroys the last good copy.
//!  - Restoring never writes into the backup: the current directory is moved aside as evidence first, then the
//!    backup is copied into a fresh directory.
//!  - Milestone 07: with a device key (kept in the OS keychain) the copy is a sealed archive (pb-seal: compressed,
//!    AES-256-GCM, bound to this profile and backup id), opened only into a fresh directory and fully authenticated.
//!    Without a usable keychain the copy stays a plain directory (as before) and says so (`sealed: false`).
//!
//! ```text
//! <data>/backups/<profile id>/last-good/backup.json
//!                                      /user-data.pbseal        (sealed, milestone 07)
//!                                      /user-data/...            (plain: no keychain)
//! <data>/evidence/<profile id>/<unix time>-<reason>/user-data/...   (kept: newest 3)
//! ```

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// The explicit exclusion lists (caches, crash dumps, lock files) are shared with sealed archives.
pub use pb_seal::archive::{EXCLUDED_DIRS, EXCLUDED_FILES};
use pb_seal::{Binding, Kind, Limits, SealError, SealKey};

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
    #[error(
        "this computer's backup key is not available (the keychain was reset or cannot be read)"
    )]
    KeyUnavailable,
    #[error("the backup could not be verified (damaged or modified)")]
    Damaged,
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
}

impl From<SealError> for BackupError {
    fn from(e: SealError) -> Self {
        match e {
            SealError::Io(io) => Self::Io(io),
            SealError::Cancelled => Self::Cancelled,
            SealError::Authentication
            | SealError::HeaderMismatch(_)
            | SealError::UnsupportedFormat
            | SealError::UnsafeArchive(_)
            | SealError::LimitExceeded => Self::Damaged,
            other => Self::Io(io::Error::other(other.to_string())),
        }
    }
}

impl BackupError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoBackup => "NO_BACKUP",
            Self::LowDisk { .. } => "LOW_DISK_SPACE",
            Self::Cancelled => "BACKUP_CANCELLED",
            Self::KeyUnavailable => "BACKUP_KEY_UNAVAILABLE",
            Self::Damaged => "BACKUP_DAMAGED",
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
    /// Sealed with the device key (milestone 07); plain copies from earlier versions or without a keychain: false.
    #[serde(default)]
    pub sealed: bool,
    /// The id bound into the sealed file's header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    /// Fingerprint of the device key that sealed it ([`SealKey::fingerprint`]), so a reset keychain is reported as
    /// "key not available" rather than "damaged".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
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
    pb_seal::archive::is_excluded(name, is_dir)
}

/// Size of what [`copy_tree`] would copy.
pub fn measure(src: &Path) -> io::Result<u64> {
    pb_seal::archive::measure(src)
}

const SEALED_FILE: &str = "user-data.pbseal";

fn local_binding(profile: &str, object_id: &str, key_id: &str) -> Binding {
    Binding {
        kind: Kind::LocalBackup,
        org_id: None,
        profile_id: profile.to_owned(),
        object_id: object_id.to_owned(),
        key_version: format!("device-{key_id}"),
    }
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
    /// This device's backup key, read from the OS keychain once it has been checked. `None`: plain copies (no
    /// usable keychain); the key is never written anywhere else.
    seal_key: RwLock<Option<SealKey>>,
}

impl Backups {
    pub fn new(root: PathBuf, evidence: PathBuf) -> Self {
        Self {
            root,
            evidence,
            seal_key: RwLock::new(None),
        }
    }

    /// Sets (or clears) the device key used for new backups and to open sealed ones.
    pub fn set_seal_key(&self, key: Option<SealKey>) {
        if let Ok(mut k) = self.seal_key.write() {
            *k = key;
        }
    }

    fn seal_key(&self) -> Option<SealKey> {
        self.seal_key.read().ok().and_then(|k| k.clone())
    }

    /// Whether new backups are sealed (a device key is loaded).
    pub fn sealing(&self) -> bool {
        self.seal_key.read().is_ok_and(|k| k.is_some())
    }

    /// Whether this backup can be opened here: plain, or sealed with the loaded device key.
    pub fn openable(&self, info: &BackupInfo) -> bool {
        !info.sealed
            || self
                .seal_key()
                .is_some_and(|k| info.key_id.as_deref() == Some(k.fingerprint().as_str()))
    }

    fn profile_dir(&self, profile: &str) -> PathBuf {
        self.root.join(profile)
    }

    pub fn last_good(&self, profile: &str) -> Option<BackupInfo> {
        let dir = self.profile_dir(profile).join("last-good");
        let info: BackupInfo =
            serde_json::from_slice(&fs::read(dir.join("backup.json")).ok()?).ok()?;
        let present = if info.sealed {
            dir.join(SEALED_FILE).is_file()
        } else {
            dir.join("user-data").is_dir()
        };
        present.then_some(info)
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
        let never = AtomicBool::new(false);
        let cancel_flag = cancel.unwrap_or(&never);
        let (bytes, files, sealed_as) = match self.seal_key() {
            Some(key) => {
                fs::create_dir_all(&tmp)?;
                let mut rnd = [0u8; 6];
                getrandom::fill(&mut rnd).map_err(|_| io::Error::other("randomness"))?;
                let object_id = format!("lb-{}-{}", now_unix(), hex::encode(rnd));
                let key_id = key.fingerprint();
                match pb_seal::seal_profile(
                    user_data,
                    &[],
                    &key,
                    &local_binding(profile, &object_id, &key_id),
                    &tmp.join(SEALED_FILE),
                    cancel_flag,
                    &mut |_| {},
                ) {
                    Ok(o) => (o.stats.bytes, o.stats.files, Some((object_id, key_id))),
                    Err(e) => {
                        let _ = fs::remove_dir_all(&tmp);
                        return Err(e.into());
                    }
                }
            }
            None => match copy_tree_cancellable(user_data, &tmp.join("user-data"), cancel) {
                Ok(s) => (s.bytes, s.files, None),
                Err(e) => {
                    let _ = fs::remove_dir_all(&tmp);
                    return Err(if e.kind() == io::ErrorKind::Interrupted {
                        BackupError::Cancelled
                    } else {
                        e.into()
                    });
                }
            },
        };
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            let _ = fs::remove_dir_all(&tmp);
            return Err(BackupError::Cancelled);
        }
        let info = BackupInfo {
            created_at_unix: now_unix(),
            runtime_version: runtime_version.map(str::to_owned),
            bytes,
            files,
            sealed: sealed_as.is_some(),
            key_id: sealed_as.as_ref().map(|(_, k)| k.clone()),
            object_id: sealed_as.map(|(o, _)| o),
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

    /// Deletes a profile's last-good copy and evidence (permanent profile deletion).
    pub fn remove_profile(&self, profile: &str) -> io::Result<()> {
        for dir in [self.profile_dir(profile), self.evidence.join(profile)] {
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
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
        let info = self.last_good(profile).ok_or(BackupError::NoBackup)?;
        let needed = if info.sealed {
            info.bytes
        } else {
            measure(&source.join("user-data"))?
        };
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
        if info.sealed {
            let key = self.seal_key().ok_or(BackupError::KeyUnavailable)?;
            let object_id = info.object_id.as_deref().ok_or(BackupError::Damaged)?;
            let key_id = info.key_id.as_deref().ok_or(BackupError::Damaged)?;
            if key.fingerprint() != key_id {
                return Err(BackupError::KeyUnavailable);
            }
            let opened = parent.join("user-data.opening");
            if opened.exists() {
                fs::remove_dir_all(&opened)?;
            }
            fs::create_dir_all(&opened)?;
            let limits = Limits {
                max_bytes: info.bytes.saturating_add(1 << 20),
                ..Limits::default()
            };
            if let Err(e) = pb_seal::open_profile(
                &source.join(SEALED_FILE),
                &key,
                &local_binding(profile, object_id, key_id),
                &opened,
                &limits,
                &AtomicBool::new(false),
                &mut |_| {},
            ) {
                let _ = fs::remove_dir_all(&opened);
                return Err(e.into());
            }
            fs::rename(opened.join("user-data"), &staging)?;
            let _ = fs::remove_dir_all(&opened);
        } else {
            copy_tree(&source.join("user-data"), &staging)?;
        }
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
        let backups = Backups::new(tmp.path().join("backups"), tmp.path().join("evidence"));
        Ok((tmp, backups, user_data))
    }

    fn sealed() -> io::Result<(tempfile::TempDir, Backups, PathBuf)> {
        let (t, b, ud) = setup()?;
        b.set_seal_key(Some(SealKey::generate().map_err(io::Error::other)?));
        Ok((t, b, ud))
    }

    #[test]
    fn sealed_backups_round_trip_and_hold_no_readable_profile_data() -> Result<(), BackupError> {
        let (_t, b, ud) = sealed()?;
        let info = b.create("prf_X", &ud, Some("155.0.0.1"), PLENTY, None)?;
        assert!(info.sealed && info.object_id.is_some());
        assert_eq!(info.files, 3);
        let dir = b.root.join("prf_X/last-good");
        assert!(!dir.join("user-data").exists(), "no plain copy");
        let raw = fs::read(dir.join("user-data.pbseal"))?;
        assert!(
            !raw.windows(9).any(|w| w == b"cookie-db"),
            "contents are encrypted"
        );
        assert_eq!(b.last_good("prf_X"), Some(info));
        fs::remove_file(ud.join("Default/Cookies"))?;
        b.restore("prf_X", &ud, PLENTY)?;
        assert_eq!(fs::read(ud.join("Default/Cookies"))?, b"cookie-db");
        assert!(!ud.join("Default/Cache").exists());
        Ok(())
    }

    #[test]
    fn a_sealed_backup_needs_this_devices_key_and_fails_closed_when_modified()
    -> Result<(), BackupError> {
        let (_t, b, ud) = sealed()?;
        let info = b.create("prf_X", &ud, None, PLENTY, None)?;
        assert!(b.openable(&info));
        let file = b.root.join("prf_X/last-good/user-data.pbseal");
        // Another device's key (or a reset keychain): reported as a missing key, not as damage.
        let mine = b.seal_key();
        b.set_seal_key(Some(SealKey::generate().map_err(io::Error::other)?));
        assert!(!b.openable(&info));
        assert!(matches!(
            b.restore("prf_X", &ud, PLENTY),
            Err(BackupError::KeyUnavailable)
        ));
        b.set_seal_key(None);
        assert!(matches!(
            b.restore("prf_X", &ud, PLENTY),
            Err(BackupError::KeyUnavailable)
        ));
        // A key id edited to match another key still cannot open it: the header binds the key id and GCM the key.
        let json = b.root.join("prf_X/last-good/backup.json");
        let original = fs::read_to_string(&json)?;
        let other = SealKey::generate().map_err(io::Error::other)?;
        let edited = original.replace(
            info.key_id.as_deref().unwrap_or_default(),
            &other.fingerprint(),
        );
        fs::write(&json, edited)?;
        b.set_seal_key(Some(other));
        assert!(matches!(
            b.restore("prf_X", &ud, PLENTY),
            Err(BackupError::Damaged)
        ));
        fs::write(&json, original)?;
        b.set_seal_key(mine);
        let mut bytes = fs::read(&file)?;
        let n = bytes.len();
        bytes[n - 3] ^= 0x10;
        fs::write(&file, bytes)?;
        assert!(matches!(
            b.restore("prf_X", &ud, PLENTY),
            Err(BackupError::Damaged)
        ));
        assert!(
            ud.join("Default/Cookies").is_file(),
            "the current profile is untouched"
        );
        assert!(
            !ud.parent()
                .is_some_and(|p| p.join("user-data.opening").exists())
        );
        Ok(())
    }

    #[test]
    fn plain_backups_from_earlier_versions_still_restore() -> Result<(), BackupError> {
        let (_t, b, ud) = setup()?;
        let info = b.create("prf_X", &ud, None, PLENTY, None)?;
        assert!(!info.sealed && b.openable(&info));
        b.set_seal_key(Some(SealKey::generate().map_err(io::Error::other)?));
        fs::remove_file(ud.join("Default/Cookies"))?;
        b.restore("prf_X", &ud, PLENTY)?;
        assert!(ud.join("Default/Cookies").is_file());
        Ok(())
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
