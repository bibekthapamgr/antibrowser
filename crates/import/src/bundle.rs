//! Export bundle (.zip) reading with archive safety checks.
//!
//! A bundle holds exactly `manifest.json` and `profiles.json` (the JSON format). Anything else is refused, and so is:
//! a path that is absolute, contains `..`, a backslash or a directory; a symbolic link; an encrypted entry; more
//! than [`MAX_ENTRIES`] entries; more than [`MAX_UNCOMPRESSED`] bytes once unpacked (checked while reading, not only
//! from the headers); an entry that expands more than [`MAX_RATIO`] times; executable content (by permission bits
//! or by the start of the file); and a manifest that claims to carry cookies or other session data.

use crate::{FileError, Format, ParsedFile, SCHEMA_VERSION, json_format};
use serde_json::Value;
use std::io::{Cursor, Read};

pub const MANIFEST_FORMAT_ID: &str = "project-browser.export";
pub const MAX_ENTRIES: usize = 8;
pub const MAX_UNCOMPRESSED: u64 = 50 * 1024 * 1024;
pub const MAX_RATIO: u64 = 100;
const ALLOWED: &[&str] = &["manifest.json", "profiles.json"];

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ArchiveError {
    #[error("the archive could not be read")]
    Malformed,
    #[error("too many entries")]
    TooManyEntries,
    #[error("\"{0}\" points outside the archive")]
    PathTraversal(String),
    #[error("\"{0}\" is a link")]
    Link(String),
    #[error("\"{0}\" is encrypted")]
    Encrypted(String),
    #[error("\"{0}\" is not part of a Project Browser export")]
    UnexpectedEntry(String),
    #[error("\"{0}\" appears twice")]
    Duplicate(String),
    #[error("\"{0}\" is missing")]
    Missing(&'static str),
    #[error("the archive unpacks to more than the allowed size")]
    TooLarge,
    #[error("\"{0}\" expands suspiciously (possible decompression bomb)")]
    Bomb(String),
    #[error("\"{0}\" is executable content")]
    Executable(String),
    #[error("the manifest is not a Project Browser export manifest")]
    BadManifest,
}

/// Magic numbers of executable formats (PE, ELF, Mach-O, universal binaries, scripts with an interpreter line).
pub fn looks_executable(bytes: &[u8]) -> bool {
    const MAGIC: &[&[u8]] = &[
        b"MZ",
        b"\x7fELF",
        b"\xfe\xed\xfa\xce",
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"#!",
    ];
    MAGIC.iter().any(|m| bytes.starts_with(m))
}

fn display(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(80).collect()
}

/// Validates the archive and returns the contents of each allowed entry.
pub fn read_entries(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, ArchiveError> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| ArchiveError::Malformed)?;
    if archive.len() > MAX_ENTRIES {
        return Err(ArchiveError::TooManyEntries);
    }
    let mut declared = 0u64;
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|_| ArchiveError::Malformed)?;
        let name = entry
            .name()
            .map_err(|_| ArchiveError::Malformed)?
            .into_owned();
        let shown = display(&name);
        if name.is_empty()
            || name.starts_with('/')
            || name.contains('\\')
            || name.contains('\0')
            || name.split('/').any(|part| part == ".." || part == ".")
            || name.contains(':')
            || entry.enclosed_name().is_none()
        {
            return Err(ArchiveError::PathTraversal(shown));
        }
        if entry.is_symlink() || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(ArchiveError::Link(shown));
        }
        if entry.encrypted() {
            return Err(ArchiveError::Encrypted(shown));
        }
        if entry
            .unix_mode()
            .is_some_and(|m| m & 0o111 != 0 && m & 0o040000 == 0)
        {
            return Err(ArchiveError::Executable(shown));
        }
        if entry.is_dir() || !ALLOWED.contains(&name.as_str()) {
            return Err(ArchiveError::UnexpectedEntry(shown));
        }
        declared = declared.saturating_add(entry.size());
        if entry.size() > entry.compressed_size().max(1).saturating_mul(MAX_RATIO)
            && entry.size() > 1024 * 1024
        {
            return Err(ArchiveError::Bomb(shown));
        }
    }
    if declared > MAX_UNCOMPRESSED {
        return Err(ArchiveError::TooLarge);
    }
    let mut out: Vec<(String, Vec<u8>)> = vec![];
    let mut total = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| ArchiveError::Malformed)?;
        let name = entry
            .name()
            .map_err(|_| ArchiveError::Malformed)?
            .into_owned();
        if out.iter().any(|(n, _)| n == &name) {
            return Err(ArchiveError::Duplicate(display(&name)));
        }
        let compressed = entry.compressed_size().max(1);
        // Headers can lie: read at most what is still allowed, plus one byte to detect overflow.
        let budget = MAX_UNCOMPRESSED - total;
        let mut data = vec![];
        entry
            .take(budget + 1)
            .read_to_end(&mut data)
            .map_err(|_| ArchiveError::Malformed)?;
        total += data.len() as u64;
        if total > MAX_UNCOMPRESSED {
            return Err(ArchiveError::TooLarge);
        }
        if data.len() as u64 > compressed.saturating_mul(MAX_RATIO) && data.len() > 1024 * 1024 {
            return Err(ArchiveError::Bomb(display(&name)));
        }
        if looks_executable(&data) {
            return Err(ArchiveError::Executable(display(&name)));
        }
        out.push((name, data));
    }
    Ok(out)
}

pub fn parse(bytes: &[u8]) -> Result<ParsedFile, FileError> {
    let entries = read_entries(bytes)?;
    let get = |n: &'static str| -> Result<&[u8], FileError> {
        entries
            .iter()
            .find(|(name, _)| name == n)
            .map(|(_, d)| d.as_slice())
            .ok_or(FileError::Archive(ArchiveError::Missing(n)))
    };
    let manifest: Value = serde_json::from_slice(get("manifest.json")?)
        .map_err(|_| FileError::Archive(ArchiveError::BadManifest))?;
    if manifest.get("format").and_then(Value::as_str) != Some(MANIFEST_FORMAT_ID) {
        return Err(FileError::Archive(ArchiveError::BadManifest));
    }
    if manifest.get("schema_version").and_then(Value::as_u64) != Some(u64::from(SCHEMA_VERSION)) {
        return Err(FileError::UnsupportedSchema {
            found: manifest
                .get("schema_version")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "missing".into()),
        });
    }
    let session = ["cookies", "sessions", "browser_data", "local_storage"]
        .iter()
        .any(|k| {
            manifest
                .get(*k)
                .is_some_and(|v| v != &Value::Bool(false) && !v.is_null())
        });
    let contents_ok = manifest
        .get("contents")
        .and_then(Value::as_array)
        .is_none_or(|a| a.iter().all(|c| c.as_str() == Some("configuration")));
    if session || !contents_ok {
        return Err(FileError::SessionData);
    }
    let text = std::str::from_utf8(get("profiles.json")?).map_err(|_| FileError::NotUtf8)?;
    let root: Value = serde_json::from_str(text)
        .map_err(|e| FileError::MalformedJson(format!("profiles.json: {e}")))?;
    let mut parsed = json_format::parse_value(&root)?;
    parsed.format = Format::Bundle;
    Ok(parsed)
}
