//! The archive inside a sealed file (archive schema 1): a tar stream with GNU headers (long names) holding
//!
//! ```text
//! meta/<name>          small metadata members (snapshot.json, settings.json, backup.json), written first
//! user-data/...        the browser profile directory: regular files and directories only
//! ```
//!
//! Packing (the profile must be closed; the caller checks): the explicit exclusion lists below are skipped at any
//! depth (regenerable caches, crash dumps, Chromium's process-singleton and lock files); symbolic links and special
//! files are never followed or stored; permissions are normalized; a file that changes size while it is read fails
//! the archive instead of storing a torn copy. Downloads are not part of a profile directory (they go to the user's
//! chosen folder), so they are never included.
//!
//! Unpacking writes only into a fresh, empty directory and refuses: absolute paths, `..`, any non-normal path
//! component, names with `:` `\` or NUL, Windows device names, links and special files, duplicate entries, unknown
//! top-level names, oversized metadata, and anything beyond the file-count and byte limits.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::SealError;

/// Directory names excluded at any depth (regenerable caches, crash dumps, model downloads).
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
/// File names excluded at any depth (Chromium's process singleton and lock files, metrics spare file).
pub const EXCLUDED_FILES: &[&str] = &[
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "lockfile",
    "BrowserMetrics-spare.pma",
];
/// File name suffixes excluded (the manager's own temporary files).
pub const EXCLUDED_SUFFIXES: &[&str] = &[".pb-tmp"];

/// Metadata members an archive may carry. `cookies.json` (ADR-0028) holds a workspace profile's own stored website
/// sessions re-keyed for cross-device restore; it is only ever written inside the encrypted container, never to disk.
pub const META_NAMES: &[&str] = &[
    "snapshot.json",
    "settings.json",
    "backup.json",
    "cookies.json",
];
pub const MAX_META_BYTES: u64 = 1 << 20;
const USER_DATA: &str = "user-data";
const META: &str = "meta";
const WINDOWS_DEVICES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn is_excluded(name: &str, is_dir: bool) -> bool {
    if is_dir {
        EXCLUDED_DIRS.contains(&name)
    } else {
        EXCLUDED_FILES.contains(&name) || EXCLUDED_SUFFIXES.iter().any(|s| name.ends_with(s))
    }
}

/// A metadata member (`meta/<name>`).
#[derive(Clone, Copy, Debug)]
pub struct Member<'a> {
    pub name: &'a str,
    pub bytes: &'a [u8],
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackStats {
    pub files: u64,
    pub dirs: u64,
    /// File content bytes (what the user thinks of as the profile's size).
    pub bytes: u64,
    pub skipped_links: u64,
    pub skipped_other: u64,
}

/// Bytes [`pack`] would store from `user_data`.
pub fn measure(user_data: &Path) -> io::Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(user_data)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() && !is_excluded(&name, true) {
            total += measure(&entry.path())?;
        } else if ft.is_file() && !is_excluded(&name, false) {
            total += entry.metadata()?.len();
        }
    }
    Ok(total)
}

fn name_ok(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains([':', '\\', '\0', '/'])
        && !name.ends_with(' ')
        && !name.ends_with('.')
        && !WINDOWS_DEVICES.contains(&stem)
}

/// Reads exactly `remaining` bytes; a shorter file means it changed while being archived.
struct Exact<'a, R: Read> {
    inner: io::Take<R>,
    remaining: u64,
    cancel: &'a AtomicBool,
}

impl<R: Read> Read for Exact<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                SealError::Cancelled,
            ));
        }
        let n = self.inner.read(buf)?;
        if n == 0 && self.remaining > 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                SealError::ChangedDuringBackup,
            ));
        }
        self.remaining -= n as u64;
        Ok(n)
    }
}

fn header(entry: tar::EntryType, size: u64, mtime: u64) -> tar::Header {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(entry);
    h.set_size(size);
    h.set_mode(if entry == tar::EntryType::Directory {
        0o700
    } else {
        0o600
    });
    h.set_mtime(mtime);
    h.set_uid(0);
    h.set_gid(0);
    h
}

fn mtime_of(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Writes the archive (metadata members first, then `user_data`) into `out`.
pub fn pack<W: Write>(
    user_data: &Path,
    members: &[Member<'_>],
    out: W,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(W, PackStats), SealError> {
    let mut builder = tar::Builder::new(out);
    for m in members {
        if !META_NAMES.contains(&m.name) || m.bytes.len() as u64 > MAX_META_BYTES {
            return Err(SealError::UnsafeArchive("metadata member"));
        }
        let mut h = header(tar::EntryType::Regular, m.bytes.len() as u64, 0);
        builder.append_data(&mut h, format!("{META}/{}", m.name), m.bytes)?;
    }
    let mut stats = PackStats::default();
    let mut h = header(tar::EntryType::Directory, 0, 0);
    builder.append_data(&mut h, format!("{USER_DATA}/"), io::empty())?;
    walk(
        &mut builder,
        user_data,
        USER_DATA,
        &mut stats,
        cancel,
        progress,
    )?;
    let out = builder.into_inner()?;
    Ok((out, stats))
}

fn walk<W: Write>(
    builder: &mut tar::Builder<W>,
    dir: &Path,
    rel: &str,
    stats: &mut PackStats,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(), SealError> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            return Err(SealError::Cancelled);
        }
        let ft = entry.file_type()?;
        let os_name = entry.file_name();
        let name = os_name
            .to_str()
            .ok_or(SealError::UnsupportedFileName)?
            .to_owned();
        if ft.is_symlink() {
            stats.skipped_links += 1;
            continue;
        }
        if !(ft.is_dir() || ft.is_file()) {
            stats.skipped_other += 1;
            continue;
        }
        if is_excluded(&name, ft.is_dir()) {
            continue;
        }
        if !name_ok(&name) {
            return Err(SealError::UnsupportedFileName);
        }
        let path = entry.path();
        let child = format!("{rel}/{name}");
        let meta = fs::symlink_metadata(&path)?;
        if ft.is_dir() {
            let mut h = header(tar::EntryType::Directory, 0, mtime_of(&meta));
            builder.append_data(&mut h, format!("{child}/"), io::empty())?;
            stats.dirs += 1;
            walk(builder, &path, &child, stats, cancel, progress)?;
        } else {
            let size = meta.len();
            let mut h = header(tar::EntryType::Regular, size, mtime_of(&meta));
            let file = fs::File::open(&path)?;
            let reader = Exact {
                inner: file.take(size),
                remaining: size,
                cancel,
            };
            builder
                .append_data(&mut h, &child, reader)
                .map_err(unwrap_io)?;
            stats.files += 1;
            stats.bytes += size;
            progress(stats.bytes);
        }
    }
    Ok(())
}

/// Recovers a [`SealError`] carried inside an `io::Error`.
pub(crate) fn unwrap_io(e: io::Error) -> SealError {
    if e.get_ref().is_some_and(|inner| inner.is::<SealError>()) {
        if let Some(inner) = e.into_inner()
            && let Ok(seal) = inner.downcast::<SealError>()
        {
            return *seal;
        }
        return SealError::Authentication;
    }
    SealError::Io(e)
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_files: u64,
    pub max_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: 2_000_000,
            max_bytes: 256 * (1 << 30),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unpacked {
    pub meta: BTreeMap<String, Vec<u8>>,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
}

fn safe_parts(path: &Path) -> Result<Vec<String>, SealError> {
    let mut parts = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => {
                let s = s.to_str().ok_or(SealError::UnsafeArchive("name"))?;
                if !name_ok(s) {
                    return Err(SealError::UnsafeArchive("name"));
                }
                parts.push(s.to_owned());
            }
            _ => return Err(SealError::UnsafeArchive("path")),
        }
    }
    if parts.is_empty() || parts.len() > 64 {
        return Err(SealError::UnsafeArchive("path"));
    }
    Ok(parts)
}

#[cfg(unix)]
fn create_dirs(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}
#[cfg(not(unix))]
fn create_dirs(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(unix)]
fn create_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}
#[cfg(not(unix))]
fn create_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Extracts an archive into `dest`, which must be an existing, empty directory. Returns the input (so the caller can
/// read it to its authenticated end) and what was extracted.
pub fn unpack<R: Read>(
    input: R,
    dest: &Path,
    limits: &Limits,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(R, Unpacked), SealError> {
    if fs::read_dir(dest)?.next().is_some() {
        return Err(SealError::DestinationNotEmpty);
    }
    let mut out = Unpacked::default();
    let mut archive = tar::Archive::new(input);
    {
        let entries = archive.entries().map_err(unwrap_io)?;
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                return Err(SealError::Cancelled);
            }
            let mut entry = entry.map_err(unwrap_io)?;
            let kind = entry.header().entry_type();
            let is_dir = kind == tar::EntryType::Directory;
            let is_file = matches!(kind, tar::EntryType::Regular | tar::EntryType::Continuous);
            if !is_dir && !is_file {
                return Err(SealError::UnsafeArchive("entry type"));
            }
            let path = entry.path().map_err(unwrap_io)?.into_owned();
            let parts = safe_parts(&path)?;
            let size = entry.size();
            match parts[0].as_str() {
                META => {
                    if parts.len() != 2
                        || !is_file
                        || !META_NAMES.contains(&parts[1].as_str())
                        || size > MAX_META_BYTES
                        || out.meta.contains_key(&parts[1])
                    {
                        return Err(SealError::UnsafeArchive("metadata member"));
                    }
                    let mut bytes = Vec::with_capacity(size as usize);
                    (&mut entry).take(MAX_META_BYTES).read_to_end(&mut bytes)?;
                    out.meta.insert(parts[1].clone(), bytes);
                }
                USER_DATA => {
                    let target = parts.iter().fold(dest.to_path_buf(), |p, c| p.join(c));
                    if is_dir {
                        create_dirs(&target)?;
                        if parts.len() > 1 {
                            out.dirs += 1;
                        }
                        continue;
                    }
                    if parts.len() < 2 {
                        return Err(SealError::UnsafeArchive("path"));
                    }
                    out.files += 1;
                    if out.files > limits.max_files
                        || out.bytes.saturating_add(size) > limits.max_bytes
                    {
                        return Err(SealError::LimitExceeded);
                    }
                    if let Some(parent) = target.parent() {
                        create_dirs(parent)?;
                    }
                    let mut file = create_file(&target).map_err(|e| {
                        if e.kind() == io::ErrorKind::AlreadyExists {
                            SealError::UnsafeArchive("duplicate entry")
                        } else {
                            SealError::Io(e)
                        }
                    })?;
                    let copied =
                        io::copy(&mut (&mut entry).take(size), &mut file).map_err(unwrap_io)?;
                    if copied != size {
                        return Err(SealError::UnsafeArchive("short entry"));
                    }
                    if let Ok(mtime) = entry.header().mtime() {
                        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime);
                        let _ = file.set_modified(when);
                    }
                    out.bytes += size;
                    progress(out.bytes);
                }
                _ => return Err(SealError::UnsafeArchive("unknown top-level name")),
            }
        }
    }
    Ok((archive.into_inner(), out))
}
