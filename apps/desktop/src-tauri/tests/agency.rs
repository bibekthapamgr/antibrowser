//! Milestone 09 desktop acceptance tests through the real IPC commands, local database, profile folders and (fake)
//! browsers, with the in-memory server (`pb_sync::fake`) for organization profiles.
//!
//! Covers: a forbidden extension turns extensions off for the session (enforce) or is warned about (warn); an update
//! that adds sensitive permissions is reported until reviewed; per-client download folders cannot leave the base
//! folder and a client's picture is set; selection summaries and the low-memory check; resource counts exclude
//! unrelated browsers; health shows check times and never claims anything about website accounts; the diagnostics
//! preview contains no fixture secrets and is limited in size.

mod support;

use pb_desktop_lib::operations::{OpKind, OpStatus};
use pb_desktop_lib::secrets::MemoryStore;
use pb_runtime::ProfileId;
use pb_storage::cloud as cs;
use pb_sync::Poll;
use pb_sync::fake::FakeServer;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";
const PRF: &str = "prf_01J9ZSEED0A010000000000000";
const DEV: &str = "dev_01J9ZSEED0D1D1000000000000";
const BLOCKED: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HELPER: &str = "cccccccccccccccccccccccccccccccc";

fn ok(r: Result<Value, Value>) -> Value {
    r.unwrap_or_else(|e| panic!("{e}"))
}

fn pid(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap_or_else(|_| panic!("bad id {id}"))
}

fn user_data(f: &Fixture, id: &str) -> PathBuf {
    f.data().join("profiles").join(id).join("user-data")
}

fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn open(f: &Fixture, id: &str) {
    let op = ok(invoke(f, "launch_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
}

fn team_phase(f: &Fixture, id: &str) -> Value {
    ok(invoke(f, "get_team_status", json!({ "profileId": id })))["phase"].clone()
}

fn wait_closed(f: &Fixture, id: &str) {
    wait_until("the profile to stop", || {
        f.state.poll_once();
        invoke(f, "get_profile_status", json!({ "profileId": id }))
            .map(|s| s["profile"]["state"] == json!("stopped"))
            .unwrap_or(false)
    });
    wait_until("the close to settle", || {
        let copying = f.state.ops.list().iter().any(|o| {
            o.kind == OpKind::BackupProfile
                && o.status == OpStatus::Running
                && o.target.as_deref() == Some(id)
        });
        let phase = team_phase(f, id);
        !copying && phase != json!("running") && phase != json!("closing")
    });
}

fn stop(f: &Fixture, id: &str) {
    let op = ok(invoke(f, "stop_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
    wait_closed(f, id);
}

fn write_json(path: &Path, v: &Value) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{e}"));
    }
    std::fs::write(path, v.to_string()).unwrap_or_else(|e| panic!("{e}"));
}

/// Puts an extension into the profile the way Chromium records a Web Store install.
fn install(f: &Fixture, id: &str, ext: &str, name: &str, version: &str, permissions: &[&str]) {
    let ud = user_data(f, id);
    let dir = format!("{ext}/{version}_0");
    write_json(
        &ud.join("Default/Extensions")
            .join(&dir)
            .join("manifest.json"),
        &json!({ "manifest_version": 3, "name": name, "version": version, "permissions": permissions,
                 "update_url": "https://clients2.google.com/service/update2/crx" }),
    );
    let prefs = pb_runtime::prefs::preferences_path(&ud);
    let mut v: Value = std::fs::read(&prefs)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    v["extensions"]["settings"][ext] =
        json!({ "location": 1, "creation_flags": 9, "disable_reasons": [], "path": dir });
    write_json(&prefs, &v);
}

fn warnings(f: &Fixture, code: &str) -> Vec<Value> {
    f.events
        .events
        .lock()
        .map(|e| {
            e.iter()
                .filter(|(n, p)| n == "warning" && p["code"] == json!(code))
                .map(|(_, p)| p.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn last_args(f: &Fixture) -> Vec<String> {
    f.launcher
        .last_args
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default()
}

fn policy(f: &Fixture, mode: &str, version: i64, rules: Value) {
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .save_extension_policy(ORG, mode, version, &rules.to_string())
        .unwrap_or_else(|e| panic!("{e}"));
}

/// An organization profile used on this computer (linked, backed up once), as in the milestone 08 tests.
fn shared_profile() -> (Arc<FakeServer>, Fixture, String) {
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let f = fixture();
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .set_cloud_state(cs::DEVICE_ID, Some(DEV))
        .unwrap_or_else(|e| panic!("{e}"));
    f.state
        .use_sync_backend(Arc::new(server.client(DEV, &[ORG])));
    f.state.set_sync_poll(Poll {
        interval: Duration::from_millis(1),
        max_wait: Duration::from_millis(200),
    });
    let id = workspace_with_profile(&f);
    open(&f, &id);
    stop(&f, &id);
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .link_org_profiles(ORG, &[(pid(&id), PRF.into())])
        .unwrap_or_else(|e| panic!("{e}"));
    ok(invoke(&f, "sync_backup_now", json!({ "profileId": id })));
    f.state.run_sync_jobs();
    (server, f, id)
}

/// Closes a shared profile and lets the handoff finish (closing backup, lease released).
fn close_shared(f: &Fixture, id: &str) {
    ok(invoke(
        f,
        "team_close",
        json!({ "profileId": id, "note": null }),
    ));
    wait_closed(f, id);
    f.state.run_sync_jobs();
    wait_until("the lease to be released", || team_phase(f, id).is_null());
}

// ---------------------------------------------------------------------------------------------- extensions

#[test]
fn a_forbidden_extension_turns_extensions_off_for_organization_sessions() {
    let (_server, f, id) = shared_profile();
    install(
        &f,
        &id,
        BLOCKED,
        "Coupon finder",
        "2.1.0",
        &["tabs", "<all_urls>"],
    );
    install(&f, &id, HELPER, "Grammar helper", "4.2.0", &["storage"]);
    let rule = |ext: &str, decision: &str| {
        json!({ "extension_id": ext, "name": "", "decision": decision, "source": "web_store",
                "approved_version_range": ">=4 <5", "permissions": [] })
    };
    policy(
        &f,
        "enforce",
        2,
        json!([rule(BLOCKED, "blocked"), rule(HELPER, "allowed")]),
    );

    // Before opening: the window can tell the person what will happen.
    let check = ok(invoke(&f, "check_launch", json!({ "profileIds": [id] })));
    let names: Vec<&str> = check["extensions"][0]["items"]
        .as_array()
        .map(|a| a.iter().filter_map(|i| i["name"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(check["extensions"][0]["disable"], json!(true), "{check}");
    assert_eq!(names, ["Coupon finder"]);

    open(&f, &id);
    assert!(
        last_args(&f).iter().any(|a| a == "--disable-extensions"),
        "{:?}",
        last_args(&f)
    );
    let warned = warnings(&f, "EXTENSIONS_DISABLED");
    assert_eq!(warned.len(), 1);
    assert_eq!(
        warned[0]["extensions"][0]["verdict"]["status"],
        json!("blocked")
    );
    let view = ok(invoke(&f, "get_extensions", json!({ "profileId": id })));
    let p = &view["profiles"][0];
    assert_eq!(
        (
            p["mode"].clone(),
            p["will_disable"].clone(),
            p["needs_attention"].clone()
        ),
        (json!("enforce"), json!(true), json!(1))
    );
    let audit = f
        .state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .list_audit(Some(&pid(&id)), 50)
        .unwrap_or_default();
    assert!(
        audit
            .iter()
            .any(|a| a.action == "extension" && a.outcome == "disabled")
    );
    close_shared(&f, &id);

    // The organization allows it: the next open runs extensions as usual.
    policy(
        &f,
        "enforce",
        3,
        json!([
            rule(HELPER, "allowed"),
            json!({ "extension_id": BLOCKED, "name": "",
        "decision": "allowed", "source": "web_store", "approved_version_range": null,
        "permissions": ["tabs", "<all_urls>"] })
        ]),
    );
    open(&f, &id);
    assert!(
        !last_args(&f).iter().any(|a| a.contains("extension")),
        "{:?}",
        last_args(&f)
    );
    close_shared(&f, &id);

    // Warn mode: an unlisted extension is announced but nothing is turned off.
    policy(&f, "warn", 4, json!([rule(HELPER, "allowed")]));
    open(&f, &id);
    assert!(!last_args(&f).iter().any(|a| a == "--disable-extensions"));
    assert_eq!(warnings(&f, "EXTENSIONS_NOT_APPROVED").len(), 1);
    close_shared(&f, &id);
}

#[test]
fn an_update_that_adds_sensitive_permissions_waits_for_review_on_local_profiles() {
    let f = fixture();
    let id = workspace_with_profile(&f);
    install(&f, &id, HELPER, "Grammar helper", "4.2.0", &["storage"]);
    let first = ok(invoke(&f, "rescan_extensions", json!({ "profileId": id })));
    let e = &first["profiles"][0]["extensions"][0];
    assert_eq!(
        (e["name"].clone(), e["source"].clone(), e["verdict"].clone()),
        (json!("Grammar helper"), json!("web_store"), Value::Null)
    );
    assert_eq!(first["profiles"][0]["mode"], json!("local"));

    // Chromium updated it while it ran: the next scan sees more access.
    install(
        &f,
        &id,
        HELPER,
        "Grammar helper",
        "4.3.0",
        &["storage", "cookies", "<all_urls>"],
    );
    let second = ok(invoke(&f, "rescan_extensions", json!({ "profileId": id })));
    let e = &second["profiles"][0]["extensions"][0];
    assert_eq!(
        (e["previous_version"].clone(), e["added_sensitive"].clone()),
        (json!("4.2.0"), json!(["<all_urls>", "cookies"]))
    );
    assert_eq!(second["profiles"][0]["needs_attention"], json!(1));
    assert_eq!(warnings(&f, "EXTENSION_PERMISSIONS_ADDED").len(), 1);
    let health = ok(invoke(&f, "get_health", json!({})));
    let card = health["cards"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["id"] == json!("extensions")))
        .cloned();
    assert_eq!(card.map(|c| c["status"].clone()), Some(json!("warning")));

    // A local profile never opens with extensions turned off; the person reviews the change.
    open(&f, &id);
    assert!(!last_args(&f).iter().any(|a| a == "--disable-extensions"));
    stop(&f, &id);
    let reviewed = ok(invoke(
        &f,
        "review_extension",
        json!({ "profileId": id, "extensionId": HELPER }),
    ));
    assert_eq!(reviewed["profiles"][0]["needs_attention"], json!(0));
    assert_eq!(
        code(&invoke(
            &f,
            "review_extension",
            json!({ "profileId": id, "extensionId": "x" })
        ))
        .as_deref(),
        Some("INVALID_ARGUMENT")
    );
}

// ---------------------------------------------------------------------------------------------- downloads

fn chromium_prefs(f: &Fixture, id: &str) -> Value {
    std::fs::read(pb_runtime::prefs::preferences_path(&user_data(f, id)))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

#[test]
fn client_download_folders_stay_inside_the_base_folder_and_clients_get_a_picture() {
    let f = fixture();
    let id = workspace_with_profile(&f); // client "Client North"
    let base = f.tmp.path().join("Downloads");
    std::fs::create_dir_all(&base).unwrap_or_else(|e| panic!("{e}"));
    f.state
        .set_download_directory(&base)
        .unwrap_or_else(|e| panic!("{e:?}"));
    // The stored folder is canonical in its ordinary form (no `\\?\` prefix on Windows).
    let base = pb_runtime::simplify_path(&std::fs::canonicalize(&base).unwrap_or(base));
    ok(invoke(
        &f,
        "update_setting",
        json!({ "key": "downloads.per_client_folders", "value": true }),
    ));
    let evil = ok(invoke(
        &f,
        "create_profile",
        json!({ "name": "Other", "client": "../../Evil" }),
    ));
    let evil_id = evil["id"].as_str().unwrap_or_default().to_owned();

    open(&f, &id);
    let prefs = chromium_prefs(&f, &id);
    assert_eq!(
        prefs["download"]["default_directory"],
        json!(base.join("Client North").to_string_lossy())
    );
    let avatar = prefs["profile"]["avatar_index"].as_u64().unwrap_or(0);
    assert!((27..=55).contains(&avatar), "{avatar}");
    assert_eq!(prefs["profile"]["using_default_avatar"], json!(false));
    // The client's name is in the profile menu too.
    assert_eq!(prefs["profile"]["name"], json!("Known · Client North"));
    stop(&f, &id);

    open(&f, &evil_id);
    let dir = chromium_prefs(&f, &evil_id)["download"]["default_directory"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_default();
    assert_eq!(dir.parent(), Some(base.as_path()), "{dir:?}");
    assert!(dir.is_dir());
    stop(&f, &evil_id);

    // A folder chosen for the client wins over the per-client subfolder; nothing is moved.
    let own = f.tmp.path().join("north-files");
    std::fs::create_dir_all(&own).unwrap_or_else(|e| panic!("{e}"));
    let client = ok(invoke(&f, "get_library", json!({})))["clients"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["name"] == json!("Client North")))
        .map(|c| c["id"].as_str().unwrap_or_default().to_owned())
        .unwrap_or_default();
    f.state
        .set_client_download_directory(
            &pb_runtime::ClientId::parse(&client).unwrap_or_else(|_| panic!("client")),
            Some(&own),
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    let overview = ok(invoke(
        &f,
        "get_client_overview",
        json!({ "clientId": client }),
    ));
    assert_eq!(overview["downloads"]["folder_name"], json!("Client North"));
    assert!(
        overview["downloads"]["client_folder"]
            .as_str()
            .is_some_and(|p| p.ends_with("north-files"))
    );
    assert_eq!(overview["profiles"]["total"], json!(1));
    assert!(
        overview["activity"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x["action"] == json!("start")))
    );
    open(&f, &id);
    assert!(
        chromium_prefs(&f, &id)["download"]["default_directory"]
            .as_str()
            .is_some_and(|p| p.ends_with("north-files"))
    );
    assert!(
        base.join("Client North").is_dir(),
        "the old folder stays where it was"
    );
    stop(&f, &id);
}

// ---------------------------------------------------------------------------------------------- bulk, memory, resources

#[test]
fn bulk_confirmations_name_clients_and_the_memory_check_uses_measurements() {
    let f = fixture();
    let a = workspace_with_profile(&f);
    let b = ok(invoke(
        &f,
        "create_profile",
        json!({ "name": "Ads", "client": "Client South" }),
    ));
    let c = ok(invoke(&f, "create_profile", json!({ "name": "Loose" })));
    let ids = [
        a.clone(),
        b["id"].as_str().unwrap_or_default().into(),
        c["id"].as_str().unwrap_or_default().into(),
    ];
    open(&f, &a);
    let summary = ok(invoke(
        &f,
        "selection_summary",
        json!({ "selection": { "kind": "ids", "ids": ids } }),
    ));
    let all = ok(invoke(
        &f,
        "selection_summary",
        json!({ "selection": { "kind": "filter", "filter": {}, "expected_total": 3 } }),
    ));
    assert_eq!(all["total"], json!(3));
    assert_eq!(
        (
            summary["total"].clone(),
            summary["running"].clone(),
            summary["missing"].clone()
        ),
        (json!(3), json!(1), json!(0))
    );
    let clients: Vec<Value> = summary["clients"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        clients
            .iter()
            .map(|c| c["client_name"].clone())
            .collect::<Vec<_>>(),
        [json!("Client North"), json!("Client South"), Value::Null]
    );
    assert_eq!(clients[0]["names"], json!(["Known"]));

    // Resource counts: only browser trees this app started; an unrelated browser is never counted.
    f.procs.add_full(
        90_000,
        Some(1),
        5,
        "/usr/bin/chrome",
        vec![
            "/usr/bin/chrome".into(),
            "--user-data-dir=/home/someone/.config/chrome".into(),
        ],
    );
    f.procs.set_memory(90_000, 6_000_000_000);
    let resources = ok(invoke(&f, "get_resources", json!({})));
    assert_eq!(resources["profiles"].as_array().map(Vec::len), Some(1));
    assert_eq!(resources["profiles"][0]["processes"], json!(2));
    assert_eq!(resources["browsers_memory_bytes"], json!(100_000_000));
    assert!(
        resources["manager"]["memory_bytes"]
            .as_u64()
            .unwrap_or(u64::MAX)
            < 6_000_000_000
    );

    let check = ok(invoke(&f, "check_launch", json!({ "profileIds": ids })));
    assert_eq!(
        (check["to_open"].clone(), check["already_open"].clone()),
        (json!(2), json!(1))
    );
    let m = &check["memory"];
    assert_eq!(
        m["needed_bytes"].as_u64(),
        m["estimate"]["per_profile_bytes"].as_u64().map(|p| p * 2)
    );
    assert!(m["available_bytes"].as_u64().is_some_and(|b| b > 0));
    assert_eq!(check["extensions"], json!([]));
    stop(&f, &a);
}

// ---------------------------------------------------------------------------------------------- health

#[test]
fn health_cards_say_when_they_were_checked_and_never_speak_about_accounts() {
    let f = fixture();
    let _ = workspace_with_profile(&f);
    let health = ok(invoke(&f, "get_health", json!({})));
    let ids: Vec<&str> = health["cards"]
        .as_array()
        .map(|c| c.iter().filter_map(|c| c["id"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(
        ids,
        [
            "connectivity",
            "proxies",
            "browser",
            "backups",
            "conflicts",
            "disk",
            "locks",
            "extensions",
            "memory"
        ]
    );
    let text = health.to_string().to_lowercase();
    for word in ["ban", "suspend", "detect", "risk score", "safe from"] {
        assert!(!text.contains(word), "health mentions {word:?}: {text}");
    }
    let card = |id: &str| {
        health["cards"]
            .as_array()
            .and_then(|c| c.iter().find(|c| c["id"] == json!(id)))
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(card("connectivity")["status"], json!("off"));
    assert_eq!(card("proxies")["status"], json!("off"));
    assert_eq!(card("browser")["status"], json!("ok"));
    assert!(card("disk")["checked_at"].is_string());

    // A proxy check more than a day old is "unknown", not "connected".
    let mem = Arc::new(MemoryStore::default());
    f.state.use_secret_store(mem);
    let proxy = ok(invoke(
        &f,
        "create_proxy",
        json!({ "proxy": { "name": "Residential DE", "type": "http", "host": "proxy.example.net", "port": 3128 } }),
    ));
    let proxy_id = proxy["id"].as_str().unwrap_or_default().to_owned();
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    store
        .record_check(
            &pb_runtime::ProxyId::parse(&proxy_id).unwrap_or_else(|_| panic!("id")),
            None,
            Some(40),
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let fresh = ok(invoke(&f, "get_health", json!({})));
    let proxies = fresh["cards"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["id"] == json!("proxies")))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(proxies["status"], json!("ok"), "{proxies}");
    rusqlite::Connection::open(f.data().join("local.db"))
        .and_then(|c| {
            c.execute(
                "update network_checks set checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')",
                [],
            )
        })
        .unwrap_or_else(|e| panic!("{e}"));
    let old = ok(invoke(&f, "get_health", json!({})));
    let proxies = old["cards"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["id"] == json!("proxies")))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(proxies["status"], json!("unknown"), "{proxies}");
    assert!(proxies["items"][0]["checked_at"].is_string());
    assert_eq!(
        code(&invoke(
            &f,
            "run_health_check",
            json!({ "check": "ban_risk" })
        ))
        .as_deref(),
        Some("INVALID_ARGUMENT")
    );
}

// ---------------------------------------------------------------------------------------------- diagnostics

#[test]
fn the_diagnostics_preview_contains_no_fixture_secrets() {
    let f = fixture();
    let mem = Arc::new(MemoryStore::default());
    f.state.use_secret_store(mem);
    let id = workspace_with_profile(&f);
    // Secret-looking fixtures, built at run time (none of them is real).
    let password = ["Zq7", "pw", "Lm41", "x"].join("-");
    let username = ["agency", "user", "17"].join("-");
    let token = [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiIxMjM0In0",
        "c2lnbmF0dXJlLXNpZ25hdHVyZQ",
    ]
    .join(".");
    let email = ["maria.k", "agency-client.example"].join("@");
    let host = "proxy-secret.provider.example";
    let page = format!(
        "https://admin.shop-secret.example/orders?session={}",
        ["s", "3cr", "3t"].concat()
    );
    ok(invoke(
        &f,
        "create_proxy",
        json!({ "proxy": { "name": "Residential DE", "type": "http", "host": host, "port": 3128,
                            "login": { "username": username, "password": password } } }),
    ));
    ok(invoke(
        &f,
        "update_profile",
        json!({ "profileId": id, "expectedVersion": 1, "notes": format!("Orders at {page}, contact {email}") }),
    ));
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    // An error detail that carries everything at once (as a badly behaved component might log it).
    store
        .audit(
            Some(&pid(&id)),
            "network",
            "PROXY_AUTH_FAILED",
            None,
            Some(&format!("{page} {email} token={token}")),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    store
        .set_cloud_state(cs::SERVER_URL, Some("https://api.agency-secret.example"))
        .unwrap_or_else(|e| panic!("{e}"));
    open(&f, &id);

    let preview = ok(invoke(&f, "preview_diagnostics", json!({})));
    let text = preview["text"].as_str().unwrap_or_default();
    assert!(text.contains("\"version\""), "versions are included");
    assert!(
        text.contains("PROXY_AUTH_FAILED"),
        "summarized errors are included"
    );
    assert!(text.contains("op_"), "operation ids are included");
    for secret in [
        password.as_str(),
        username.as_str(),
        token.as_str(),
        email.as_str(),
        host,
        "shop-secret.example",
        "agency-secret.example",
        "Orders at",
    ] {
        assert!(!text.contains(secret), "diagnostics contain {secret:?}");
    }
    assert!(preview["redactions"]["addresses"].as_u64().unwrap_or(0) >= 1);
    assert!(
        preview["bytes"].as_u64().unwrap_or(u64::MAX)
            <= preview["limit_bytes"].as_u64().unwrap_or(0)
    );
    assert_eq!(
        preview["text"].as_str().map(str::len),
        preview["bytes"].as_u64().map(|b| b as usize)
    );
    // Saving needs a live preview.
    assert_eq!(
        code(&invoke(
            &f,
            "export_diagnostics",
            json!({ "previewId": "diag_gone" })
        ))
        .as_deref(),
        Some("PREVIEW_EXPIRED")
    );
    // What is saved is exactly the previewed text.
    let target = f.tmp.path().join("report.json");
    f.state
        .save_diagnostics(preview["preview_id"].as_str().unwrap_or_default(), &target)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(std::fs::read_to_string(&target).ok().as_deref(), Some(text));
    let id_again = preview["preview_id"].as_str().unwrap_or_default();
    assert_eq!(
        f.state
            .save_diagnostics(id_again, &target)
            .err()
            .map(|e| e.code),
        Some("PREVIEW_EXPIRED"),
        "a preview is saved once"
    );
}
