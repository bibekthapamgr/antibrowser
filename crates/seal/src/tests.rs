#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::format::{CHUNK, MAGIC};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn binding() -> Binding {
    Binding {
        kind: Kind::OrgSnapshot,
        org_id: Some("org_01J9ZSEED0ACME000000000000".into()),
        profile_id: "prf_01J9ZSEED0A0100000000000000".into(),
        object_id: "snp_01M4T7R0Q4FN6G53AWPJQ3CBMK".into(),
        key_version: "okv_01M4T7R0Q4FN6G53AWPJQ3CBMA".into(),
    }
}

fn key() -> SealKey {
    SealKey::generate().unwrap()
}

fn data(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 31 % 251) as u8).collect()
}

/// Offset of the first chunk in a sealed buffer.
fn payload_offset(sealed: &[u8]) -> usize {
    let len = u32::from_be_bytes(sealed[8..12].try_into().unwrap()) as usize;
    12 + len
}

#[test]
fn round_trips_every_chunk_boundary() {
    let k = key();
    for n in [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 5] {
        let plain = data(n);
        let sealed = seal_bytes(&plain, &k, &binding()).unwrap();
        assert_eq!(&sealed[..8], MAGIC);
        // One 16-byte tag per chunk; there is always a last chunk (possibly empty), and a full final chunk is the last.
        let chunks = n.div_ceil(CHUNK).max(1);
        assert_eq!(
            sealed.len(),
            payload_offset(&sealed) + n + 16 * chunks,
            "n={n}"
        );
        assert_eq!(open_bytes(&sealed, &k, &binding()).unwrap(), plain, "n={n}");
    }
}

#[test]
fn the_same_plaintext_seals_differently_each_time() {
    let k = key();
    let a = seal_bytes(b"same", &k, &binding()).unwrap();
    let b = seal_bytes(b"same", &k, &binding()).unwrap();
    assert_ne!(a, b, "random nonce prefix per file");
}

#[test]
fn a_wrong_key_fails_closed() {
    let sealed = seal_bytes(&data(5000), &key(), &binding()).unwrap();
    let err = open_bytes(&sealed, &key(), &binding()).unwrap_err();
    assert!(matches!(err, SealError::Authentication), "{err:?}");
}

#[test]
fn the_opener_checks_every_binding_field() {
    let k = key();
    let sealed = seal_bytes(b"x", &k, &binding()).unwrap();
    let variants: Vec<(&str, Binding)> = vec![
        (
            "kind",
            Binding {
                kind: Kind::LocalBackup,
                ..binding()
            },
        ),
        (
            "org_id",
            Binding {
                org_id: Some("org_01J9ZSEED0BETA000000000000".into()),
                ..binding()
            },
        ),
        (
            "org_id",
            Binding {
                org_id: None,
                ..binding()
            },
        ),
        (
            "profile_id",
            Binding {
                profile_id: "prf_other".into(),
                ..binding()
            },
        ),
        (
            "object_id",
            Binding {
                object_id: "snp_other".into(),
                ..binding()
            },
        ),
        (
            "key_version",
            Binding {
                key_version: "okv_other".into(),
                ..binding()
            },
        ),
    ];
    for (field, expect) in variants {
        match open_bytes(&sealed, &k, &expect) {
            Err(SealError::HeaderMismatch(f)) => assert_eq!(f, field),
            other => panic!("{field}: {other:?}"),
        }
    }
}

#[test]
fn an_edited_header_fails_authentication() {
    // Someone rewrites the header to claim another profile (and asks for that profile): the chunks were authenticated
    // with the original header, so decryption fails.
    let k = key();
    let sealed = seal_bytes(&data(3000), &k, &binding()).unwrap();
    let text = String::from_utf8_lossy(&sealed[12..payload_offset(&sealed)]).into_owned();
    let forged_header = text.replace(
        "prf_01J9ZSEED0A0100000000000000",
        "prf_01J9ZSEED0A0200000000000000",
    );
    assert_eq!(forged_header.len(), text.len());
    let mut forged = sealed[..12].to_vec();
    forged.extend_from_slice(forged_header.as_bytes());
    forged.extend_from_slice(&sealed[payload_offset(&sealed)..]);
    let expect = Binding {
        profile_id: "prf_01J9ZSEED0A0200000000000000".into(),
        ..binding()
    };
    assert!(matches!(
        open_bytes(&forged, &k, &expect),
        Err(SealError::Authentication)
    ));
}

#[test]
fn truncation_reordering_and_bit_flips_fail() {
    let k = key();
    let plain = data(3 * CHUNK + 100);
    let sealed = seal_bytes(&plain, &k, &binding()).unwrap();
    let start = payload_offset(&sealed);
    let c = CHUNK + 16;
    let open = |bytes: &[u8]| open_bytes(bytes, &k, &binding());

    // Truncated at a chunk boundary (the remaining last chunk was not sealed as last) and in the middle of a chunk.
    assert!(open(&sealed[..start + 2 * c]).is_err());
    assert!(open(&sealed[..start + c + 77]).is_err());
    // Only the header.
    assert!(open(&sealed[..start]).is_err());
    // A middle chunk dropped.
    let mut dropped = sealed[..start + c].to_vec();
    dropped.extend_from_slice(&sealed[start + 2 * c..]);
    assert!(open(&dropped).is_err());
    // Two chunks swapped.
    let mut swapped = sealed[..start].to_vec();
    swapped.extend_from_slice(&sealed[start + c..start + 2 * c]);
    swapped.extend_from_slice(&sealed[start..start + c]);
    swapped.extend_from_slice(&sealed[start + 2 * c..]);
    assert!(open(&swapped).is_err());
    // A chunk repeated.
    let mut repeated = sealed[..start + c].to_vec();
    repeated.extend_from_slice(&sealed[start..]);
    assert!(open(&repeated).is_err());
    // Extra bytes appended.
    let mut longer = sealed.clone();
    longer.extend_from_slice(&[0u8; 32]);
    assert!(open(&longer).is_err());
    // One bit flipped anywhere in the payload.
    for at in [start, start + c - 1, start + c, sealed.len() - 1] {
        let mut flipped = sealed.clone();
        flipped[at] ^= 1;
        assert!(open(&flipped).is_err(), "flip at {at}");
    }
    assert_eq!(open(&sealed).unwrap(), plain);
}

#[test]
fn chunks_cannot_be_spliced_between_files() {
    let k = key();
    let a = seal_bytes(&data(2 * CHUNK + 10), &k, &binding()).unwrap();
    let b = seal_bytes(&data(2 * CHUNK + 10), &k, &binding()).unwrap();
    let (sa, sb) = (payload_offset(&a), payload_offset(&b));
    let c = CHUNK + 16;
    let mut spliced = a[..sa + c].to_vec();
    spliced.extend_from_slice(&b[sb + c..]);
    assert!(open_bytes(&spliced, &k, &binding()).is_err());
}

#[test]
fn not_a_sealed_file() {
    assert!(matches!(
        open_bytes(b"PK\x03\x04 a zip file", &key(), &binding()),
        Err(SealError::UnsupportedFormat)
    ));
    let mut bad_len = MAGIC.to_vec();
    bad_len.extend_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(
        open_bytes(&bad_len, &key(), &binding()),
        Err(SealError::UnsupportedFormat)
    ));
}

#[test]
fn key_encoding_and_debug_output() {
    let k = key();
    let again = SealKey::from_base64(&k.to_base64()).unwrap();
    let sealed = seal_bytes(b"k", &k, &binding()).unwrap();
    assert_eq!(open_bytes(&sealed, &again, &binding()).unwrap(), b"k");
    assert_eq!(format!("{k:?}"), "SealKey(..)");
    assert!(SealKey::from_base64("c2hvcnQ=").is_err());
}

// ------------------------------------------------------------------ profile archives

struct Tmp(tempfile::TempDir);
impl Tmp {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn path(&self, p: &str) -> PathBuf {
        self.0.path().join(p)
    }
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn sample_profile(root: &Path) {
    write(&root.join("Local State"), b"{\"profile\":{}}");
    write(&root.join("Default/Cookies"), &data(70_000));
    write(&root.join("Default/Preferences"), b"{}");
    write(
        &root.join("Default/Local Storage/leveldb/000003.log"),
        &data(CHUNK + 3),
    );
    write(
        &root.join("Default/IndexedDB/https_example.test_0.indexeddb.leveldb/CURRENT"),
        b"MANIFEST-1\n",
    );
    write(&root.join("Default/empty.bin"), b"");
    let long = "x".repeat(120);
    write(
        &root.join(format!("Default/{long}/{long}.dat")),
        b"long path",
    );
    // Excluded at any depth.
    write(&root.join("Default/Cache/Cache_Data/data_0"), b"cache");
    write(&root.join("Default/Code Cache/js/index"), b"cache");
    write(&root.join("Crashpad/reports/1.dmp"), b"dump");
    write(&root.join("SingletonLock"), b"lock");
    write(&root.join("Default/lockfile"), b"lock");
    write(&root.join("Default/Preferences.pb-tmp"), b"tmp");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", root.join("Default/link")).unwrap();
}

fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn go(dir: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = format!("{rel}/{}", e.file_name().to_string_lossy());
            let ft = e.file_type().unwrap();
            if ft.is_dir() {
                out.push((format!("{name}/"), vec![]));
                go(&e.path(), &name, out);
            } else if ft.is_file() {
                out.push((name, fs::read(e.path()).unwrap()));
            }
        }
    }
    let mut out = vec![];
    go(root, "", &mut out);
    out
}

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

#[test]
fn a_profile_round_trips_without_excluded_files_or_links() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let k = key();
    let out = t.path("snap.pbseal");
    let mut last = 0;
    let sealed = seal_profile(
        &src,
        &[Member {
            name: "snapshot.json",
            bytes: b"{\"schema\":1}",
        }],
        &k,
        &binding(),
        &out,
        &no_cancel(),
        &mut |b| last = b,
    )
    .unwrap();
    assert_eq!(sealed.stats.files, 5 + 1 + 1); // Local State, Cookies, Preferences, log, CURRENT, empty, long
    assert_eq!(sealed.stats.bytes, last);
    #[cfg(unix)]
    assert_eq!(sealed.stats.skipped_links, 1);
    assert_eq!(
        digest_file(&out).unwrap(),
        (sealed.digest.clone(), sealed.sealed_bytes)
    );
    assert_eq!(
        read_file_header(&out).unwrap().object_id,
        binding().object_id
    );
    let raw = fs::read(&out).unwrap();
    assert!(
        !raw.windows(9).any(|w| w == b"Preferenc"),
        "file names are inside the encrypted payload"
    );

    let dest = t.path("dest");
    fs::create_dir(&dest).unwrap();
    let opened = open_profile(
        &out,
        &k,
        &binding(),
        &dest,
        &Limits::default(),
        &no_cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        opened.meta.get("snapshot.json").map(Vec::as_slice),
        Some(&b"{\"schema\":1}"[..])
    );
    assert_eq!(opened.files, sealed.stats.files);
    assert_eq!(opened.bytes, sealed.stats.bytes);

    let mut expected = tree(&src);
    expected.retain(|(name, _)| {
        !["/Default/Cache/", "/Default/Code Cache/", "/Crashpad/"]
            .iter()
            .any(|x| name.starts_with(x))
            && !name.ends_with("SingletonLock")
            && !name.ends_with("lockfile")
            && !name.ends_with(".pb-tmp")
    });
    assert_eq!(tree(&dest.join("user-data")), expected);
}

#[test]
fn opening_needs_the_right_key_and_binding_and_leaves_nothing_usable_on_failure() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let k = key();
    let out = t.path("snap.pbseal");
    seal_profile(&src, &[], &k, &binding(), &out, &no_cancel(), &mut |_| {}).unwrap();
    for (n, (kk, expect)) in [
        (key(), binding()),
        (
            k.clone(),
            Binding {
                org_id: Some("org_01J9ZSEED0BETA000000000000".into()),
                ..binding()
            },
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let dest = t.path(&format!("bad{n}"));
        fs::create_dir(&dest).unwrap();
        assert!(
            open_profile(
                &out,
                &kk,
                &expect,
                &dest,
                &Limits::default(),
                &no_cancel(),
                &mut |_| {}
            )
            .is_err()
        );
    }
    // A flipped byte near the end: files may already have been written to the fresh directory, but the open fails,
    // so the caller discards it (restores never switch to a directory whose open failed).
    let mut bytes = fs::read(&out).unwrap();
    let n = bytes.len();
    bytes[n - 5] ^= 0x40;
    let tampered = t.path("tampered.pbseal");
    fs::write(&tampered, &bytes).unwrap();
    let dest = t.path("tampered-dest");
    fs::create_dir(&dest).unwrap();
    assert!(matches!(
        open_profile(
            &tampered,
            &k,
            &binding(),
            &dest,
            &Limits::default(),
            &no_cancel(),
            &mut |_| {}
        ),
        Err(SealError::Authentication)
    ));
}

#[test]
fn destination_must_be_empty_and_limits_hold() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let k = key();
    let out = t.path("snap.pbseal");
    seal_profile(&src, &[], &k, &binding(), &out, &no_cancel(), &mut |_| {}).unwrap();
    let busy = t.path("busy");
    write(&busy.join("x"), b"x");
    assert!(matches!(
        open_profile(
            &out,
            &k,
            &binding(),
            &busy,
            &Limits::default(),
            &no_cancel(),
            &mut |_| {}
        ),
        Err(SealError::DestinationNotEmpty)
    ));
    for limits in [
        Limits {
            max_files: 3,
            max_bytes: u64::MAX,
        },
        Limits {
            max_files: 100,
            max_bytes: 1000,
        },
    ] {
        let dest = t.path(&format!("lim{}", limits.max_files));
        fs::create_dir(&dest).unwrap();
        assert!(matches!(
            open_profile(
                &out,
                &k,
                &binding(),
                &dest,
                &limits,
                &no_cancel(),
                &mut |_| {}
            ),
            Err(SealError::LimitExceeded)
        ));
    }
}

#[test]
fn cancelling_a_seal_removes_the_partial_file() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let out = t.path("snap.pbseal");
    let cancel = AtomicBool::new(true);
    assert!(matches!(
        seal_profile(&src, &[], &key(), &binding(), &out, &cancel, &mut |_| {}),
        Err(SealError::Cancelled)
    ));
    assert!(!out.exists());
    // An existing file is never overwritten.
    fs::write(&out, b"keep").unwrap();
    assert!(
        seal_profile(
            &src,
            &[],
            &key(),
            &binding(),
            &out,
            &no_cancel(),
            &mut |_| {}
        )
        .is_err()
    );
    assert_eq!(fs::read(&out).unwrap(), b"keep");
}

/// Builds a sealed file around a hand-made tar stream (an attacker who somehow holds the key, or a buggy writer):
/// extraction must still refuse anything unsafe.
fn sealed_tar(entries: &[(&[u8], tar::EntryType, &[u8])], k: &SealKey) -> Vec<u8> {
    let mut tar_bytes = Vec::new();
    {
        let mut b = tar::Builder::new(&mut tar_bytes);
        for (name, kind, body) in entries {
            let mut h = tar::Header::new_gnu();
            {
                let raw = h.as_old_mut();
                raw.name[..name.len()].copy_from_slice(name);
            }
            h.set_entry_type(*kind);
            h.set_size(body.len() as u64);
            h.set_mode(0o644);
            if *kind == tar::EntryType::Symlink || *kind == tar::EntryType::Link {
                h.set_link_name("/etc/passwd").unwrap();
            }
            h.set_cksum();
            b.append(&h, *body).unwrap();
        }
        b.finish().unwrap();
    }
    let compressed = zstd::stream::encode_all(&tar_bytes[..], 3).unwrap();
    seal_bytes(&compressed, k, &binding()).unwrap()
}

#[test]
fn unsafe_archives_are_refused() {
    use tar::EntryType as E;
    let t = Tmp::new();
    let k = key();
    type Case<'a> = (&'a str, Vec<(&'a [u8], E, &'a [u8])>);
    let cases: Vec<Case<'_>> = vec![
        ("absolute", vec![(b"/etc/evil", E::Regular, b"x")]),
        ("parent", vec![(b"user-data/../../evil", E::Regular, b"x")]),
        ("symlink", vec![(b"user-data/link", E::Symlink, b"")]),
        ("hardlink", vec![(b"user-data/hard", E::Link, b"")]),
        ("fifo", vec![(b"user-data/fifo", E::Fifo, b"")]),
        ("device", vec![(b"user-data/dev", E::Char, b"")]),
        ("unknown top", vec![(b"other/x", E::Regular, b"x")]),
        ("meta dir", vec![(b"meta/sub/x", E::Regular, b"x")]),
        ("meta name", vec![(b"meta/evil.json", E::Regular, b"x")]),
        ("colon", vec![(b"user-data/a:b", E::Regular, b"x")]),
        ("backslash", vec![(b"user-data/a\\..\\b", E::Regular, b"x")]),
        ("windows device", vec![(b"user-data/NUL", E::Regular, b"x")]),
        (
            "windows device with extension",
            vec![(b"user-data/com1.txt", E::Regular, b"x")],
        ),
        ("trailing dot", vec![(b"user-data/name.", E::Regular, b"x")]),
        (
            "duplicate",
            vec![
                (b"user-data/a", E::Regular, b"1"),
                (b"user-data/a", E::Regular, b"2"),
            ],
        ),
        ("file as root", vec![(b"user-data", E::Regular, b"x")]),
    ];
    for (n, (label, entries)) in cases.into_iter().enumerate() {
        let sealed = sealed_tar(&entries, &k);
        let file = t.path(&format!("case{n}.pbseal"));
        fs::write(&file, sealed).unwrap();
        let dest = t.path(&format!("case{n}"));
        fs::create_dir(&dest).unwrap();
        let r = open_profile(
            &file,
            &k,
            &binding(),
            &dest,
            &Limits::default(),
            &no_cancel(),
            &mut |_| {},
        );
        assert!(
            matches!(r, Err(SealError::UnsafeArchive(_))),
            "{label}: {r:?}"
        );
        assert!(
            !t.path("evil").exists() && !Path::new("/etc/evil").exists(),
            "{label}"
        );
    }
    // Oversized metadata.
    let big = vec![b'x'; (archive::MAX_META_BYTES + 1) as usize];
    let sealed = sealed_tar(&[(b"meta/snapshot.json", E::Regular, &big)], &k);
    let file = t.path("bigmeta.pbseal");
    fs::write(&file, sealed).unwrap();
    let dest = t.path("bigmeta");
    fs::create_dir(&dest).unwrap();
    assert!(matches!(
        open_profile(
            &file,
            &k,
            &binding(),
            &dest,
            &Limits::default(),
            &no_cancel(),
            &mut |_| {}
        ),
        Err(SealError::UnsafeArchive(_))
    ));
}

#[test]
fn packing_refuses_unknown_metadata_members() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let out = t.path("snap.pbseal");
    assert!(matches!(
        seal_profile(
            &src,
            &[Member {
                name: "../x",
                bytes: b""
            }],
            &key(),
            &binding(),
            &out,
            &no_cancel(),
            &mut |_| {}
        ),
        Err(SealError::UnsafeArchive(_))
    ));
}

#[test]
fn measure_matches_what_is_stored() {
    let t = Tmp::new();
    let src = t.path("src");
    sample_profile(&src);
    let out = t.path("snap.pbseal");
    let sealed = seal_profile(
        &src,
        &[],
        &key(),
        &binding(),
        &out,
        &no_cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(archive::measure(&src).unwrap(), sealed.stats.bytes);
}
