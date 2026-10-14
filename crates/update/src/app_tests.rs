#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Manager update checks (milestone 12): signatures and key validity, manifest freshness and replay, rollback and
//! revocation, interrupted/corrupt/wrongly signed downloads, and the macOS bundle swap.

use super::*;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

const NOW: i64 = 1_791_000_000; // 2026-10-03T04:00:00Z
const DAY: i64 = 86_400;

type Tweak = Box<dyn FnOnce(&mut serde_json::Value)>;
/// (path, file content, symlink target)
type Entry = (String, Option<String>, Option<String>);

struct Key {
    kp: minisign::KeyPair,
    pub_b64: String,
    key_id: String,
}

fn key() -> Key {
    let kp = minisign::KeyPair::generate_unencrypted_keypair().expect("keypair");
    let text = kp.pk.to_box().expect("pk box").to_string();
    let line = text.lines().nth(1).expect("key line").to_owned();
    Key {
        key_id: key_id_of(&line).expect("key id"),
        pub_b64: B64.encode(text),
        kp,
    }
}

fn sign(k: &Key, data: &[u8], comment: &str) -> String {
    let sb = minisign::sign(
        Some(&k.kp.pk),
        &k.kp.sk,
        Cursor::new(data),
        Some(comment),
        Some("signature from tauri secret key"),
    )
    .expect("sign");
    B64.encode(sb.to_string())
}

fn keys_json(entries: &[(&Key, &str, &str)]) -> String {
    let list: Vec<_> = entries
        .iter()
        .map(|(k, nb, na)| {
            serde_json::json!({ "key_id": k.key_id, "public_key": k.pub_b64, "not_before": nb, "not_after": na })
        })
        .collect();
    serde_json::json!({ "keys": list }).to_string()
}

fn trusted(k: &Key) -> ReleaseKeys {
    ReleaseKeys::parse(&keys_json(&[(k, "2026-01-01", "2030-01-01")])).expect("keys")
}

fn iso(t: i64) -> String {
    // Enough for the tests: whole days from the epoch reference used here.
    let base = parse_utc("2026-10-03T04:00:00Z").expect("base");
    let d = (t - base) / DAY;
    let day = 3 + d; // October 2026 has 31 days; keep tests inside October/November
    if day <= 31 {
        format!("2026-10-{day:02}T04:00:00Z")
    } else {
        format!("2026-11-{:02}T04:00:00Z", day - 31)
    }
}

const ART_URL: &str = "https://github.com/bibekthapamgr/antibrowser/releases/download/desktop-v0.12.1/Project.Browser_0.12.1_x64-setup.exe";

fn artifact_bytes() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 251) as u8).collect()
}

fn manifest(
    k: &Key,
    seq: u64,
    version: &str,
    tweak: impl FnOnce(&mut serde_json::Value),
) -> (Vec<u8>, String) {
    let bytes = artifact_bytes();
    let art_sig = sign(
        k,
        &bytes,
        &format!(
            "timestamp:{NOW}\tfile:Project.Browser_{version}_x64-setup.exe\tversion:{version}"
        ),
    );
    let url = ART_URL.replace("0.12.1", version);
    let mut m = serde_json::json!({
        "schema": 1,
        "product": PRODUCT,
        "channel": "stable",
        "sequence": seq,
        "issued_at": iso(NOW - DAY),
        "expires_at": iso(NOW + 30 * DAY),
        "paused": false,
        "minimum_version": "0.11.0",
        "revoked_versions": [],
        "revoked_runtime_sha256": [],
        "release": {
            "version": version,
            "published_at": iso(NOW - DAY),
            "notes_url": format!("https://github.com/bibekthapamgr/antibrowser/releases/tag/desktop-v{version}"),
            "artifacts": [{
                "platform": "windows-x64",
                "kind": "nsis",
                "url": url,
                "sha256": hex::encode(Sha256::digest(&bytes)),
                "size_bytes": bytes.len(),
                "signature": art_sig,
            }]
        }
    });
    tweak(&mut m);
    let body = serde_json::to_vec_pretty(&m).expect("json");
    let sig = sign(k, &body, &format!("timestamp:{NOW}\tfile:stable.json"));
    (body, sig)
}

// ------------------------------------------------------------------------------------------------ keys and time
#[test]
fn utc_parsing() {
    assert_eq!(parse_utc("1970-01-01"), Some(0));
    assert_eq!(parse_utc("2026-10-14T06:00:00Z"), Some(1_791_957_600));
    assert_eq!(parse_utc("2026-10-14T06:00:00.123Z"), Some(1_791_957_600));
    for bad in [
        "2026-13-01",
        "2026-10-14T06:00:00",
        "2026-10-14 06:00:00Z",
        "x",
        "2026-10-14T06:00:00+09:00",
    ] {
        assert_eq!(parse_utc(bad), None, "{bad}");
    }
}

#[test]
fn release_keys_must_match_their_id_and_have_a_window() {
    let a = key();
    let b = key();
    let mismatched = serde_json::json!({ "keys": [{ "key_id": b.key_id, "public_key": a.pub_b64,
        "not_before": "2026-01-01", "not_after": "2030-01-01" }] })
    .to_string();
    assert!(matches!(
        ReleaseKeys::parse(&mismatched),
        Err(AppUpdateError::Invalid(_))
    ));
    let empty_window = keys_json(&[(&a, "2030-01-01", "2026-01-01")]);
    assert!(ReleaseKeys::parse(&empty_window).is_err());
    assert!(
        ReleaseKeys::parse(r#"{"keys":[]}"#)
            .expect("empty")
            .is_empty()
    );
}

#[test]
fn manifest_signature_key_and_file_are_checked() {
    let k = key();
    let keys = trusted(&k);
    let (body, sig) = manifest(&k, 10, "0.12.1", |_| {});
    assert!(verify_channel_manifest(&body, &sig, &keys, NOW).is_ok());

    // Tampered: one byte changed.
    let mut evil = body.clone();
    let i = evil.iter().position(|b| *b == b'1').expect("digit");
    evil[i] = b'9';
    assert_eq!(
        verify_channel_manifest(&evil, &sig, &keys, NOW),
        Err(AppUpdateError::BadSignature)
    );

    // Signed by a key this build does not trust.
    let other = key();
    let (body2, sig2) = manifest(&other, 10, "0.12.1", |_| {});
    assert_eq!(
        verify_channel_manifest(&body2, &sig2, &keys, NOW),
        Err(AppUpdateError::BadSignature)
    );

    // The trusted key has expired (like an expired signing certificate).
    let expired =
        ReleaseKeys::parse(&keys_json(&[(&k, "2025-01-01", "2026-06-30")])).expect("keys");
    assert_eq!(
        verify_channel_manifest(&body, &sig, &expired, NOW),
        Err(AppUpdateError::KeyExpired("2026-06-30".into()))
    );

    // A valid signature for the canary file served as the stable one.
    let canary_sig = sign(&k, &body, &format!("timestamp:{NOW}\tfile:canary.json"));
    assert!(matches!(
        verify_channel_manifest(&body, &canary_sig, &keys, NOW),
        Err(AppUpdateError::Invalid(_))
    ));

    // Garbage signature text.
    assert_eq!(
        verify_channel_manifest(&body, "not base64!", &keys, NOW),
        Err(AppUpdateError::BadSignature)
    );
    // No keys in this build.
    let none = ReleaseKeys::parse(r#"{"keys":[]}"#).expect("empty");
    assert_eq!(
        verify_channel_manifest(&body, &sig, &none, NOW),
        Err(AppUpdateError::NoKeys)
    );
}

#[test]
fn manifest_structure_is_strict() {
    let k = key();
    let keys = trusted(&k);
    let cases: Vec<Tweak> = vec![
        Box::new(|m| m["extra"] = serde_json::json!(1)),
        Box::new(|m| m["product"] = serde_json::json!("something-else")),
        Box::new(|m| m["channel"] = serde_json::json!("nightly")),
        Box::new(|m| m["expires_at"] = serde_json::json!("2027-05-01T00:00:00Z")),
        Box::new(|m| {
            m["release"]["artifacts"][0]["url"] = serde_json::json!("https://evil.example/x.exe")
        }),
        Box::new(|m| {
            m["release"]["artifacts"][0]["url"] = serde_json::json!(
                "https://github.com/bibekthapamgr/antibrowser/releases/download/a/../b/x.exe"
            )
        }),
        Box::new(|m| m["release"]["artifacts"][0]["kind"] = serde_json::json!("msi")),
        Box::new(|m| m["release"]["artifacts"][0]["sha256"] = serde_json::json!("ABC")),
        Box::new(|m| m["release"]["version"] = serde_json::json!("latest")),
        Box::new(|m| m["sequence"] = serde_json::json!(0)),
    ];
    for (i, tweak) in cases.into_iter().enumerate() {
        let (body, sig) = manifest(&k, 10, "0.12.1", tweak);
        assert!(
            matches!(
                verify_channel_manifest(&body, &sig, &keys, NOW),
                Err(AppUpdateError::Invalid(_))
            ),
            "case {i}"
        );
    }
}

// ------------------------------------------------------------------------------------------------ evaluation
fn assess(
    m: &ChannelManifest,
    current: &str,
    last: Option<u64>,
    now: i64,
) -> Result<Assessment, AppUpdateError> {
    evaluate(m, "stable", current, "windows-x64", last, now)
}

fn parsed(
    k: &Key,
    seq: u64,
    version: &str,
    tweak: impl FnOnce(&mut serde_json::Value),
) -> ChannelManifest {
    let (body, sig) = manifest(k, seq, version, tweak);
    verify_channel_manifest(&body, &sig, &trusted(k), NOW).expect("valid")
}

#[test]
fn offers_only_newer_safe_versions_and_never_rolls_back() {
    let k = key();
    let m = parsed(&k, 10, "0.12.1", |_| {});
    let a = assess(&m, "0.12.0", None, NOW).expect("ok");
    assert_eq!(a.offer.as_ref().map(|o| o.version.as_str()), Some("0.12.1"));
    assert_eq!(a.current_blocked, None);
    // Same or newer installed: nothing to do, and an older release is never offered (no rollback).
    assert!(assess(&m, "0.12.1", None, NOW).expect("ok").offer.is_none());
    assert!(assess(&m, "0.13.0", None, NOW).expect("ok").offer.is_none());
    // No artifact for this platform.
    assert!(
        evaluate(&m, "stable", "0.12.0", "macos-arm64", None, NOW)
            .expect("ok")
            .offer
            .is_none()
    );
    // Paused distribution.
    let paused = parsed(&k, 11, "0.12.1", |m| m["paused"] = serde_json::json!(true));
    let a = assess(&paused, "0.12.0", None, NOW).expect("ok");
    assert!(a.paused && a.offer.is_none());
    // A revoked release is never installed.
    let revoked = parsed(&k, 12, "0.12.1", |m| {
        m["revoked_versions"] = serde_json::json!(["0.12.1"])
    });
    assert!(
        assess(&revoked, "0.12.0", None, NOW)
            .expect("ok")
            .offer
            .is_none()
    );
}

#[test]
fn known_vulnerable_versions_are_told_to_update() {
    let k = key();
    let m = parsed(&k, 10, "0.12.1", |m| {
        m["minimum_version"] = serde_json::json!("0.12.1");
        m["revoked_versions"] = serde_json::json!(["0.11.5"]);
    });
    let a = assess(&m, "0.12.0", None, NOW).expect("ok");
    assert_eq!(
        a.current_blocked,
        Some(Blocked::BelowMinimum {
            minimum_version: "0.12.1".into()
        })
    );
    assert!(a.offer.is_some());
    assert_eq!(
        assess(&m, "0.11.5", None, NOW).expect("ok").current_blocked,
        Some(Blocked::Revoked)
    );
}

#[test]
fn stale_and_replayed_manifests_are_refused() {
    let k = key();
    let m = parsed(&k, 10, "0.12.1", |_| {});
    // Expired.
    assert!(matches!(
        assess(&m, "0.12.0", None, NOW + 40 * DAY),
        Err(AppUpdateError::Expired(_))
    ));
    // Replay of an older manifest after a newer one was accepted (e.g. to hide a revocation).
    assert_eq!(
        assess(&m, "0.12.0", Some(11), NOW),
        Err(AppUpdateError::Replayed { seen: 11, got: 10 })
    );
    // The same manifest again is fine.
    assert!(assess(&m, "0.12.0", Some(10), NOW).is_ok());
    // Issued in the future beyond the clock tolerance.
    assert!(matches!(
        assess(&m, "0.12.0", None, NOW - 2 * DAY),
        Err(AppUpdateError::Invalid(_))
    ));
    // Another channel's manifest.
    assert!(matches!(
        evaluate(&m, "canary", "0.12.0", "windows-x64", None, NOW),
        Err(AppUpdateError::Invalid(_))
    ));
}

#[test]
fn state_keeps_the_highest_sequence() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("state.json");
    let k = key();
    let mut st = UpdateState::load(&path);
    st.accept(&assess(&parsed(&k, 12, "0.12.1", |_| {}), "0.12.0", None, NOW).expect("ok"));
    st.accept(&assess(&parsed(&k, 9, "0.12.1", |_| {}), "0.12.0", None, NOW).expect("ok"));
    st.save(&path).expect("save");
    assert_eq!(UpdateState::load(&path).sequences.get("stable"), Some(&12));
    // A damaged state file reads as empty (and only weakens replay protection to "first seen").
    std::fs::write(&path, b"{").expect("write");
    assert_eq!(UpdateState::load(&path), UpdateState::default());
}

// ------------------------------------------------------------------------------------------------ download
#[derive(Default)]
struct MemTransport {
    files: HashMap<String, Vec<u8>>,
    /// The next `open_from` fails after this many bytes (an interrupted connection).
    fail_after: Mutex<Option<usize>>,
    ignore_range: bool,
    opens: Mutex<Vec<u64>>,
}

struct Failing {
    inner: Cursor<Vec<u8>>,
    left: usize,
}

impl Read for Failing {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection reset",
            ));
        }
        let n = buf.len().min(self.left);
        let got = self.inner.read(&mut buf[..n])?;
        self.left -= got;
        Ok(got)
    }
}

impl Transport for MemTransport {
    fn get(&self, url: &str, max: u64) -> io::Result<Vec<u8>> {
        let b = self
            .files
            .get(url)
            .cloned()
            .ok_or_else(|| io::Error::other("404"))?;
        if b.len() as u64 > max {
            return Err(io::Error::other("too large"));
        }
        Ok(b)
    }

    fn open_from(&self, url: &str, offset: u64) -> io::Result<(Box<dyn Read + Send>, u64)> {
        self.opens.lock().expect("lock").push(offset);
        let b = self
            .files
            .get(url)
            .cloned()
            .ok_or_else(|| io::Error::other("404"))?;
        let start = if self.ignore_range {
            0
        } else {
            offset as usize
        };
        let body = b[start.min(b.len())..].to_vec();
        if let Some(n) = self.fail_after.lock().expect("lock").take() {
            return Ok((
                Box::new(Failing {
                    inner: Cursor::new(body),
                    left: n,
                }),
                start as u64,
            ));
        }
        Ok((Box::new(Cursor::new(body)), start as u64))
    }
}

fn offer_for(k: &Key, version: &str) -> Offer {
    let m = parsed(k, 10, version, |_| {});
    assess(&m, "0.12.0", None, NOW)
        .expect("ok")
        .offer
        .expect("offer")
}

fn transport_with(offer: &Offer, bytes: Vec<u8>) -> MemTransport {
    let mut t = MemTransport::default();
    t.files.insert(offer.artifact.url.clone(), bytes);
    t
}

#[test]
fn downloads_verify_and_resume_after_an_interruption() {
    let k = key();
    let keys = trusted(&k);
    let offer = offer_for(&k, "0.12.1");
    let dir = tempfile::tempdir().expect("dir");
    let t = transport_with(&offer, artifact_bytes());
    *t.fail_after.lock().expect("lock") = Some(100_000);
    let cancel = AtomicBool::new(false);
    let mut seen = Vec::new();
    let first = download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |d, _| {
        seen.push(d)
    });
    assert!(matches!(first, Err(AppUpdateError::Download(_))));
    assert!(
        !dir.path().join(offer.artifact.file_name()).exists(),
        "nothing unverified is kept as final"
    );
    // The next attempt continues from the interruption, then verifies.
    let ok = download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {})
        .expect("downloaded");
    assert_eq!(*t.opens.lock().expect("lock"), vec![0, 100_000]);
    assert_eq!(ok.version, "0.12.1");
    assert_eq!(std::fs::read(&ok.path).expect("read"), artifact_bytes());
    // Downloading again finds the verified file without a transfer.
    let again = download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {})
        .expect("again");
    assert_eq!(again.path, ok.path);
    assert_eq!(t.opens.lock().expect("lock").len(), 2);
}

#[test]
fn a_server_that_ignores_the_range_restarts_the_file() {
    let k = key();
    let keys = trusted(&k);
    let offer = offer_for(&k, "0.12.1");
    let dir = tempfile::tempdir().expect("dir");
    let mut t = transport_with(&offer, artifact_bytes());
    t.ignore_range = true;
    *t.fail_after.lock().expect("lock") = Some(50_000);
    let cancel = AtomicBool::new(false);
    assert!(
        download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {}).is_err()
    );
    let ok =
        download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {}).expect("ok");
    assert_eq!(std::fs::read(ok.path).expect("read"), artifact_bytes());
}

#[test]
fn corrupt_oversized_and_wrongly_signed_downloads_are_discarded() {
    let k = key();
    let keys = trusted(&k);
    let offer = offer_for(&k, "0.12.1");
    let cancel = AtomicBool::new(false);
    let leftovers = |d: &Path| std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0);

    // Corrupt: same size, different bytes.
    let dir = tempfile::tempdir().expect("dir");
    let mut bad = artifact_bytes();
    bad[1234] ^= 0xff;
    let t = transport_with(&offer, bad);
    assert_eq!(
        download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {}),
        Err(AppUpdateError::Corrupt)
    );
    assert_eq!(leftovers(dir.path()), 0);

    // Oversized: more bytes than the manifest says.
    let dir = tempfile::tempdir().expect("dir");
    let mut big = artifact_bytes();
    big.extend_from_slice(&[0; 10]);
    let t = transport_with(&offer, big);
    assert_eq!(
        download_verified(&t, &keys, &offer, dir.path(), NOW, &cancel, &mut |_, _| {}),
        Err(AppUpdateError::Corrupt)
    );
    assert_eq!(leftovers(dir.path()), 0);

    // Right bytes and digest, but the Tauri signature is from another key (signature mismatch).
    let other = key();
    let mut wrong = offer.clone();
    wrong.artifact.signature = sign(
        &other,
        &artifact_bytes(),
        &format!(
            "timestamp:{NOW}\tfile:{}\tversion:0.12.1",
            offer.artifact.file_name()
        ),
    );
    let dir = tempfile::tempdir().expect("dir");
    let t = transport_with(&wrong, artifact_bytes());
    assert_eq!(
        download_verified(&t, &keys, &wrong, dir.path(), NOW, &cancel, &mut |_, _| {}),
        Err(AppUpdateError::BadSignature)
    );
    assert_eq!(leftovers(dir.path()), 0);

    // Signed by the right key for another version (a signature reused across releases).
    let mut reused = offer.clone();
    reused.artifact.signature = sign(
        &k,
        &artifact_bytes(),
        &format!(
            "timestamp:{NOW}\tfile:{}\tversion:0.11.0",
            offer.artifact.file_name()
        ),
    );
    let dir = tempfile::tempdir().expect("dir");
    let t = transport_with(&reused, artifact_bytes());
    assert_eq!(
        download_verified(&t, &keys, &reused, dir.path(), NOW, &cancel, &mut |_, _| {}),
        Err(AppUpdateError::BadSignature)
    );
}

#[test]
fn cancelling_keeps_the_part_for_later() {
    let k = key();
    let keys = trusted(&k);
    let offer = offer_for(&k, "0.12.1");
    let dir = tempfile::tempdir().expect("dir");
    let t = transport_with(&offer, artifact_bytes());
    let cancel = AtomicBool::new(false);
    let r = download_verified(
        &t,
        &keys,
        &offer,
        dir.path(),
        NOW,
        &cancel,
        &mut |done, _| {
            if done > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    );
    assert_eq!(r, Err(AppUpdateError::Cancelled));
    assert!(
        dir.path()
            .join(format!("{}.part", offer.artifact.file_name()))
            .exists()
    );
}

#[test]
fn check_channel_fetches_verifies_and_judges() {
    let k = key();
    let keys = trusted(&k);
    let (body, sig) = manifest(&k, 10, "0.12.1", |_| {});
    let mut t = MemTransport::default();
    t.files.insert(manifest_url("stable"), body);
    t.files.insert(signature_url("stable"), sig.into_bytes());
    let st = UpdateState::default();
    let a = check_channel(&t, &keys, "stable", "0.12.0", "windows-x64", &st, NOW).expect("ok");
    assert_eq!(a.sequence, 10);
    assert!(matches!(
        check_channel(&t, &keys, "canary", "0.12.0", "windows-x64", &st, NOW),
        Err(AppUpdateError::Download(_))
    ));
    assert!(matches!(
        check_channel(&t, &keys, "nightly", "0.12.0", "windows-x64", &st, NOW),
        Err(AppUpdateError::Invalid(_))
    ));
}

// ------------------------------------------------------------------------------------------------ macOS bundle
fn plist(version: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><plist><dict>\n<key>CFBundleIdentifier</key>\n<string>{BUNDLE_ID}</string>\n\
         <key>CFBundleShortVersionString</key>\n<string>{version}</string>\n</dict></plist>"
    )
}

fn app_archive(path: &Path, entries: &[(&str, Option<&str>, Option<&str>)]) {
    // (path, file content, symlink target)
    let f = std::fs::File::create(path).expect("create");
    let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    for (p, content, link) in entries {
        let mut h = tar::Header::new_gnu();
        if let Some(target) = link {
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_size(0);
            h.set_mode(0o755);
            b.append_link(&mut h, p, target).expect("link");
        } else if let Some(c) = content {
            h.set_entry_type(tar::EntryType::Regular);
            h.set_size(c.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, p, c.as_bytes()).expect("file");
        } else {
            h.set_entry_type(tar::EntryType::Directory);
            h.set_size(0);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, p, &[][..]).expect("dir");
        }
    }
    b.into_inner().expect("tar").finish().expect("gz");
}

fn good_entries(version: &str) -> Vec<Entry> {
    vec![
        ("Project Browser.app/".into(), None, None),
        (
            "Project Browser.app/Contents/Info.plist".into(),
            Some(plist(version)),
            None,
        ),
        (
            "Project Browser.app/Contents/MacOS/pb-desktop".into(),
            Some("#!binary".into()),
            None,
        ),
        (
            "Project Browser.app/Contents/Frameworks/X.framework/Versions/A/X".into(),
            Some("lib".into()),
            None,
        ),
        (
            "Project Browser.app/Contents/Frameworks/X.framework/Versions/Current".into(),
            None,
            Some("A".into()),
        ),
    ]
}

fn write_archive(path: &Path, entries: &[Entry]) {
    let refs: Vec<(&str, Option<&str>, Option<&str>)> = entries
        .iter()
        .map(|(p, c, l)| (p.as_str(), c.as_deref(), l.as_deref()))
        .collect();
    app_archive(path, &refs);
}

#[test]
fn macos_bundle_is_replaced_only_by_the_signed_version() {
    let dir = tempfile::tempdir().expect("dir");
    let bundle = dir.path().join("Project Browser.app");
    std::fs::create_dir_all(bundle.join("Contents/MacOS")).expect("mk");
    std::fs::write(bundle.join("Contents/Info.plist"), plist("0.12.0")).expect("plist");
    std::fs::write(bundle.join("Contents/MacOS/pb-desktop"), "old").expect("exe");

    // The archive claims another version than the signed one: refused, the installed app untouched.
    let wrong = dir.path().join("wrong.tar.gz");
    write_archive(&wrong, &good_entries("0.12.2"));
    assert!(install_app_bundle(&wrong, &bundle, "0.12.1").is_err());
    assert_eq!(
        std::fs::read_to_string(bundle.join("Contents/MacOS/pb-desktop")).expect("r"),
        "old"
    );

    let good = dir.path().join("good.tar.gz");
    write_archive(&good, &good_entries("0.12.1"));
    install_app_bundle(&good, &bundle, "0.12.1").expect("installed");
    assert_eq!(
        std::fs::read_to_string(bundle.join("Contents/MacOS/pb-desktop")).expect("r"),
        "#!binary"
    );
    #[cfg(unix)]
    assert!(
        bundle
            .join("Contents/Frameworks/X.framework/Versions/Current")
            .symlink_metadata()
            .expect("link")
            .file_type()
            .is_symlink()
    );
    // No staging or previous copy is left next to the app.
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .expect("ls")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!names.iter().any(|n| n.contains("update-")), "{names:?}");
}

#[test]
fn hostile_archives_are_refused() {
    let dir = tempfile::tempdir().expect("dir");
    let cases: Vec<Vec<Entry>> = vec![
        // A symlink that points outside the bundle.
        {
            let mut e = good_entries("0.12.1");
            e.push((
                "Project Browser.app/Contents/escape".into(),
                None,
                Some("../../../etc".into()),
            ));
            e
        },
        // An absolute symlink.
        {
            let mut e = good_entries("0.12.1");
            e.push((
                "Project Browser.app/Contents/abs".into(),
                None,
                Some("/etc/passwd".into()),
            ));
            e
        },
        // Two bundles.
        {
            let mut e = good_entries("0.12.1");
            e.push(("Other.app/Contents/x".into(), Some("x".into()), None));
            e
        },
        // Not an app bundle.
        vec![("payload/run.sh".into(), Some("x".into()), None)],
    ];
    for (i, entries) in cases.iter().enumerate() {
        let archive = dir.path().join(format!("case{i}.tar.gz"));
        write_archive(&archive, entries);
        let staging = dir.path().join(format!("staging{i}"));
        assert!(
            matches!(
                extract_app_archive(&archive, &staging),
                Err(AppUpdateError::Install(_))
            ),
            "case {i}"
        );
    }
}

#[test]
fn downloads_folder_is_cleaned_except_the_kept_file() {
    let dir = tempfile::tempdir().expect("dir");
    for n in ["old.exe", "x.part", "state.json", "keep.exe"] {
        std::fs::write(dir.path().join(n), b"x").expect("w");
    }
    clean_downloads(dir.path(), Some(&dir.path().join("keep.exe")));
    let mut left: Vec<_> = std::fs::read_dir(dir.path())
        .expect("ls")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, vec!["keep.exe", "state.json"]);
}

// ------------------------------------------------------------------------------------------------ real Tauri CLI
/// The release tooling end to end with a throwaway key: the manifest built by scripts/release/channel-manifest.mjs
/// and signed by `tauri signer sign` (tauri-cli 2.12.2), and an installer signed with `--app-version 0.12.1`. Guards
/// the formats the release job produces (scripts/release/release.test.mjs checks the same files from Node).
#[test]
fn a_release_made_by_the_release_tooling_verifies_and_installs() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tauri-cli");
    let read = |n: &str| std::fs::read(dir.join(n)).expect(n);
    let text = |n: &str| String::from_utf8(read(n)).expect(n).trim().to_owned();
    let keys = ReleaseKeys::parse(
        &serde_json::json!({ "keys": [{ "key_id": "177C013A0535F941",
            "public_key": text("throwaway.key.pub"),
            "not_before": "2026-10-01", "not_after": "2027-12-31" }] })
        .to_string(),
    )
    .expect("keys");
    let now = parse_utc("2026-10-15T08:00:00Z").expect("now");
    let m = verify_channel_manifest(&read("stable.json"), &text("stable.json.sig"), &keys, now)
        .expect("manifest");
    assert_eq!(m.sequence, 38_600_000_001);
    let a = evaluate(&m, "stable", "0.12.0", "windows-x64", None, now).expect("evaluate");
    let offer = a.offer.expect("offer");
    assert_eq!(offer.version, "0.12.1");

    // The installer the manifest names, served by a host: downloaded and verified (size, SHA-256, signature bound
    // to 0.12.1 and the file name).
    let exe = read("Project.Browser_0.12.1_x64-setup.exe");
    let host = MemTransport {
        files: HashMap::from([(offer.artifact.url.clone(), exe)]),
        fail_after: Mutex::new(None),
        ignore_range: false,
        opens: Mutex::new(vec![]),
    };
    let tmp = tempfile::tempdir().expect("tmp");
    let d = download_verified(
        &host,
        &keys,
        &offer,
        tmp.path(),
        now,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .expect("download");
    assert_eq!(d.version, "0.12.1");

    // The manifest's signature does not cover other bytes, and a key past its validity is refused.
    let mut changed = read("stable.json");
    let last = changed.len() - 3;
    changed[last] ^= 1;
    assert!(verify_channel_manifest(&changed, &text("stable.json.sig"), &keys, now).is_err());
    let later = parse_utc("2028-01-02").expect("later");
    assert!(matches!(
        verify_channel_manifest(&read("stable.json"), &text("stable.json.sig"), &keys, later),
        Err(AppUpdateError::KeyExpired(_))
    ));
}
