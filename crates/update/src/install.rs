//! Runtime install pipeline (milestone 02 failure/security behaviour).
//!
//! Layout under `<app data>/runtimes/`:
//! ```text
//! staging/<version>-<platform>/journal.json      state of an in-flight install (survives a crash)
//! staging/<version>-<platform>/artifact.partial  bytes being copied/downloaded
//! staging/<version>-<platform>/extract/          archive being unpacked
//! quarantine/<version>-<platform>-<unix time>.bin artifacts that failed size/digest verification (never launched)
//! installed/<version>-<platform>/                verified, fully extracted runtime
//! ```
//! Guarantees:
//!  - Free space is checked before downloading AND before extracting; the error states how much is required.
//!  - The digest is verified before anything is extracted; a mismatch quarantines the artifact.
//!  - Extraction refuses absolute paths, `..`, oversized totals and excessive entry counts (zip-slip/bombs).
//!  - Symbolic links are accepted only on macOS/Linux, only with a relative target that stays inside the runtime
//!    (macOS app bundles need them, e.g. `Versions/Current -> A`), and no file is ever written through a link.
//!  - The manifest's executable must exist after extraction; on macOS a `required` code signature is verified.
//!  - The installed directory appears only via an atomic rename after a complete, verified extraction.
//!  - An interrupted install leaves its journal; on next start the manager offers retry or discard.

use crate::{RuntimeArtifact, UpdateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

/// Headroom kept free beyond what an install needs.
pub const SAFETY_MARGIN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
/// An archive may not expand to more than this multiple of its compressed size.
const MAX_EXPANSION: u64 = 12;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("not enough disk space: {required} bytes required, {available} available")]
    InsufficientSpace { required: u64, available: u64 },
    #[error("artifact failed verification and was quarantined")]
    Quarantined { path: PathBuf },
    #[error("archive entry is unsafe: {0}")]
    UnsafeEntry(String),
    #[error("archive is malformed: {0}")]
    BadArchive(String),
    #[error("another install of this runtime is in progress or was interrupted")]
    InProgress,
    #[error("the runtime's executable is missing from the archive")]
    MissingExecutable,
    #[error("the runtime's code signature did not verify")]
    SignatureCheckFailed,
    #[error("download failed: {0}")]
    Download(String),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Manifest(#[from] UpdateError),
}

impl InstallError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InsufficientSpace { .. } => "INSUFFICIENT_DISK_SPACE",
            Self::Quarantined { .. } => "ARTIFACT_QUARANTINED",
            Self::UnsafeEntry(_) => "UNSAFE_ARCHIVE_ENTRY",
            Self::BadArchive(_) => "BAD_ARCHIVE",
            Self::InProgress => "INSTALL_INTERRUPTED",
            Self::MissingExecutable => "RUNTIME_EXECUTABLE_MISSING",
            Self::SignatureCheckFailed => "RUNTIME_SIGNATURE_INVALID",
            Self::Download(_) => "DOWNLOAD_FAILED",
            Self::Io(_) => "IO_ERROR",
            Self::Manifest(_) => "BAD_MANIFEST",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Older journals only (milestone 02 copied local files).
    Copying,
    Downloading,
    Verifying,
    Extracting,
    Finalizing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub version: String,
    pub platform: String,
    pub stage: Stage,
    pub expected_sha256: String,
    pub started_at_unix: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Installed {
    pub version: String,
    pub platform: String,
    pub path: PathBuf,
    /// Absolute path of the browser executable inside `path`.
    pub executable: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Interrupted {
    pub dir: PathBuf,
    pub journal: Option<Journal>,
}

/// Something that yields the artifact bytes: an HTTPS download (`download::HttpsSource`) or a local file.
pub trait ArtifactSource {
    fn open(&self) -> io::Result<Box<dyn Read>>;
}

pub struct LocalFile(pub PathBuf);

impl ArtifactSource for LocalFile {
    fn open(&self) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(File::open(&self.0)?))
    }
}

/// Reports free space for the volume containing a path. Injectable so low-disk behaviour is testable.
pub trait SpaceProbe {
    fn available(&self, path: &Path) -> io::Result<u64>;
}

pub struct FsSpace;

impl SpaceProbe for FsSpace {
    fn available(&self, path: &Path) -> io::Result<u64> {
        fs4::available_space(path)
    }
}

pub struct Installer<'a> {
    pub root: PathBuf,
    pub space: &'a dyn SpaceProbe,
}

fn slug(version: &str, platform: &str) -> Result<String, InstallError> {
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    if ok(version) && ok(platform) {
        Ok(format!("{version}-{platform}"))
    } else {
        Err(InstallError::BadArchive(
            "invalid version or platform".into(),
        ))
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Installer<'_> {
    fn dir(&self, kind: &str) -> PathBuf {
        self.root.join(kind)
    }

    pub fn installed_dir(&self, version: &str, platform: &str) -> Result<PathBuf, InstallError> {
        Ok(self.dir("installed").join(slug(version, platform)?))
    }

    fn require_space(&self, needed: u64) -> Result<(), InstallError> {
        fs::create_dir_all(&self.root)?;
        let available = self.space.available(&self.root)?;
        let required = needed.saturating_add(SAFETY_MARGIN_BYTES);
        if available < required {
            return Err(InstallError::InsufficientSpace {
                required,
                available,
            });
        }
        Ok(())
    }

    fn write_journal(dir: &Path, journal: &Journal) -> io::Result<()> {
        let tmp = dir.join("journal.json.tmp");
        fs::write(&tmp, serde_json::to_vec(journal).map_err(io::Error::other)?)?;
        fs::rename(tmp, dir.join("journal.json"))
    }

    pub fn install(
        &self,
        source: &dyn ArtifactSource,
        artifact: &RuntimeArtifact,
        version: &str,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<Installed, InstallError> {
        let name = slug(version, &artifact.platform)?;
        let staging = self.dir("staging").join(&name);
        if staging.exists() {
            return Err(InstallError::InProgress);
        }
        // Compressed copy + worst-case expansion must fit before we write anything.
        self.require_space(artifact.size_bytes.saturating_mul(2))?;
        fs::create_dir_all(&staging)?;
        let mut journal = Journal {
            version: version.to_owned(),
            platform: artifact.platform.clone(),
            stage: Stage::Downloading,
            expected_sha256: artifact.sha256.clone(),
            started_at_unix: now_unix(),
        };
        Self::write_journal(&staging, &journal)?;

        // 1. Download (or copy) while hashing.
        let partial = staging.join("artifact.partial");
        let mut reader = match source.open() {
            Ok(r) => r,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(InstallError::Download(e.to_string()));
            }
        };
        let mut out = File::create(&partial)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut done = 0u64;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    drop(out);
                    let _ = fs::remove_dir_all(&staging);
                    return Err(InstallError::Download(e.to_string()));
                }
            };
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > artifact.size_bytes {
                break; // larger than declared: stop early, verification below will fail
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            progress(Progress {
                stage: Stage::Downloading,
                done,
                total: artifact.size_bytes,
            });
        }
        out.sync_all()?;
        drop(out);

        // 2. Verify before extracting anything.
        journal.stage = Stage::Verifying;
        Self::write_journal(&staging, &journal)?;
        progress(Progress {
            stage: Stage::Verifying,
            done,
            total: artifact.size_bytes,
        });
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if done != artifact.size_bytes || digest != artifact.sha256 {
            let quarantine = self.dir("quarantine");
            fs::create_dir_all(&quarantine)?;
            let target = quarantine.join(format!("{name}-{}.bin", now_unix()));
            fs::rename(&partial, &target)?;
            fs::remove_dir_all(&staging)?;
            return Err(InstallError::Quarantined { path: target });
        }

        // 3. Extract safely.
        journal.stage = Stage::Extracting;
        Self::write_journal(&staging, &journal)?;
        let extract_dir = staging.join("extract");
        fs::create_dir_all(&extract_dir)?;
        self.extract_zip(&partial, &extract_dir, artifact.size_bytes, progress)?;

        // 4. Check what was extracted, then atomically publish.
        journal.stage = Stage::Finalizing;
        Self::write_journal(&staging, &journal)?;
        let exe_rel = safe_relative(&artifact.executable)?;
        let exe_in_extract = extract_dir.join(&exe_rel);
        if !fs::symlink_metadata(&exe_in_extract).is_ok_and(|m| m.is_file()) {
            let _ = fs::remove_dir_all(&staging);
            return Err(InstallError::MissingExecutable);
        }
        if artifact.macos_codesign.as_deref() == Some("required") && !codesign_ok(&exe_in_extract) {
            let quarantine = self.dir("quarantine");
            fs::create_dir_all(&quarantine)?;
            let target = quarantine.join(format!("{name}-{}.unsigned", now_unix()));
            fs::rename(&extract_dir, &target)?;
            let _ = fs::remove_dir_all(&staging);
            return Err(InstallError::SignatureCheckFailed);
        }
        let installed = self.installed_dir(version, &artifact.platform)?;
        fs::create_dir_all(self.dir("installed"))?;
        if installed.exists() {
            fs::remove_dir_all(&installed)?;
        }
        fs::rename(&extract_dir, &installed)?;
        fs::remove_dir_all(&staging)?;
        progress(Progress {
            stage: Stage::Finalizing,
            done: 1,
            total: 1,
        });
        Ok(Installed {
            version: version.to_owned(),
            platform: artifact.platform.clone(),
            executable: installed.join(exe_rel),
            path: installed,
            sha256: digest,
        })
    }

    fn extract_zip(
        &self,
        archive_path: &Path,
        dest: &Path,
        compressed: u64,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<(), InstallError> {
        let mut archive = zip::ZipArchive::new(File::open(archive_path)?)
            .map_err(|e| InstallError::BadArchive(e.to_string()))?;
        if archive.len() > MAX_ENTRIES {
            return Err(InstallError::BadArchive("too many entries".into()));
        }
        // Validate every entry and the total size BEFORE writing any file.
        let mut total: u64 = 0;
        for i in 0..archive.len() {
            let entry = archive
                .by_index_raw(i)
                .map_err(|e| InstallError::BadArchive(e.to_string()))?;
            let name = entry
                .name()
                .map_err(|e| InstallError::BadArchive(e.to_string()))?
                .into_owned();
            if entry.is_symlink() && !cfg!(unix) {
                return Err(InstallError::UnsafeEntry(format!("symbolic link: {name}")));
            }
            safe_relative(&name)?;
            total = total.saturating_add(entry.size());
        }
        if total > compressed.saturating_mul(MAX_EXPANSION) {
            return Err(InstallError::BadArchive(
                "archive expands beyond the allowed ratio".into(),
            ));
        }
        self.require_space(total)?;

        let mut written = 0u64;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| InstallError::BadArchive(e.to_string()))?;
            let name = entry
                .name()
                .map_err(|e| InstallError::BadArchive(e.to_string()))?
                .into_owned();
            let rel = safe_relative(&name)?;
            let target = dest.join(&rel);
            // Never create or write anything through a symbolic link created by an earlier entry.
            no_symlink_ancestors(dest, &rel)?;
            if entry.is_symlink() {
                let mut link = String::new();
                (&mut entry).take(1025).read_to_string(&mut link)?;
                link_inside(&rel, &link)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                make_symlink(&link, &target)?;
                continue;
            }
            if entry.is_dir() {
                fs::create_dir_all(&target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            if fs::symlink_metadata(&target).is_ok() {
                return Err(InstallError::UnsafeEntry(format!(
                    "duplicate entry: {name}"
                )));
            }
            let mut out = File::create(&target)?;
            let expected = entry.size();
            #[cfg(unix)]
            let mode = entry.unix_mode();
            let copied = io::copy(&mut (&mut entry).take(expected.saturating_add(1)), &mut out)?;
            if copied != expected {
                return Err(InstallError::BadArchive(format!("size mismatch in {name}")));
            }
            #[cfg(unix)]
            if let Some(mode) = mode {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o755))?;
            }
            written += copied;
            progress(Progress {
                stage: Stage::Extracting,
                done: written,
                total,
            });
        }
        Ok(())
    }

    /// Installs left behind by a crash or kill. The UI offers "retry" (discard then reinstall) or "discard".
    pub fn interrupted(&self) -> io::Result<Vec<Interrupted>> {
        let staging = self.dir("staging");
        if !staging.is_dir() {
            return Ok(vec![]);
        }
        let mut out = vec![];
        for entry in fs::read_dir(staging)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let journal = fs::read(entry.path().join("journal.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            out.push(Interrupted {
                dir: entry.path(),
                journal,
            });
        }
        Ok(out)
    }

    /// Removes one interrupted staging directory (only directories directly under `staging/`).
    pub fn discard_interrupted(&self, dir: &Path) -> Result<(), InstallError> {
        let staging = fs::canonicalize(self.dir("staging"))?;
        let target = fs::canonicalize(dir)?;
        if target.parent() != Some(staging.as_path())
            || fs::symlink_metadata(dir)?.file_type().is_symlink()
        {
            return Err(InstallError::UnsafeEntry(
                "not an interrupted install directory".into(),
            ));
        }
        fs::remove_dir_all(target)?;
        Ok(())
    }

    pub fn quarantined(&self) -> io::Result<Vec<PathBuf>> {
        let dir = self.dir("quarantine");
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<PathBuf> = fs::read_dir(dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        out.sort();
        Ok(out)
    }
}

/// Rejects a path if any existing ancestor below `root` is a symbolic link.
fn no_symlink_ancestors(root: &Path, rel: &Path) -> Result<(), InstallError> {
    let mut cur = root.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for c in parts.iter().take(parts.len().saturating_sub(1)) {
        cur.push(c);
        if fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(InstallError::UnsafeEntry(format!(
                "entry below a symbolic link: {}",
                rel.display()
            )));
        }
    }
    Ok(())
}

/// A link target must be relative and, resolved from the link's own directory, stay inside the archive root.
fn link_inside(link_rel: &Path, target: &str) -> Result<(), InstallError> {
    if target.is_empty() || target.len() > 1024 || target.contains('\\') || target.contains('\0') {
        return Err(InstallError::UnsafeEntry(format!("link target: {target}")));
    }
    let mut depth: i64 = link_rel.components().count() as i64 - 1;
    for c in Path::new(target).components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(InstallError::UnsafeEntry(format!(
                        "link escapes the runtime: {target}"
                    )));
                }
            }
            _ => {
                return Err(InstallError::UnsafeEntry(format!(
                    "absolute link: {target}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_symlink(target: &str, at: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(not(unix))]
fn make_symlink(_target: &str, _at: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symbolic links are not accepted on this platform",
    ))
}

/// macOS: verifies the app bundle containing `exe` with `codesign --verify --deep --strict`.
#[cfg(target_os = "macos")]
fn codesign_ok(exe: &Path) -> bool {
    let Some(app) = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
    else {
        return false;
    };
    std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(target_os = "macos"))]
fn codesign_ok(_exe: &Path) -> bool {
    true // code signatures are a macOS bundle concept; Windows/Linux rely on the pinned digest
}

/// Accepts only plain relative paths made of normal components.
fn safe_relative(name: &str) -> Result<PathBuf, InstallError> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') || name.len() > 1024 {
        return Err(InstallError::UnsafeEntry(name.to_owned()));
    }
    let path = Path::new(name);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(InstallError::UnsafeEntry(name.to_owned())),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(InstallError::UnsafeEntry(name.to_owned()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
