//! Milestone 12 desktop acceptance tests for manager updates, through the real IPC commands: a signed channel
//! manifest is checked, the offered installer is downloaded (resuming after an interruption), verified and handed to
//! the installer only with profiles closed. Exit-gate scenarios: signature mismatch, corrupt update, interrupted
//! download, stale manifest and replay, expired signing key, paused distribution, revoked and below-minimum versions,
//! no downgrade, channel switch, and the macOS bundle swap. `pb_update::app` has the unit tests of the same rules.

mod support;

use pb_desktop_lib::app_update::InstallPlan;
use pb_desktop_lib::operations::{OpKind, OpStatus};
use pb_update::app::testing::{MemHost, TestKey, app_bundle_archive};
use pb_update::app::{BUNDLE_ID, RELEASE_URL_PREFIX};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const NOW: i64 = 1_791_000_000; // 2026-10-03T04:00:00Z
const ISSUED: &str = "2026-10-02T04:00:00Z";
const EXPIRES: &str = "2026-11-02T04:00:00Z";

fn ok(r: Result<Value, Value>) -> Value {
    r.unwrap_or_else(|e| panic!("{e}"))
}

fn installer_bytes(version: &str) -> Vec<u8> {
    let mut b: Vec<u8> = (0..250_000u32).map(|i| (i % 251) as u8).collect();
    b.extend_from_slice(version.as_bytes());
    b
}

fn file_name(version: &str, kind: &str) -> String {
    match kind {
        "nsis" => format!("Project.Browser_{version}_x64-setup.exe"),
        _ => "Project.Browser.app.tar.gz".into(),
    }
}

fn url(version: &str, kind: &str) -> String {
    format!(
        "{RELEASE_URL_PREFIX}desktop-v{version}/{}",
        file_name(version, kind)
    )
}

struct Release {
    key: TestKey,
    host: Arc<MemHost>,
}

impl Release {
    /// Serves `bytes` as the release's artifact and returns its manifest entry (signed by `signer`).
    fn artifact(&self, signer: &TestKey, version: &str, kind: &str, bytes: Vec<u8>) -> Value {
        let platform = if kind == "nsis" {
            "windows-x64"
        } else {
            "macos-arm64"
        };
        let entry = json!({
            "platform": platform,
            "kind": kind,
            "url": url(version, kind),
            "sha256": hex::encode(Sha256::digest(&bytes)),
            "size_bytes": bytes.len(),
            "signature": signer.sign_artifact(&bytes, &file_name(version, kind), version, NOW),
        });
        self.host.put(&url(version, kind), bytes);
        entry
    }

    fn manifest(&self, channel: &str, seq: u64, version: &str, artifacts: Vec<Value>) -> Value {
        json!({
            "schema": 1,
            "product": "project-browser-manager",
            "channel": channel,
            "sequence": seq,
            "issued_at": ISSUED,
            "expires_at": EXPIRES,
            "paused": false,
            "minimum_version": null,
            "revoked_versions": [],
            "revoked_runtime_sha256": [],
            "release": {
                "version": version,
                "published_at": ISSUED,
                "notes_url": format!("https://github.com/bibekthapamgr/antibrowser/releases/tag/desktop-v{version}"),
                "artifacts": artifacts,
            }
        })
    }

    fn publish_signed(&self, signer: &TestKey, m: &Value) {
        let channel = m["channel"].as_str().unwrap_or("stable").to_owned();
        let body = serde_json::to_vec_pretty(m).unwrap_or_else(|e| panic!("{e}"));
        let sig = signer.sign_manifest(&body, &channel, NOW);
        self.host.publish(&channel, body, sig);
    }

    fn publish(&self, m: &Value) {
        self.publish_signed(&self.key, m);
    }

    /// A Windows release of `version` on stable with sequence `seq`.
    fn windows(&self, seq: u64, version: &str) -> Value {
        let a = self.artifact(&self.key, version, "nsis", installer_bytes(version));
        self.manifest("stable", seq, version, vec![a])
    }
}

fn setup(platform: &str, version: &str, bundle: Option<PathBuf>) -> (Fixture, Release) {
    let f = fixture();
    let key = TestKey::generate();
    f.state
        .use_release_keys(&key.keys_json("2026-01-01", "2030-01-01"))
        .unwrap_or_else(|e| panic!("{e}"));
    let host = Arc::new(MemHost::default());
    f.state.use_update_transport(host.clone());
    f.state
        .set_update_environment(platform, version, NOW, bundle);
    (f, Release { key, host })
}

fn status(f: &Fixture) -> Value {
    ok(invoke(f, "get_update_status", json!({})))
}

fn check(f: &Fixture) -> Value {
    ok(invoke(f, "check_for_updates", json!({})))
}

/// Starts the download and waits until it has finished (ready, failed, or back to available after a stop).
fn download(f: &Fixture) -> Value {
    ok(invoke(f, "download_update", json!({})));
    let start = Instant::now();
    loop {
        let s = status(f);
        if s["phase"] != "downloading" {
            return s;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "download hung");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn downloads(f: &Fixture) -> Vec<String> {
    std::fs::read_dir(f.data().join("updates").join("downloads"))
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn last_download_op(f: &Fixture) -> Option<(OpStatus, Option<String>)> {
    f.state
        .ops
        .list()
        .into_iter()
        .find(|o| o.kind == OpKind::DownloadUpdate)
        .map(|o| (o.status, o.error_code.map(str::to_owned)))
}

#[test]
fn without_a_release_key_the_manager_never_checks() {
    let f = fixture();
    f.state
        .use_release_keys(r#"{"keys":[]}"#)
        .unwrap_or_else(|e| panic!("{e}"));
    let s = status(&f);
    assert_eq!(s["configured"], false);
    assert_eq!(s["phase"], "idle");
    let r = invoke(&f, "check_for_updates", json!({}));
    assert_eq!(code(&r).as_deref(), Some("UPDATES_NOT_CONFIGURED"));
    // The runtime page carries the same status.
    let rt = ok(invoke(&f, "get_runtime_status", json!({})));
    assert_eq!(rt["manager_updates"]["configured"], false);
}

#[test]
fn a_signed_update_is_checked_downloaded_verified_and_installed_with_profiles_closed() {
    let (f, rel) = setup("windows-x64", "1.0.0", None);
    let s = status(&f);
    assert_eq!(s["configured"], true);
    assert_eq!(s["channel"], "stable");
    assert_eq!(s["automatic"], true);
    assert_eq!(s["install_supported"], true);
    assert_eq!(
        code(&invoke(&f, "download_update", json!({}))).as_deref(),
        Some("UPDATE_NOT_AVAILABLE")
    );

    rel.publish(&rel.windows(10, "1.1.0"));
    let s = check(&f);
    assert_eq!(s["phase"], "available", "{s}");
    assert_eq!(s["available"]["version"], "1.1.0");
    assert_eq!(s["latest_version"], "1.1.0");
    assert_eq!(s["blocked"], Value::Null);
    assert_eq!(s["manifest_expires_at"], EXPIRES);
    assert!(
        s["checked_at"]
            .as_str()
            .is_some_and(|t| t.starts_with("2026-10-03"))
    );

    let s = download(&f);
    assert_eq!(s["phase"], "ready", "{s}");
    assert_eq!(last_download_op(&f), Some((OpStatus::Succeeded, None)));
    assert!(f.events.names().iter().any(|n| n == "update"));
    assert_eq!(downloads(&f), vec![file_name("1.1.0", "nsis")]);

    // Installing restarts the app: open profiles must be closed first.
    let id = workspace_with_profile(&f);
    let op = ok(invoke(&f, "launch_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    assert_eq!(
        f.state.update_install().err().map(|e| e.code),
        Some("UPDATE_PROFILES_OPEN")
    );
    let op = ok(invoke(&f, "stop_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);

    match f.state.update_install() {
        Ok(InstallPlan::RunInstaller(path)) => {
            assert_eq!(
                path,
                f.data()
                    .join("updates")
                    .join("downloads")
                    .join(file_name("1.1.0", "nsis"))
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_interrupted_download_resumes_where_it_stopped() {
    let (f, rel) = setup("windows-x64", "1.0.0", None);
    rel.publish(&rel.windows(10, "1.1.0"));
    check(&f);
    rel.host.interrupt_next_after(100_000);
    let s = download(&f);
    assert_eq!(s["phase"], "failed");
    assert_eq!(s["error"]["code"], "UPDATE_DOWNLOAD_FAILED");
    assert_eq!(
        last_download_op(&f),
        Some((OpStatus::Failed, Some("UPDATE_DOWNLOAD_FAILED".into())))
    );
    // A failed download keeps the offer; trying again continues from the part already here.
    let s = check(&f);
    assert_eq!(s["phase"], "available");
    let s = download(&f);
    assert_eq!(s["phase"], "ready", "{s}");
    assert_eq!(rel.host.opens(), vec![0, 100_000]);
}

#[test]
fn corrupt_and_wrongly_signed_updates_are_deleted_and_never_installed() {
    let (f, rel) = setup("windows-x64", "1.0.0", None);
    // The host serves different bytes than the manifest describes.
    let mut m = rel.windows(10, "1.1.0");
    rel.host
        .put(&url("1.1.0", "nsis"), installer_bytes("9.9.9"));
    rel.publish(&m);
    check(&f);
    let s = download(&f);
    assert_eq!(s["error"]["code"], "UPDATE_CORRUPT", "{s}");
    assert!(downloads(&f).is_empty());

    // Right bytes, but the installer was signed by a key this build does not trust.
    let stranger = TestKey::generate();
    let a = rel.artifact(&stranger, "1.1.1", "nsis", installer_bytes("1.1.1"));
    m = rel.manifest("stable", 11, "1.1.1", vec![a]);
    rel.publish(&m);
    assert_eq!(check(&f)["phase"], "available");
    let s = download(&f);
    assert_eq!(s["error"]["code"], "UPDATE_SIGNATURE_INVALID", "{s}");
    assert!(downloads(&f).is_empty());

    // A good download changed on disk before installing is refused and deleted.
    rel.publish(&rel.windows(12, "1.1.2"));
    check(&f);
    assert_eq!(download(&f)["phase"], "ready");
    let path = f
        .data()
        .join("updates")
        .join("downloads")
        .join(file_name("1.1.2", "nsis"));
    let mut bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{e}"));
    bytes[10] ^= 0xff;
    std::fs::write(&path, bytes).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        f.state.update_install().err().map(|e| e.code),
        Some("UPDATE_CORRUPT")
    );
    assert!(!path.exists());
    assert_eq!(status(&f)["phase"], "available");
}

#[test]
fn stale_replayed_forged_and_expired_key_manifests_are_refused() {
    let (f, rel) = setup("windows-x64", "1.0.0", None);
    rel.publish(&rel.windows(10, "1.1.0"));
    assert_eq!(check(&f)["phase"], "available");
    assert_eq!(download(&f)["phase"], "ready");
    let state: Value = serde_json::from_slice(
        &std::fs::read(f.data().join("updates").join("state.json"))
            .unwrap_or_else(|e| panic!("{e}")),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(state["sequences"]["stable"], 10);

    // An older, validly signed manifest (replay): refused, and the ready download is withdrawn and deleted.
    rel.publish(&rel.windows(9, "1.1.0"));
    let s = check(&f);
    assert_eq!(s["phase"], "failed");
    assert_eq!(s["error"]["code"], "UPDATE_MANIFEST_REPLAYED");
    assert_eq!(s["available"], Value::Null);
    assert!(downloads(&f).is_empty());
    assert_eq!(
        f.state.update_install().err().map(|e| e.code),
        Some("UPDATE_NOT_READY")
    );

    // Expired (frozen) manifest.
    let mut m = rel.windows(11, "1.1.0");
    m["expires_at"] = json!("2026-10-03T03:00:00Z");
    rel.publish(&m);
    assert_eq!(check(&f)["error"]["code"], "UPDATE_MANIFEST_EXPIRED");

    // Forged: signed by another key; or changed after signing.
    let stranger = TestKey::generate();
    rel.publish_signed(&stranger, &rel.windows(12, "1.1.0"));
    assert_eq!(check(&f)["error"]["code"], "UPDATE_SIGNATURE_INVALID");
    let m = rel.windows(12, "1.1.0");
    let body = serde_json::to_vec_pretty(&m).unwrap_or_else(|e| panic!("{e}"));
    let sig = rel.key.sign_manifest(&body, "stable", NOW);
    let forged = String::from_utf8(body)
        .unwrap_or_default()
        .replace("1.1.0", "1.1.9");
    rel.host.publish("stable", forged.into_bytes(), sig);
    assert_eq!(check(&f)["error"]["code"], "UPDATE_SIGNATURE_INVALID");

    // The release key's validity ended (like an expired signing certificate).
    f.state
        .use_release_keys(&rel.key.keys_json("2025-01-01", "2026-06-30"))
        .unwrap_or_else(|e| panic!("{e}"));
    rel.publish(&rel.windows(13, "1.1.0"));
    assert_eq!(check(&f)["error"]["code"], "UPDATE_KEY_EXPIRED");

    // Nothing reachable: a plain download failure, no offer.
    f.state
        .use_release_keys(&rel.key.keys_json("2026-01-01", "2030-01-01"))
        .unwrap_or_else(|e| panic!("{e}"));
    rel.host.remove(&pb_update::app::manifest_url("stable"));
    let s = check(&f);
    assert_eq!(s["error"]["code"], "UPDATE_DOWNLOAD_FAILED");
    assert_eq!(s["available"], Value::Null);
}

#[test]
fn paused_and_revoked_releases_are_withdrawn_and_vulnerable_versions_flagged() {
    let (f, rel) = setup("windows-x64", "1.0.0", None);
    rel.publish(&rel.windows(10, "1.1.0"));
    check(&f);
    assert_eq!(download(&f)["phase"], "ready");

    // Distribution paused (compromised release): the ready download is deleted, nothing is offered.
    let mut m = rel.windows(11, "1.1.0");
    m["paused"] = json!(true);
    rel.publish(&m);
    let s = check(&f);
    assert_eq!(s["phase"], "up_to_date");
    assert_eq!(s["paused"], true);
    assert_eq!(s["available"], Value::Null);
    assert!(downloads(&f).is_empty());

    // The release itself revoked: not offered.
    let mut m = rel.windows(12, "1.1.0");
    m["revoked_versions"] = json!(["1.1.0"]);
    rel.publish(&m);
    let s = check(&f);
    assert_eq!(s["phase"], "up_to_date");
    assert_eq!(s["latest_version"], "1.1.0");

    // This version revoked: flagged, the fix offered.
    let mut m = rel.windows(13, "1.1.1");
    m["revoked_versions"] = json!(["1.0.0"]);
    rel.publish(&m);
    let s = check(&f);
    assert_eq!(s["blocked"], json!({ "reason": "revoked" }));
    assert_eq!(s["available"]["version"], "1.1.1");

    // Below the channel's minimum safe version.
    let mut m = rel.windows(14, "1.1.1");
    m["minimum_version"] = json!("1.0.5");
    rel.publish(&m);
    let s = check(&f);
    assert_eq!(
        s["blocked"],
        json!({ "reason": "below_minimum", "minimum_version": "1.0.5" })
    );
}

#[test]
fn never_a_downgrade_and_channels_are_separate() {
    let (f, rel) = setup("windows-x64", "1.2.0", None);
    rel.publish(&rel.windows(10, "1.1.0"));
    let s = check(&f);
    assert_eq!(s["phase"], "up_to_date");
    assert_eq!(s["latest_version"], "1.1.0");

    let a = rel.artifact(
        &rel.key,
        "1.3.0-beta.1",
        "nsis",
        installer_bytes("1.3.0-beta.1"),
    );
    rel.publish(&rel.manifest("canary", 3, "1.3.0-beta.1", vec![a]));
    ok(invoke(
        &f,
        "update_setting",
        json!({ "key": "updates.channel", "value": "canary" }),
    ));
    // A different channel has not been checked yet.
    let s = status(&f);
    assert_eq!(s["channel"], "canary");
    assert_eq!(s["phase"], "idle");
    let s = check(&f);
    assert_eq!(s["phase"], "available", "{s}");
    assert_eq!(s["available"]["version"], "1.3.0-beta.1");

    // A manifest for another channel served under this one is refused (signed for canary.json, served as stable).
    let a = rel.artifact(&rel.key, "1.4.0", "nsis", installer_bytes("1.4.0"));
    let m = rel.manifest("canary", 4, "1.4.0", vec![a]);
    let body = serde_json::to_vec_pretty(&m).unwrap_or_else(|e| panic!("{e}"));
    let sig = rel.key.sign_manifest(&body, "canary", NOW);
    rel.host.publish("stable", body, sig);
    ok(invoke(
        &f,
        "update_setting",
        json!({ "key": "updates.channel", "value": "stable" }),
    ));
    assert_eq!(check(&f)["error"]["code"], "UPDATE_MANIFEST_INVALID");

    // Unknown channel values are refused by the settings allow-list.
    let r = invoke(
        &f,
        "update_setting",
        json!({ "key": "updates.channel", "value": "nightly" }),
    );
    assert!(r.is_err());
}

#[test]
fn macos_bundle_is_replaced_by_the_verified_version_only() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let bundle = tmp.path().join("Applications").join("Project Browser.app");
    std::fs::create_dir_all(bundle.join("Contents")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(bundle.join("Contents").join("Info.plist"), "old")
        .unwrap_or_else(|e| panic!("{e}"));
    let (f, rel) = setup("macos-arm64", "1.0.0", Some(bundle.clone()));

    // An archive whose bundle claims another version than the signed release: refused, old app kept.
    let wrong = rel.artifact(
        &rel.key,
        "1.1.0",
        "app-tar-gz",
        app_bundle_archive(BUNDLE_ID, "1.0.9"),
    );
    rel.publish(&rel.manifest("stable", 10, "1.1.0", vec![wrong]));
    check(&f);
    assert_eq!(download(&f)["phase"], "ready");
    assert_eq!(
        f.state.update_install().err().map(|e| e.code),
        Some("UPDATE_INSTALL_FAILED")
    );
    assert_eq!(
        std::fs::read_to_string(bundle.join("Contents").join("Info.plist")).unwrap_or_default(),
        "old"
    );

    let good = rel.artifact(
        &rel.key,
        "1.1.1",
        "app-tar-gz",
        app_bundle_archive(BUNDLE_ID, "1.1.1"),
    );
    rel.publish(&rel.manifest("stable", 11, "1.1.1", vec![good]));
    check(&f);
    assert_eq!(download(&f)["phase"], "ready");
    assert_eq!(f.state.update_install(), Ok(InstallPlan::Restart));
    let plist =
        std::fs::read_to_string(bundle.join("Contents").join("Info.plist")).unwrap_or_default();
    assert!(plist.contains("1.1.1"));
    assert!(downloads(&f).is_empty());
}

#[test]
fn systems_without_an_installer_only_check() {
    let (f, rel) = setup("linux-x64", "1.0.0", None);
    let a = rel.artifact(&rel.key, "1.1.0", "nsis", installer_bytes("1.1.0"));
    rel.publish(&rel.manifest("stable", 10, "1.1.0", vec![a]));
    let s = check(&f);
    assert_eq!(s["install_supported"], false);
    // No artifact for this platform: nothing is offered, but the newest version is shown.
    assert_eq!(s["phase"], "up_to_date");
    assert_eq!(s["latest_version"], "1.1.0");
}
