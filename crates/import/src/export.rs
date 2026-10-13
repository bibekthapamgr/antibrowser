//! Configuration export (CSV, JSON, bundle). Only the fields of [`ExportProfile`] are ever written: no cookies,
//! browser data, download paths, proxy credentials or other secrets. Encrypted backups arrive in milestone 07.

use crate::bundle::MANIFEST_FORMAT_ID;
use crate::csv_format::COLUMNS;
use crate::{JSON_FORMAT_ID, SCHEMA_VERSION};
use pb_runtime::PermissionDefault;
use serde::Serialize;
use serde_json::json;
use std::io::Write;

/// Exported configuration of one profile. Adding a field here is a deliberate decision: secrets never belong here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExportProfile {
    pub name: String,
    pub client: Option<String>,
    pub tags: Vec<String>,
    pub notes: String,
    pub start_urls: Vec<String>,
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
    pub favourite: bool,
    pub template: Option<String>,
}

/// Neutralises spreadsheet formulas: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading
/// `'` so spreadsheet programs show it as text instead of running it (CSV injection).
pub fn escape_formula(cell: &str) -> String {
    if cell.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{cell}")
    } else {
        cell.to_owned()
    }
}

pub fn to_json(profiles: &[ExportProfile], exported_at: &str) -> Vec<u8> {
    let doc = json!({
        "format": JSON_FORMAT_ID,
        "schema_version": SCHEMA_VERSION,
        "exported_at": exported_at,
        "generator": concat!("project-browser ", env!("CARGO_PKG_VERSION")),
        "profiles": profiles,
    });
    serde_json::to_vec_pretty(&doc).unwrap_or_default()
}

pub fn to_csv(profiles: &[ExportProfile]) -> Result<Vec<u8>, csv::Error> {
    let mut out = format!("# project-browser profiles v{SCHEMA_VERSION}\n").into_bytes();
    {
        let mut w = csv::WriterBuilder::new().from_writer(&mut out);
        w.write_record(COLUMNS)?;
        for p in profiles {
            let cells = [
                p.name.clone(),
                p.client.clone().unwrap_or_default(),
                p.tags.join(";"),
                p.notes.clone(),
                p.start_urls.join(" "),
                p.camera.as_str().to_owned(),
                p.microphone.as_str().to_owned(),
                p.location.as_str().to_owned(),
                p.favourite.to_string(),
                p.template.clone().unwrap_or_default(),
            ];
            w.write_record(cells.iter().map(|c| escape_formula(c)))?;
        }
        w.flush()?;
    }
    Ok(out)
}

pub fn to_bundle(profiles: &[ExportProfile], exported_at: &str) -> zip::result::ZipResult<Vec<u8>> {
    let manifest = json!({
        "format": MANIFEST_FORMAT_ID,
        "schema_version": SCHEMA_VERSION,
        "exported_at": exported_at,
        "contents": ["configuration"],
        "cookies": false,
        "profiles": profiles.len(),
    });
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file("manifest.json", options)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).unwrap_or_default())?;
        zip.start_file("profiles.json", options)?;
        zip.write_all(&to_json(profiles, exported_at))?;
        zip.finish()?;
    }
    Ok(buf.into_inner())
}
