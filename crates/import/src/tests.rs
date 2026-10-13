use super::*;
use crate::bundle::ArchiveError;
use crate::export::{ExportProfile, escape_formula};
use std::io::Write;
use zip::write::SimpleFileOptions;

fn ok_rows(p: &ParsedFile) -> Vec<&ProfileRow> {
    p.rows
        .iter()
        .filter_map(|r| r.outcome.as_ref().ok())
        .collect()
}

fn errors(p: &ParsedFile) -> Vec<(u32, String, &'static str)> {
    p.rows
        .iter()
        .filter_map(|r| r.outcome.as_ref().err().map(|e| (r.row, e)))
        .flat_map(|(row, es)| es.iter().map(move |e| (row, e.field.clone(), e.code)))
        .collect()
}

#[test]
fn csv_with_all_columns_unicode_and_formulas() -> Result<(), FileError> {
    let csv = "\u{feff}Name,CLIENT,tags,notes,start_urls,camera,microphone,location,favourite,template\n\
               Shop admin,North,Ads;VIP; ads ,\"Line 1\nLine 2\",https://shop.example/ https://mail.example/,block,ASK,allow,yes,Base\n\
               École 日本 😀,Ünïcode,,,,,,,,\n\
               '=SUM(A1),'+client,,'@note,,,,,no,\n";
    let p = parse("x.csv", csv.as_bytes())?;
    assert_eq!(p.format, Format::Csv);
    let rows = ok_rows(&p);
    assert_eq!(rows.len(), 3, "{:?}", errors(&p));
    assert_eq!(
        rows[0].tags,
        ["Ads", "VIP"],
        "case-insensitive tag de-duplication"
    );
    assert_eq!(rows[0].notes, "Line 1\nLine 2");
    assert_eq!(rows[0].start_urls.len(), 2);
    assert_eq!(
        (
            rows[0].camera,
            rows[0].microphone,
            rows[0].location,
            rows[0].favourite
        ),
        (
            PermissionDefault::Block,
            PermissionDefault::Ask,
            PermissionDefault::Allow,
            true
        )
    );
    assert_eq!(rows[0].template.as_deref(), Some("Base"));
    assert_eq!(rows[1].name, "École 日本 😀");
    assert_eq!(rows[1].client.as_deref(), Some("Ünïcode"));
    // Values our export protected with a leading ' come back as typed; nothing is evaluated.
    assert_eq!(
        (
            rows[2].name.as_str(),
            rows[2].client.as_deref(),
            rows[2].notes.as_str()
        ),
        ("=SUM(A1)", Some("+client"), "@note")
    );
    assert_eq!(
        p.rows.iter().map(|r| r.row).collect::<Vec<_>>(),
        [2, 4, 5],
        "line where each record starts (row 1 spans two lines)"
    );
    Ok(())
}

#[test]
fn csv_row_errors_name_the_row_and_field() -> Result<(), FileError> {
    let long_notes = "n".repeat(MAX_NOTES + 1);
    let csv = format!(
        "name,client,tags,notes,start_urls,camera,favourite\n\
         ,North,,,,,\n\
         Good,,,,,,\n\
         Bad url,,,,javascript:alert(1),,\n\
         Bad perm,,,,,sometimes,maybe\n\
         Long,,,{long_notes},,,\n\
         {},,,,,,\n\
         Tags,,{},,,,\n",
        "x".repeat(MAX_NAME + 1),
        (0..=MAX_TAGS)
            .map(|i| format!("t{i}"))
            .collect::<Vec<_>>()
            .join(";")
    );
    let p = parse("x.csv", csv.as_bytes())?;
    assert_eq!(ok_rows(&p).len(), 1);
    let e = errors(&p);
    assert!(e.contains(&(2, "name".into(), "required")), "{e:?}");
    assert!(e.contains(&(4, "start_urls".into(), "invalid_url")));
    assert!(e.contains(&(5, "camera".into(), "invalid_value")));
    assert!(e.contains(&(5, "favourite".into(), "invalid_value")));
    assert!(e.contains(&(6, "notes".into(), "too_long")));
    assert!(e.contains(&(7, "name".into(), "too_long")));
    assert!(e.contains(&(8, "tags".into(), "too_many")));
    Ok(())
}

#[test]
fn csv_file_level_problems() {
    let cases: &[(&str, &str)] = &[
        ("client\nNorth\n", "BAD_COLUMNS"),
        ("name,name\na,b\n", "BAD_COLUMNS"),
        ("name,password\na,b\n", "BAD_COLUMNS"),
        (
            "# project-browser profiles v2\nname\na\n",
            "UNSUPPORTED_SCHEMA",
        ),
        ("# something else\nname\na\n", "UNSUPPORTED_SCHEMA"),
        ("name,client\na\n", "MALFORMED_FILE"),
        ("name\n\n\n", "FILE_EMPTY"),
        ("   \n", "FILE_EMPTY"),
    ];
    for (csv, code) in cases {
        let got = parse("x.csv", csv.as_bytes())
            .map(|_| ())
            .map_err(|e| e.code());
        assert_eq!(got, Err(*code), "{csv:?}");
    }
    assert_eq!(
        parse("x.csv", b"name\n\xff\xfe\n")
            .map(|_| ())
            .map_err(|e| e.code()),
        Err("FILE_NOT_UTF8")
    );
    let versioned =
        parse("x.csv", b"# project-browser profiles v1\r\nname\r\nA\r\n").map(|p| p.rows.len());
    assert_eq!(versioned, Ok(1));
}

#[test]
fn limits_on_size_and_rows() -> Result<(), FileError> {
    let big = vec![b'a'; MAX_FILE_BYTES as usize + 1];
    assert!(matches!(
        parse("x.csv", &big),
        Err(FileError::TooLarge { .. })
    ));
    let mut csv = String::from("name\n");
    for i in 0..MAX_ROWS {
        csv.push_str(&format!("Profile {i}\n"));
    }
    let start = std::time::Instant::now();
    let p = parse("x.csv", csv.as_bytes())?;
    assert_eq!(p.rows.len(), MAX_ROWS);
    assert!(start.elapsed().as_secs() < 5, "10,000 rows parse quickly");
    csv.push_str("one too many\n");
    assert!(matches!(
        parse("x.csv", csv.as_bytes()),
        Err(FileError::TooManyRows { .. })
    ));
    Ok(())
}

#[test]
fn json_rows_are_validated_one_by_one() -> Result<(), FileError> {
    let doc = serde_json::json!({
        "format": "project-browser.profiles", "schema_version": 1,
        "profiles": [
            { "name": "A", "tags": ["x"], "favourite": true, "start_urls": ["https://a.example/"] },
            { "name": 5, "cookies": "abc" },
            "not an object",
            { "name": "B", "tags": "x;y" },
            { "name": "C", "notes": "Password: hunter2" }
        ]
    });
    let p = parse("x.json", doc.to_string().as_bytes())?;
    assert_eq!(p.format, Format::Json);
    let e = errors(&p);
    assert!(e.contains(&(2, "name".into(), "wrong_type")), "{e:?}");
    assert!(e.contains(&(2, "cookies".into(), "unknown_field")));
    assert!(e.contains(&(3, "row".into(), "wrong_type")));
    assert!(e.contains(&(4, "tags".into(), "wrong_type")));
    let rows = ok_rows(&p);
    assert_eq!(rows.len(), 2);
    assert!(
        rows[1].warnings[0].contains("password"),
        "secret warning, not an error"
    );
    assert_eq!(
        rows[1].notes, "",
        "notes that look like secrets are not imported"
    );

    for (doc, code) in [
        (serde_json::json!([]), "MALFORMED_FILE"),
        (
            serde_json::json!({ "format": "other", "schema_version": 1, "profiles": [] }),
            "MALFORMED_FILE",
        ),
        (
            serde_json::json!({ "format": "project-browser.profiles", "schema_version": 2, "profiles": [] }),
            "UNSUPPORTED_SCHEMA",
        ),
        (
            serde_json::json!({ "format": "project-browser.profiles", "schema_version": 1, "profiles": [], "x": 1 }),
            "BAD_COLUMNS",
        ),
        (
            serde_json::json!({ "format": "project-browser.profiles", "schema_version": 1, "profiles": [] }),
            "FILE_EMPTY",
        ),
    ] {
        assert_eq!(
            parse("x.json", doc.to_string().as_bytes())
                .map(|_| ())
                .map_err(|e| e.code()),
            Err(code),
            "{doc}"
        );
    }
    assert_eq!(
        parse("x.json", b"{ \"format\": ")
            .map(|_| ())
            .map_err(|e| e.code()),
        Err("MALFORMED_FILE")
    );
    Ok(())
}

fn sample() -> Vec<ExportProfile> {
    vec![
        ExportProfile {
            name: "=HYPERLINK(\"http://evil\")".into(),
            client: Some("North".into()),
            tags: vec!["Ads".into(), "VIP".into()],
            notes: "-starts with a dash\nsecond line".into(),
            start_urls: vec!["https://shop.example/".into()],
            camera: PermissionDefault::Block,
            microphone: PermissionDefault::Ask,
            location: PermissionDefault::Allow,
            favourite: true,
            template: None,
        },
        ExportProfile {
            name: "École 😀".into(),
            client: None,
            tags: vec![],
            notes: String::new(),
            start_urls: vec![],
            camera: PermissionDefault::Ask,
            microphone: PermissionDefault::Ask,
            location: PermissionDefault::Ask,
            favourite: false,
            template: Some("Base".into()),
        },
    ]
}

fn as_row(p: &ExportProfile) -> ProfileRow {
    ProfileRow {
        name: p.name.clone(),
        client: p.client.clone(),
        tags: p.tags.clone(),
        notes: p.notes.clone(),
        start_urls: p.start_urls.clone(),
        camera: p.camera,
        microphone: p.microphone,
        location: p.location,
        favourite: p.favourite,
        template: p.template.clone(),
        warnings: vec![],
    }
}

#[test]
fn exports_escape_formulas_and_round_trip() -> Result<(), FileError> {
    assert_eq!(escape_formula("=1+1"), "'=1+1");
    assert_eq!(escape_formula("@SUM(A1)"), "'@SUM(A1)");
    assert_eq!(escape_formula("\tcmd"), "'\tcmd");
    assert_eq!(escape_formula("safe = text"), "safe = text");
    let profiles = sample();
    let csv = export::to_csv(&profiles).map_err(|_| FileError::Empty)?;
    let text = String::from_utf8_lossy(&csv);
    assert!(
        text.contains("\"'=HYPERLINK(\"\"http://evil\"\")\""),
        "{text}"
    );
    assert!(
        !text.lines().any(|l| l.starts_with('=')),
        "no line starts with a formula"
    );
    for bytes in [
        csv,
        export::to_json(&profiles, "2026-10-13T00:00:00Z"),
        export::to_bundle(&profiles, "2026-10-13T00:00:00Z").map_err(|_| FileError::Empty)?,
    ] {
        let p = parse("export", &bytes)?;
        let rows: Vec<ProfileRow> = ok_rows(&p).into_iter().cloned().collect();
        assert_eq!(
            rows,
            profiles.iter().map(as_row).collect::<Vec<_>>(),
            "{:?}",
            p.format
        );
    }
    Ok(())
}

fn zip_with(entries: &[(&str, &[u8], Option<u32>)]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        for (name, data, mode) in entries {
            let mut opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            if let Some(m) = mode {
                opts = opts.unix_permissions(*m);
            }
            if *mode == Some(0o120777) {
                let target = String::from_utf8_lossy(data).into_owned();
                w.add_symlink(*name, target, opts)
                    .unwrap_or_else(|e| panic!("{e}"));
                continue;
            }
            w.start_file(*name, opts).unwrap_or_else(|e| panic!("{e}"));
            w.write_all(data).unwrap_or_else(|e| panic!("{e}"));
        }
        w.finish().unwrap_or_else(|e| panic!("{e}"));
    }
    buf.into_inner()
}

fn manifest(extra: serde_json::Value) -> Vec<u8> {
    let mut m = serde_json::json!({ "format": "project-browser.export", "schema_version": 1, "contents": ["configuration"] });
    if let (Some(m), Some(e)) = (m.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    m.to_string().into_bytes()
}

fn profiles_json() -> Vec<u8> {
    serde_json::json!({ "format": "project-browser.profiles", "schema_version": 1, "profiles": [{ "name": "A" }] })
        .to_string()
        .into_bytes()
}

fn bundle_error(bytes: &[u8]) -> Option<FileError> {
    parse("x.zip", bytes).err()
}

#[test]
fn malicious_archives_are_refused() {
    let m = manifest(serde_json::json!({}));
    let p = profiles_json();
    let a = |e| Some(FileError::Archive(e));
    assert_eq!(
        bundle_error(&zip_with(&[
            ("manifest.json", &m, None),
            ("profiles.json", &p, None)
        ])),
        None
    );
    assert_eq!(
        bundle_error(&zip_with(&[
            ("manifest.json", &m, None),
            ("../profiles.json", &p, None)
        ])),
        a(ArchiveError::PathTraversal("../profiles.json".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[("/etc/passwd", &p, None)])),
        a(ArchiveError::PathTraversal("/etc/passwd".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[("C:\\x.json", &p, None)])),
        a(ArchiveError::PathTraversal("C:\\x.json".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[(
            "manifest.json",
            b"../../etc",
            Some(0o120777)
        )])),
        a(ArchiveError::Link("manifest.json".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[
            ("manifest.json", &m, None),
            ("profiles.json", &p, Some(0o100755))
        ])),
        a(ArchiveError::Executable("profiles.json".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[
            ("manifest.json", &m, None),
            ("profiles.json", b"MZ\x90\x00 fake PE", None)
        ])),
        a(ArchiveError::Executable("profiles.json".into()))
    );
    assert_eq!(
        bundle_error(&zip_with(&[
            ("manifest.json", &m, None),
            ("run.sh", b"#!/bin/sh", None)
        ])),
        a(ArchiveError::UnexpectedEntry("run.sh".into()))
    );
    let many: Vec<(String, Vec<u8>)> = (0..=bundle::MAX_ENTRIES)
        .map(|i| (format!("f{i}.json"), vec![b'{']))
        .collect();
    let refs: Vec<(&str, &[u8], Option<u32>)> = many
        .iter()
        .map(|(n, d)| (n.as_str(), d.as_slice(), None))
        .collect();
    assert_eq!(
        bundle_error(&zip_with(&refs)),
        a(ArchiveError::TooManyEntries)
    );
    // A decompression bomb: 60 MB of zeros compresses to a few kilobytes.
    let zeros = vec![0u8; 60 * 1024 * 1024];
    let bomb = zip_with(&[("manifest.json", &m, None), ("profiles.json", &zeros, None)]);
    assert!(bomb.len() < 200_000);
    assert!(matches!(
        bundle_error(&bomb),
        Some(FileError::Archive(
            ArchiveError::Bomb(_) | ArchiveError::TooLarge
        ))
    ));
    assert_eq!(
        bundle_error(b"PK\x03\x04not really a zip"),
        a(ArchiveError::Malformed)
    );
    assert_eq!(
        bundle_error(&zip_with(&[("manifest.json", &m, None)])),
        a(ArchiveError::Missing("profiles.json"))
    );
    // Session data is never imported.
    for extra in [
        serde_json::json!({ "cookies": true }),
        serde_json::json!({ "contents": ["configuration", "cookies"] }),
    ] {
        let m = manifest(extra);
        assert_eq!(
            bundle_error(&zip_with(&[
                ("manifest.json", &m, None),
                ("profiles.json", &p, None)
            ])),
            Some(FileError::SessionData)
        );
    }
}

#[test]
fn only_documented_formats_have_adapters() {
    let ids: Vec<&str> = ADAPTERS.iter().map(|a| a.id).collect();
    assert_eq!(
        ids,
        [
            "project-browser-bundle",
            "project-browser-json",
            "project-browser-csv"
        ]
    );
    assert_eq!(digest(b"abc").len(), 64);
}
