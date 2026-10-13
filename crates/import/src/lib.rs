//! Profile **configuration** import and export (milestone 04).
//!
//! Scope: names, clients, tags, notes, start pages, permission defaults and favourites. Never cookies, sign-ins,
//! passwords or other browser storage: there is no session migration in this crate, and a bundle that says it
//! contains session data is refused.
//!
//! Safety rules:
//!  - files are limited to [`MAX_FILE_BYTES`] and [`MAX_ROWS`] rows; every format carries a schema version;
//!  - every row is validated on its own and errors name the row and the field, so one bad row never hides the rest;
//!  - archives are checked for path traversal, links, decompression bombs, encryption and executable content, and
//!    may only contain the known JSON entries ([`bundle`]);
//!  - spreadsheet formulas are neutralised on export ([`export::escape_formula`]) and never evaluated on import.
//!
//! Adapters: only formats that are documented or legally supplied by the user may get an adapter ([`ADAPTERS`]).
//! Today that is this product's own CSV, JSON and bundle formats.

pub mod bundle;
pub mod csv_format;
pub mod export;
pub mod json_format;
pub mod notes;

use pb_runtime::PermissionDefault;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Largest import file (CSV, JSON or bundle).
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Most rows per import (matches the per-workspace table target).
pub const MAX_ROWS: usize = 10_000;
pub const MAX_NAME: usize = 120;
pub const MAX_TAG: usize = 40;
pub const MAX_TAGS: usize = 20;
pub const MAX_NOTES: usize = 2000;
pub const MAX_START_URLS: usize = 10;
/// The only schema version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 1;
pub const JSON_FORMAT_ID: &str = "project-browser.profiles";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Csv,
    Json,
    Bundle,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Bundle => "bundle",
        }
    }
}

/// One validated row, ready to become a profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfileRow {
    pub name: String,
    pub client: Option<String>,
    pub tags: Vec<String>,
    pub notes: String,
    pub start_urls: Vec<String>,
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
    pub favourite: bool,
    /// Name of an existing template to apply first (resolved by the caller).
    pub template: Option<String>,
    /// Non-blocking notices (for example: the notes look like a password).
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldError {
    pub field: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RowResult {
    /// 1-based position in the source: the CSV line or the JSON array index + 1.
    pub row: u32,
    pub outcome: Result<ProfileRow, Vec<FieldError>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ParsedFile {
    pub format: Format,
    pub schema_version: u32,
    pub rows: Vec<RowResult>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum FileError {
    #[error("the file is larger than the {limit} byte limit")]
    TooLarge { limit: u64 },
    #[error("the file is empty")]
    Empty,
    #[error("the file is not UTF-8 text")]
    NotUtf8,
    #[error("the file format is not recognised (use CSV, JSON or a Project Browser export)")]
    UnknownFormat,
    #[error(
        "schema version {found} is not supported (this version reads version {SCHEMA_VERSION})"
    )]
    UnsupportedSchema { found: String },
    #[error("the required column \"{0}\" is missing")]
    MissingColumn(&'static str),
    #[error("unknown columns: {}", .0.join(", "))]
    UnknownColumns(Vec<String>),
    #[error("the column \"{0}\" appears more than once")]
    DuplicateColumn(String),
    #[error("the file has more than {limit} rows")]
    TooManyRows { limit: usize },
    #[error("the file has no profile rows")]
    NoRows,
    #[error("malformed CSV at line {line}: {message}")]
    MalformedCsv { line: u64, message: String },
    #[error("malformed JSON: {0}")]
    MalformedJson(String),
    #[error("unsafe or invalid archive: {0}")]
    Archive(#[from] bundle::ArchiveError),
    #[error(
        "this file contains browser session data (cookies or sign-ins); only configuration can be imported"
    )]
    SessionData,
}

impl FileError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooLarge { .. } => "FILE_TOO_LARGE",
            Self::Empty | Self::NoRows => "FILE_EMPTY",
            Self::NotUtf8 => "FILE_NOT_UTF8",
            Self::UnknownFormat => "UNKNOWN_FORMAT",
            Self::UnsupportedSchema { .. } => "UNSUPPORTED_SCHEMA",
            Self::MissingColumn(_) | Self::UnknownColumns(_) | Self::DuplicateColumn(_) => {
                "BAD_COLUMNS"
            }
            Self::TooManyRows { .. } => "TOO_MANY_ROWS",
            Self::MalformedCsv { .. } | Self::MalformedJson(_) => "MALFORMED_FILE",
            Self::Archive(_) => "UNSAFE_ARCHIVE",
            Self::SessionData => "SESSION_DATA_NOT_SUPPORTED",
        }
    }
}

/// A source format this build can read. Only documented or user-supplied formats may be added (see module docs).
pub struct Adapter {
    pub id: &'static str,
    pub description: &'static str,
    pub detect: fn(name: &str, bytes: &[u8]) -> bool,
    pub parse: fn(bytes: &[u8]) -> Result<ParsedFile, FileError>,
}

pub const ADAPTERS: &[Adapter] = &[
    Adapter {
        id: "project-browser-bundle",
        description: "Project Browser export bundle (.zip with manifest.json and profiles.json)",
        detect: |_, b| b.starts_with(b"PK\x03\x04") || b.starts_with(b"PK\x05\x06"),
        parse: bundle::parse,
    },
    Adapter {
        id: "project-browser-json",
        description: "Project Browser profiles JSON (format \"project-browser.profiles\", schema 1)",
        detect: |_, b| matches!(first_non_space(strip_bom(b)), Some(b'{' | b'[')),
        parse: json_format::parse,
    },
    Adapter {
        id: "project-browser-csv",
        description: "CSV with a header row (name, client, tags, notes, start_urls, camera, microphone, location, \
                      favourite, template)",
        detect: |name, b| {
            name.to_ascii_lowercase().ends_with(".csv") || first_non_space(strip_bom(b)).is_some()
        },
        parse: csv_format::parse,
    },
];

pub fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(b)
}

fn first_non_space(b: &[u8]) -> Option<u8> {
    b.iter().copied().find(|c| !c.is_ascii_whitespace())
}

/// SHA-256 of the source bytes (binds a preview to the exact file it showed).
pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Detects the format and parses the file. Row problems are reported per row; file problems are an error.
pub fn parse(name: &str, bytes: &[u8]) -> Result<ParsedFile, FileError> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge {
            limit: MAX_FILE_BYTES,
        });
    }
    if first_non_space(strip_bom(bytes)).is_none() {
        return Err(FileError::Empty);
    }
    let adapter = ADAPTERS
        .iter()
        .find(|a| (a.detect)(name, bytes))
        .ok_or(FileError::UnknownFormat)?;
    let parsed = (adapter.parse)(bytes)?;
    if parsed.rows.is_empty() {
        return Err(FileError::NoRows);
    }
    Ok(parsed)
}

// ------------------------------------------------------------------------------------------------ validation

/// Raw, untyped field values of one row (strings as they appear in the source).
#[derive(Default, Debug)]
pub(crate) struct RawRow {
    pub name: Option<String>,
    pub client: Option<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub start_urls: Vec<String>,
    pub camera: Option<String>,
    pub microphone: Option<String>,
    pub location: Option<String>,
    pub favourite: Option<String>,
    pub template: Option<String>,
}

fn err(field: &str, code: &'static str, message: impl Into<String>) -> FieldError {
    FieldError {
        field: field.to_owned(),
        code,
        message: message.into(),
    }
}

fn has_control(s: &str) -> bool {
    s.chars()
        .any(|c| c.is_control() || notes::is_bidi_control(c))
}

fn label(
    field: &str,
    value: Option<String>,
    max: usize,
    errors: &mut Vec<FieldError>,
) -> Option<String> {
    let v = value
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())?;
    if v.chars().count() > max {
        errors.push(err(
            field,
            "too_long",
            format!("{field} is longer than {max} characters"),
        ));
        return None;
    }
    if has_control(&v) {
        errors.push(err(
            field,
            "invalid_characters",
            format!("{field} contains control characters"),
        ));
        return None;
    }
    Some(v)
}

fn permission(
    field: &str,
    value: Option<String>,
    errors: &mut Vec<FieldError>,
) -> PermissionDefault {
    let Some(v) = value
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
    else {
        return PermissionDefault::Ask;
    };
    PermissionDefault::parse(&v).unwrap_or_else(|| {
        errors.push(err(
            field,
            "invalid_value",
            format!("{field} must be ask, block or allow"),
        ));
        PermissionDefault::Ask
    })
}

pub(crate) fn validate(raw: RawRow) -> Result<ProfileRow, Vec<FieldError>> {
    let mut errors = vec![];
    let mut warnings = vec![];
    let name = match label("name", raw.name, MAX_NAME, &mut errors) {
        Some(n) => n,
        None => {
            if !errors.iter().any(|e| e.field == "name") {
                errors.push(err("name", "required", "name is required"));
            }
            String::new()
        }
    };
    let client = label("client", raw.client, MAX_NAME, &mut errors);
    let template = label("template", raw.template, MAX_NAME, &mut errors);

    let mut tags: Vec<String> = vec![];
    for t in raw.tags {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > MAX_TAG {
            errors.push(err(
                "tags",
                "too_long",
                format!(
                    "tag \"{}…\" is longer than {MAX_TAG} characters",
                    t.chars().take(20).collect::<String>()
                ),
            ));
        } else if has_control(t) {
            errors.push(err(
                "tags",
                "invalid_characters",
                "a tag contains control characters",
            ));
        } else if !tags.iter().any(|x| x.to_lowercase() == t.to_lowercase()) {
            tags.push(t.to_owned());
        }
    }
    if tags.len() > MAX_TAGS {
        errors.push(err("tags", "too_many", format!("at most {MAX_TAGS} tags")));
    }

    let mut notes = notes::sanitize(raw.notes.as_deref().unwrap_or(""));
    // Notes are not a place for secrets: a note that looks like a password, key or card number is not imported.
    if let Some(hint) = notes::secret_hint(&notes) {
        warnings.push(format!("notes left out ({hint})"));
        notes.clear();
    }
    if notes.chars().count() > MAX_NOTES {
        errors.push(err(
            "notes",
            "too_long",
            format!("notes are longer than {MAX_NOTES} characters"),
        ));
    }

    let mut start_urls = vec![];
    for u in raw
        .start_urls
        .iter()
        .map(|u| u.trim())
        .filter(|u| !u.is_empty())
    {
        if pb_runtime::valid_start_url(u) {
            start_urls.push(u.to_owned());
        } else {
            errors.push(err(
                "start_urls",
                "invalid_url",
                format!(
                    "\"{}\" is not an http(s) address",
                    u.chars().take(60).collect::<String>()
                ),
            ));
        }
    }
    if start_urls.len() > MAX_START_URLS {
        errors.push(err(
            "start_urls",
            "too_many",
            format!("at most {MAX_START_URLS} start pages"),
        ));
    }

    let camera = permission("camera", raw.camera, &mut errors);
    let microphone = permission("microphone", raw.microphone, &mut errors);
    let location = permission("location", raw.location, &mut errors);
    let favourite = match raw
        .favourite
        .as_deref()
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") | Some("false") | Some("no") | Some("0") => false,
        Some("true") | Some("yes") | Some("1") => true,
        Some(_) => {
            errors.push(err(
                "favourite",
                "invalid_value",
                "favourite must be true or false",
            ));
            false
        }
    };

    if errors.is_empty() {
        Ok(ProfileRow {
            name,
            client,
            tags,
            notes,
            start_urls,
            camera,
            microphone,
            location,
            favourite,
            template,
            warnings,
        })
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests;
