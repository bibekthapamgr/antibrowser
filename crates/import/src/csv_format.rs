//! CSV configuration format (schema 1).
//!
//! ```text
//! # project-browser profiles v1          <- optional first line; any other version is refused
//! name,client,tags,notes,start_urls,camera,microphone,location,favourite,template
//! Shop admin,North,Ads;VIP,"Call on Mondays",https://shop.example/ https://mail.example/,block,ask,allow,true,
//! ```
//! - Only `name` is required; column names are case-insensitive; unknown or repeated columns are refused.
//! - `tags` are separated by `;`, `start_urls` by spaces or new lines.
//! - A cell this product exported with a protective `'` before `= + - @` (see [`crate::export::escape_formula`])
//!   is read back without it. Nothing is ever evaluated as a formula.

use crate::{
    FileError, Format, MAX_ROWS, ParsedFile, RawRow, RowResult, SCHEMA_VERSION, strip_bom, validate,
};

pub const COLUMNS: &[&str] = &[
    "name",
    "client",
    "tags",
    "notes",
    "start_urls",
    "camera",
    "microphone",
    "location",
    "favourite",
    "template",
];
const VERSION_PREFIX: &str = "# project-browser profiles v";

/// Reverses [`crate::export::escape_formula`] for one cell.
pub fn unescape_formula(cell: &str) -> &str {
    match cell.strip_prefix('\'') {
        Some(rest) if rest.starts_with(['=', '+', '-', '@', '\t', '\r']) => rest,
        _ => cell,
    }
}

pub fn parse(bytes: &[u8]) -> Result<ParsedFile, FileError> {
    let text = std::str::from_utf8(strip_bom(bytes)).map_err(|_| FileError::NotUtf8)?;
    // Optional version line.
    let mut body = text;
    let mut first_line_offset = 0u64;
    if let Some(first) = text.lines().next()
        && first.trim_start().starts_with('#')
    {
        let version = first
            .trim()
            .strip_prefix(VERSION_PREFIX)
            .map(str::trim)
            .ok_or_else(|| FileError::UnsupportedSchema {
                found: first.trim().chars().take(40).collect(),
            })?;
        if version != SCHEMA_VERSION.to_string() {
            return Err(FileError::UnsupportedSchema {
                found: version.chars().take(20).collect(),
            });
        }
        body = &text[first.len()..];
        body = body
            .strip_prefix("\r\n")
            .or_else(|| body.strip_prefix('\n'))
            .unwrap_or(body);
        first_line_offset = 1;
    }

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .trim(csv::Trim::None)
        .from_reader(body.as_bytes());
    let headers = reader
        .headers()
        .map_err(|e| malformed(&e, &mut Lines::new(body.as_bytes()), first_line_offset))?
        .clone();
    let mut index: Vec<Option<usize>> = vec![None; COLUMNS.len()];
    let mut unknown = vec![];
    for (i, h) in headers.iter().enumerate() {
        let key = h.trim().to_ascii_lowercase();
        match COLUMNS.iter().position(|c| *c == key) {
            Some(c) if index[c].is_some() => return Err(FileError::DuplicateColumn(key)),
            Some(c) => index[c] = Some(i),
            None if key.is_empty() => unknown.push("(empty header)".to_owned()),
            None => unknown.push(h.trim().chars().take(40).collect()),
        }
    }
    if index[0].is_none() {
        return Err(FileError::MissingColumn("name"));
    }
    if !unknown.is_empty() {
        return Err(FileError::UnknownColumns(unknown));
    }

    let mut lines = Lines::new(body.as_bytes());
    let mut rows = vec![];
    for record in reader.records() {
        let record = record.map_err(|e| malformed(&e, &mut lines, first_line_offset))?;
        if record.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        if rows.len() == MAX_ROWS {
            return Err(FileError::TooManyRows { limit: MAX_ROWS });
        }
        let line = record.position().map_or(0, |p| lines.line_of(p.byte())) + first_line_offset;
        let cell = |c: usize| -> Option<String> {
            index[c]
                .and_then(|i| record.get(i))
                .map(|v| unescape_formula(v).to_owned())
        };
        let raw = RawRow {
            name: cell(0),
            client: cell(1),
            tags: cell(2)
                .map(|t| t.split(';').map(str::to_owned).collect())
                .unwrap_or_default(),
            notes: cell(3),
            start_urls: cell(4)
                .map(|u| u.split_whitespace().map(str::to_owned).collect())
                .unwrap_or_default(),
            camera: cell(5),
            microphone: cell(6),
            location: cell(7),
            favourite: cell(8),
            template: cell(9),
        };
        rows.push(RowResult {
            row: u32::try_from(line).unwrap_or(u32::MAX),
            outcome: validate(raw),
        });
    }
    Ok(ParsedFile {
        format: Format::Csv,
        schema_version: SCHEMA_VERSION,
        rows,
    })
}

/// Line numbers computed from byte offsets. The csv reader's own line count is one too low for files with CRLF line
/// endings (it places a record's start on the `\n` of the previous line ending), and spreadsheets on Windows write
/// CRLF. Offsets only grow while a file is read, so counting is incremental.
struct Lines<'a> {
    text: &'a [u8],
    at: usize,
    line: u64,
}

impl<'a> Lines<'a> {
    fn new(text: &'a [u8]) -> Self {
        Self {
            text,
            at: 0,
            line: 1,
        }
    }

    /// 1-based line of the first character at or after `byte` that is not a line ending.
    fn line_of(&mut self, byte: u64) -> u64 {
        let mut target = usize::try_from(byte)
            .unwrap_or(usize::MAX)
            .min(self.text.len());
        while self
            .text
            .get(target)
            .is_some_and(|b| matches!(b, b'\r' | b'\n'))
        {
            target += 1;
        }
        if target < self.at {
            self.at = 0;
            self.line = 1;
        }
        let span = self.text.get(self.at..target).unwrap_or_default();
        for (i, b) in span.iter().enumerate() {
            let lone_cr = *b == b'\r' && span.get(i + 1).copied() != Some(b'\n');
            if *b == b'\n' || lone_cr {
                self.line += 1;
            }
        }
        self.at = target;
        self.line
    }
}

fn malformed(e: &csv::Error, lines: &mut Lines<'_>, offset: u64) -> FileError {
    let line = e.position().map_or(0, |p| lines.line_of(p.byte())) + offset;
    let message = match e.kind() {
        csv::ErrorKind::UnequalLengths {
            expected_len, len, ..
        } => {
            format!("expected {expected_len} fields, found {len}")
        }
        csv::ErrorKind::Utf8 { .. } => "not UTF-8 text".to_owned(),
        _ => "could not be read".to_owned(),
    };
    FileError::MalformedCsv { line, message }
}
