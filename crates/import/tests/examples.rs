//! The example files in docs/import/examples are part of the documentation: these tests keep them truthful.
use pb_import::{FieldError, Format, ParsedFile, ProfileRow, parse};
use std::path::PathBuf;

fn example(name: &str) -> ParsedFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/import/examples")
        .join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse(name, &bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn ok(p: &ParsedFile) -> Vec<(u32, ProfileRow)> {
    p.rows
        .iter()
        .filter_map(|r| r.outcome.as_ref().ok().map(|o| (r.row, o.clone())))
        .collect()
}

fn errors(p: &ParsedFile) -> Vec<(u32, String, &'static str)> {
    p.rows
        .iter()
        .flat_map(|r| match &r.outcome {
            Err(es) => es
                .iter()
                .map(|e: &FieldError| (r.row, e.field.clone(), e.code))
                .collect(),
            Ok(_) => vec![],
        })
        .collect()
}

#[test]
fn valid_csv_example_imports_every_row() {
    let p = example("profiles.csv");
    assert_eq!(p.format, Format::Csv);
    assert_eq!(errors(&p), vec![]);
    let rows = ok(&p);
    let names: Vec<&str> = rows.iter().map(|(_, r)| r.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Shop admin",
            "Ads QA",
            "Support desk",
            "Café Zürich",
            "日本ストア"
        ]
    );
    // Row numbers are source lines (the version line and header come first; a quoted note spans two lines).
    assert_eq!(
        rows.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        [3, 4, 5, 7, 8]
    );
    let shop = &rows[0].1;
    assert_eq!(shop.tags, ["ecommerce", "vip"]);
    assert!(shop.favourite);
    assert_eq!(rows[1].1.start_urls.len(), 2);
    assert_eq!(rows[2].1.notes, "Two lines of notes:\nthe second line");
    assert!(rows[4].1.favourite, "\"yes\" is accepted for favourite");
}

#[test]
fn mixed_validity_example_reports_each_bad_row() {
    let p = example("mixed-validity.csv");
    assert_eq!(
        errors(&p),
        [
            (3, "name".to_owned(), "required"),
            (4, "start_urls".to_owned(), "invalid_url"),
            (5, "camera".to_owned(), "invalid_value"),
            (10, "tags".to_owned(), "too_long"),
            (11, "favourite".to_owned(), "invalid_value"),
        ]
    );
    let rows = ok(&p);
    let social = rows.iter().find(|(n, _)| *n == 6).map(|(_, r)| r);
    assert_eq!(
        social.map(|r| r.notes.as_str()),
        Some(""),
        "secret-looking notes are left out"
    );
    assert!(social.is_some_and(|r| r.warnings[0].contains("notes left out")));
    let formula = rows.iter().find(|(n, _)| *n == 8).map(|(_, r)| r);
    assert_eq!(
        formula.map(|r| r.name.as_str()),
        Some("=HYPERLINK(\"http://evil.example\",\"click\")"),
        "kept as plain text, never evaluated"
    );
    // Duplicates (rows 2 and 7) and the unknown template (row 9) are decided when the import is planned against
    // the workspace, not while parsing: both rows parse.
    assert!(rows.iter().any(|(n, _)| *n == 7));
    assert!(
        rows.iter()
            .any(|(n, r)| *n == 9 && r.template.as_deref() == Some("Missing template"))
    );
}

#[test]
fn json_example_imports_every_row() {
    let p = example("profiles.json");
    assert_eq!((p.format, p.schema_version), (Format::Json, 1));
    assert_eq!(errors(&p), vec![]);
    let rows = ok(&p);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].1.camera, pb_runtime::PermissionDefault::Block);
    assert_eq!(rows[3].1.template.as_deref(), Some("Store manager"));
}
