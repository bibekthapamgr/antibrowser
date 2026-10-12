use super::*;
use std::io::Cursor;
use zip::write::SimpleFileOptions;

struct FixedSpace(u64);
impl SpaceProbe for FixedSpace {
    fn available(&self, _: &Path) -> io::Result<u64> {
        Ok(self.0)
    }
}

const PLENTY: FixedSpace = FixedSpace(u64::MAX / 2);

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        for (name, data) in entries {
            if name.ends_with('/') {
                w.add_directory(*name, SimpleFileOptions::default())
                    .unwrap_or_else(|e| panic!("{e}"));
            } else {
                w.start_file(*name, SimpleFileOptions::default())
                    .unwrap_or_else(|e| panic!("{e}"));
                w.write_all(data).unwrap_or_else(|e| panic!("{e}"));
            }
        }
        w.finish().unwrap_or_else(|e| panic!("{e}"));
    }
    buf.into_inner()
}

fn symlink_zip() -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        w.add_symlink("link", "/etc/passwd", SimpleFileOptions::default())
            .unwrap_or_else(|e| panic!("{e}"));
        w.finish().unwrap_or_else(|e| panic!("{e}"));
    }
    buf.into_inner()
}

fn artifact_for(bytes: &[u8]) -> RuntimeArtifact {
    RuntimeArtifact {
        platform: "linux-x64".into(),
        url: "https://downloads.example/rt.zip".into(),
        sha256: Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        size_bytes: bytes.len() as u64,
        format: "zip".into(),
        executable: "chrome/chrome".into(),
        macos_codesign: None,
    }
}

fn zip_with_links(files: &[(&str, &[u8])], links: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        for (name, target) in links {
            w.add_symlink(*name, *target, SimpleFileOptions::default())
                .unwrap_or_else(|e| panic!("{e}"));
        }
        for (name, data) in files {
            w.start_file(*name, SimpleFileOptions::default().unix_permissions(0o755))
                .unwrap_or_else(|e| panic!("{e}"));
            w.write_all(data).unwrap_or_else(|e| panic!("{e}"));
        }
        w.finish().unwrap_or_else(|e| panic!("{e}"));
    }
    buf.into_inner()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    archive: PathBuf,
    root: PathBuf,
}

fn fixture(bytes: &[u8]) -> Fixture {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let archive = tmp.path().join("rt.zip");
    fs::write(&archive, bytes).unwrap_or_else(|e| panic!("{e}"));
    let root = tmp.path().join("runtimes");
    Fixture {
        _tmp: tmp,
        archive,
        root,
    }
}

#[test]
fn installs_a_verified_archive_atomically() -> Result<(), InstallError> {
    let bytes = zip_bytes(&[
        ("chrome/", b""),
        ("chrome/chrome", b"#!binary"),
        ("chrome/res.pak", b"data"),
    ]);
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    let mut stages = vec![];
    let installed = installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "153.0.1",
        &mut |p| stages.push(p.stage),
    )?;
    assert!(installed.path.join("chrome/chrome").is_file());
    assert_eq!(installed.executable, installed.path.join("chrome/chrome"));
    assert!(stages.contains(&Stage::Extracting) && stages.last() == Some(&Stage::Finalizing));
    assert!(
        installer.interrupted()?.is_empty(),
        "no staging left behind"
    );
    Ok(())
}

#[test]
fn digest_mismatch_is_quarantined_and_never_extracted() -> Result<(), InstallError> {
    let bytes = zip_bytes(&[("chrome/chrome", b"#!binary")]);
    let f = fixture(&bytes);
    let mut wrong = artifact_for(&bytes);
    wrong.sha256 = "0".repeat(64);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    let err = installer.install(
        &LocalFile(f.archive.clone()),
        &wrong,
        "153.0.1",
        &mut |_| {},
    );
    assert!(matches!(err, Err(InstallError::Quarantined { .. })));
    assert_eq!(installer.quarantined()?.len(), 1);
    assert!(
        !installer.installed_dir("153.0.1", "linux-x64")?.exists(),
        "nothing installed"
    );
    assert!(installer.interrupted()?.is_empty());

    // A truncated or oversized download is treated the same way.
    let mut longer = artifact_for(&bytes);
    longer.size_bytes += 10;
    let err = installer.install(
        &LocalFile(f.archive.clone()),
        &longer,
        "153.0.1",
        &mut |_| {},
    );
    assert!(matches!(err, Err(InstallError::Quarantined { .. })));
    Ok(())
}

#[test]
fn low_disk_is_refused_before_writing_and_explains_the_requirement() -> Result<(), InstallError> {
    let bytes = zip_bytes(&[("chrome/chrome", b"#!binary")]);
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &FixedSpace(1024),
    };
    match installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "153.0.1",
        &mut |_| {},
    ) {
        Err(InstallError::InsufficientSpace {
            required,
            available,
        }) => {
            assert!(required > SAFETY_MARGIN_BYTES);
            assert_eq!(available, 1024);
        }
        other => panic!("expected InsufficientSpace, got {other:?}"),
    }
    assert!(
        installer.interrupted()?.is_empty(),
        "nothing staged when space is insufficient"
    );
    Ok(())
}

#[test]
fn unsafe_archives_are_rejected() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("parent traversal", zip_bytes(&[("../../evil", b"x")])),
        (
            "nested traversal",
            zip_bytes(&[("chrome/../../evil", b"x")]),
        ),
        ("absolute path", zip_bytes(&[("/etc/evil", b"x")])),
        ("backslash path", zip_bytes(&[("chrome\\..\\evil", b"x")])),
        ("symlink", symlink_zip()),
    ];
    for (label, bytes) in cases {
        let f = fixture(&bytes);
        let installer = Installer {
            root: f.root.clone(),
            space: &PLENTY,
        };
        let err = installer.install(
            &LocalFile(f.archive.clone()),
            &artifact_for(&bytes),
            "1.0.0",
            &mut |_| {},
        );
        assert!(
            matches!(
                err,
                Err(InstallError::UnsafeEntry(_)) | Err(InstallError::BadArchive(_))
            ),
            "{label}: {err:?}"
        );
        assert!(
            !f.root.join("../evil").exists()
                && !f
                    .root
                    .parent()
                    .map(|p| p.join("evil"))
                    .is_some_and(|p| p.exists())
        );
    }
}

#[test]
fn zip_bombs_are_refused() {
    let big = vec![0u8; 4 * 1024 * 1024];
    let bytes = zip_bytes(&[("bomb", &big)]);
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    let err = installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "1.0.0",
        &mut |_| {},
    );
    assert!(matches!(err, Err(InstallError::BadArchive(_))), "{err:?}");
}

#[test]
fn interrupted_installs_are_detected_and_can_be_discarded() -> Result<(), InstallError> {
    let bytes = zip_bytes(&[("chrome/chrome", b"#!binary")]);
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    // Simulate a kill during copying: journal + partial file exist.
    let staging = f.root.join("staging").join("153.0.1-linux-x64");
    fs::create_dir_all(&staging)?;
    Installer::write_journal(
        &staging,
        &Journal {
            version: "153.0.1".into(),
            platform: "linux-x64".into(),
            stage: Stage::Copying,
            expected_sha256: "a".repeat(64),
            started_at_unix: 1,
        },
    )?;
    fs::write(staging.join("artifact.partial"), b"half")?;

    let found = installer.interrupted()?;
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].journal.as_ref().map(|j| j.stage),
        Some(Stage::Copying)
    );
    // A new install of the same runtime is refused until the user chooses retry/discard.
    let err = installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "153.0.1",
        &mut |_| {},
    );
    assert!(matches!(err, Err(InstallError::InProgress)));

    // Discarding outside staging/ is refused.
    assert!(installer.discard_interrupted(&f.root).is_err());
    installer.discard_interrupted(&found[0].dir)?;
    assert!(installer.interrupted()?.is_empty());
    installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "153.0.1",
        &mut |_| {},
    )?;
    Ok(())
}

#[test]
fn a_missing_executable_fails_the_install() {
    let bytes = zip_bytes(&[("chrome/other", b"x")]);
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    let err = installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "1.0.0.0",
        &mut |_| {},
    );
    assert!(
        matches!(err, Err(InstallError::MissingExecutable)),
        "{err:?}"
    );
    assert!(
        installer
            .interrupted()
            .map(|i| i.is_empty())
            .unwrap_or(false)
    );
}

#[test]
fn escaping_or_absolute_links_and_writes_through_links_are_refused() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("absolute", zip_with_links(&[], &[("chrome/l", "/etc")])),
        ("escaping", zip_with_links(&[], &[("chrome/l", "../../x")])),
        (
            "write through link",
            zip_with_links(&[("chrome/l/evil", b"x")], &[("chrome/l", "sub")]),
        ),
    ];
    for (label, bytes) in cases {
        let f = fixture(&bytes);
        let installer = Installer {
            root: f.root.clone(),
            space: &PLENTY,
        };
        let err = installer.install(
            &LocalFile(f.archive.clone()),
            &artifact_for(&bytes),
            "1.0.0.0",
            &mut |_| {},
        );
        assert!(
            matches!(err, Err(InstallError::UnsafeEntry(_))),
            "{label}: {err:?}"
        );
    }
}

/// macOS app bundles contain relative links inside frameworks; they must install intact.
#[cfg(unix)]
#[test]
fn bundle_internal_links_are_preserved() -> Result<(), InstallError> {
    let fw = "chrome/App.app/Contents/Frameworks/F.framework";
    let bytes = zip_with_links(
        &[
            ("chrome/chrome", b"#!binary"),
            (&format!("{fw}/Versions/A/F"), b"lib"),
        ],
        &[
            (&format!("{fw}/Versions/Current"), "A"),
            (&format!("{fw}/F"), "Versions/Current/F"),
        ],
    );
    let f = fixture(&bytes);
    let installer = Installer {
        root: f.root.clone(),
        space: &PLENTY,
    };
    let installed = installer.install(
        &LocalFile(f.archive.clone()),
        &artifact_for(&bytes),
        "1.0.0.0",
        &mut |_| {},
    )?;
    let link = installed.path.join(format!("{fw}/F"));
    assert!(fs::symlink_metadata(&link)?.file_type().is_symlink());
    assert_eq!(fs::read(&link)?, b"lib");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&installed.executable)?.permissions().mode() & 0o111,
        0o111,
        "executable bit preserved"
    );
    Ok(())
}

/// Windows only: the installed runtime folder (and files created in it later) is readable by app-container
/// sandboxes, which Chromium's network service needs.
#[cfg(windows)]
#[test]
fn runtime_folder_is_readable_by_app_container_sandboxes() -> io::Result<()> {
    let tmp = tempfile::tempdir()?;
    let dir = tmp.path().join("rt");
    fs::create_dir_all(dir.join("sub"))?;
    fs::write(dir.join("sub").join("chrome.exe"), b"x")?;
    grant_sandbox_access(&dir)?;
    let acl = std::process::Command::new("icacls")
        .arg(dir.join("sub").join("chrome.exe"))
        .output()?;
    let text = String::from_utf8_lossy(&acl.stdout).to_ascii_uppercase();
    assert!(text.contains("ALL APPLICATION PACKAGES"), "{text}");
    assert!(
        text.contains("ALL RESTRICTED APPLICATION PACKAGES"),
        "{text}"
    );
    Ok(())
}
