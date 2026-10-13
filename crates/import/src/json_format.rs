//! JSON configuration format (schema 1).
//!
//! ```json
//! { "format": "project-browser.profiles", "schema_version": 1,
//!   "profiles": [ { "name": "Shop admin", "client": "North", "tags": ["Ads"], "notes": "",
//!                   "start_urls": ["https://shop.example/"], "camera": "block", "microphone": "ask",
//!                   "location": "allow", "favourite": true, "template": null } ] }
//! ```
//! Only `name` is required. Unknown fields are reported on the row that has them.

use crate::{
    FieldError, FileError, Format, JSON_FORMAT_ID, MAX_ROWS, ParsedFile, RawRow, RowResult,
    SCHEMA_VERSION, strip_bom, validate,
};
use serde_json::{Map, Value};

const FIELDS: &[&str] = &[
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
const TOP_LEVEL: &[&str] = &[
    "format",
    "schema_version",
    "profiles",
    "exported_at",
    "generator",
];

pub fn parse(bytes: &[u8]) -> Result<ParsedFile, FileError> {
    let text = std::str::from_utf8(strip_bom(bytes)).map_err(|_| FileError::NotUtf8)?;
    let root: Value = serde_json::from_str(text).map_err(|e| {
        FileError::MalformedJson(format!(
            "line {}, column {}: {}",
            e.line(),
            e.column(),
            short(&e)
        ))
    })?;
    parse_value(&root)
}

fn short(e: &serde_json::Error) -> &'static str {
    match e.classify() {
        serde_json::error::Category::Eof => "unexpected end of file",
        serde_json::error::Category::Syntax => "syntax error",
        _ => "invalid data",
    }
}

pub(crate) fn parse_value(root: &Value) -> Result<ParsedFile, FileError> {
    let obj = root
        .as_object()
        .ok_or_else(|| FileError::MalformedJson("the top level must be an object".into()))?;
    if obj.get("format").and_then(Value::as_str) != Some(JSON_FORMAT_ID) {
        return Err(FileError::MalformedJson(format!(
            "\"format\" must be \"{JSON_FORMAT_ID}\""
        )));
    }
    match obj.get("schema_version") {
        Some(Value::Number(n)) if n.as_u64() == Some(u64::from(SCHEMA_VERSION)) => {}
        Some(other) => {
            return Err(FileError::UnsupportedSchema {
                found: other.to_string().chars().take(20).collect(),
            });
        }
        None => {
            return Err(FileError::UnsupportedSchema {
                found: "missing".into(),
            });
        }
    }
    let unknown: Vec<String> = obj
        .keys()
        .filter(|k| !TOP_LEVEL.contains(&k.as_str()))
        .map(|k| k.chars().take(40).collect())
        .collect();
    if !unknown.is_empty() {
        return Err(FileError::UnknownColumns(unknown));
    }
    let profiles = obj
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| FileError::MalformedJson("\"profiles\" must be an array".into()))?;
    if profiles.len() > MAX_ROWS {
        return Err(FileError::TooManyRows { limit: MAX_ROWS });
    }
    let rows = profiles
        .iter()
        .enumerate()
        .map(|(i, v)| RowResult {
            row: u32::try_from(i + 1).unwrap_or(u32::MAX),
            outcome: row(v),
        })
        .collect();
    Ok(ParsedFile {
        format: Format::Json,
        schema_version: SCHEMA_VERSION,
        rows,
    })
}

fn type_error(field: &str, expected: &str) -> FieldError {
    FieldError {
        field: field.to_owned(),
        code: "wrong_type",
        message: format!("{field} must be {expected}"),
    }
}

fn row(v: &Value) -> Result<crate::ProfileRow, Vec<FieldError>> {
    let Some(o) = v.as_object() else {
        return Err(vec![type_error("row", "an object")]);
    };
    let mut errors = vec![];
    for k in o.keys().filter(|k| !FIELDS.contains(&k.as_str())) {
        errors.push(FieldError {
            field: k.chars().take(40).collect(),
            code: "unknown_field",
            message: format!(
                "unknown field \"{}\"",
                k.chars().take(40).collect::<String>()
            ),
        });
    }
    let text = |o: &Map<String, Value>, f: &str, errors: &mut Vec<FieldError>| -> Option<String> {
        match o.get(f) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                errors.push(type_error(f, "text"));
                None
            }
        }
    };
    let list = |o: &Map<String, Value>, f: &str, errors: &mut Vec<FieldError>| -> Vec<String> {
        match o.get(f) {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => a
                .iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect(),
            Some(_) => {
                errors.push(type_error(f, "a list of text"));
                vec![]
            }
        }
    };
    let favourite = match o.get("favourite") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(_) => {
            errors.push(type_error("favourite", "true or false"));
            None
        }
    };
    let raw = RawRow {
        name: text(o, "name", &mut errors),
        client: text(o, "client", &mut errors),
        tags: list(o, "tags", &mut errors),
        notes: text(o, "notes", &mut errors),
        start_urls: list(o, "start_urls", &mut errors),
        camera: text(o, "camera", &mut errors),
        microphone: text(o, "microphone", &mut errors),
        location: text(o, "location", &mut errors),
        favourite,
        template: text(o, "template", &mut errors),
    };
    match validate(raw) {
        Ok(r) if errors.is_empty() => Ok(r),
        Ok(_) => Err(errors),
        Err(mut e) => {
            errors.append(&mut e);
            Err(errors)
        }
    }
}
