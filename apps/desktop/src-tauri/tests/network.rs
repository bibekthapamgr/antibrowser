//! Milestone 05 IPC acceptance tests: proxies, routing, connectivity checks and privacy/environment settings.
//!
//! The manager runs as in the app (real commands, ACL, SQLite, gateway); the browser is the fake launcher, and a raw
//! TCP client plays the browser's network stack against the gateway exactly as Chromium does with
//! `--proxy-server=http://127.0.0.1:<port>`. Real-browser leak tests (NetLog, WebRTC) are in `tests/browser.rs`.

mod support;

use pb_desktop_lib::operations::OpStatus;
use pb_desktop_lib::secrets::{KeychainStatus, MemoryStore};
use pb_desktop_lib::supervisor::fake::FakeProcesses;
use pb_netproxy::check::CheckTarget;
use pb_netproxy::testing::{ProxyOptions, TestCheckService, TestOrigin, TestProxy};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

fn ok(r: Result<Value, Value>) -> Value {
    r.unwrap_or_else(|e| panic!("{e}"))
}

/// A password built at run time, so no secret-looking literal sits in the repository.
fn secret() -> String {
    ["pw", "Zq7", "Lm", "41"].join("-")
}

fn keychain(f: &Fixture) -> Arc<MemoryStore> {
    let mem = Arc::new(MemoryStore::default());
    f.state.use_secret_store(mem.clone());
    mem
}

fn allow_local_proxies(f: &Fixture) {
    ok(invoke(
        f,
        "update_setting",
        json!({ "key": "proxies.allow_private_addresses", "value": true }),
    ));
}

fn hosts(pairs: &[(&str, SocketAddr)]) -> HashMap<String, SocketAddr> {
    pairs.iter().map(|(n, a)| ((*n).to_owned(), *a)).collect()
}

fn create_proxy(f: &Fixture, proxy: Value) -> Value {
    ok(invoke(f, "create_proxy", json!({ "proxy": proxy })))
}

fn local_proxy(f: &Fixture, name: &str, proxy: &TestProxy, login: Option<(&str, &str)>) -> String {
    let mut p = json!({ "name": name, "type": proxy.kind.as_str(), "host": "127.0.0.1", "port": proxy.port() });
    if let Some((u, pw)) = login {
        p["login"] = json!({ "username": u, "password": pw });
    }
    create_proxy(f, p)["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn profile_version(f: &Fixture, id: &str) -> i64 {
    profile(f, id)["version"].as_i64().unwrap_or_default()
}

fn profile(f: &Fixture, id: &str) -> Value {
    ok(invoke(f, "get_profile_status", json!({ "profileId": id })))["profile"].clone()
}

fn assign(f: &Fixture, profile_id: &str, proxy_id: Option<&str>, fail_closed: bool) -> Value {
    ok(invoke(
        f,
        "assign_proxy",
        json!({ "profileId": profile_id, "proxyId": proxy_id, "failClosed": fail_closed,
                "expectedVersion": profile_version(f, profile_id) }),
    ))
}

fn launch(f: &Fixture, id: &str) {
    let op = ok(invoke(f, "launch_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
}

fn stop(f: &Fixture, id: &str) {
    let op = ok(invoke(f, "stop_profile", json!({ "profileId": id })));
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
}

fn args(f: &Fixture) -> Vec<String> {
    f.launcher
        .last_args
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default()
}

fn gateway_port(args: &[String]) -> u16 {
    args.iter()
        .find_map(|a| a.strip_prefix("--proxy-server=http://127.0.0.1:"))
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("no gateway in {args:?}"))
}

fn prefs(f: &Fixture, id: &str) -> Value {
    let path = f
        .data()
        .join("profiles")
        .join(id)
        .join("user-data/Default/Preferences");
    serde_json::from_slice(&std::fs::read(path).unwrap_or_default()).unwrap_or(Value::Null)
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

/// What the browser does for an https page through its proxy: `CONNECT`, then a request inside the tunnel.
fn tunnel(port: u16, authority: &str, path: &str) -> (String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap_or_else(|e| panic!("{e}"));
    s.set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap_or_else(|e| panic!("{e}"));
    s.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .unwrap_or_else(|e| panic!("{e}"));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte).unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    if !head.starts_with("HTTP/1.1 200") {
        let mut rest = Vec::new();
        let _ = s.read_to_end(&mut rest);
        return (head + &String::from_utf8_lossy(&rest), String::new());
    }
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .unwrap_or_else(|e| panic!("{e}"));
    let mut body = Vec::new();
    let _ = s.read_to_end(&mut body);
    (head, String::from_utf8_lossy(&body).into_owned())
}

fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn store_bytes(f: &Fixture) -> Vec<u8> {
    let mut out = vec![];
    for name in ["local.db", "local.db-wal"] {
        out.extend(std::fs::read(f.data().join(name)).unwrap_or_default());
    }
    out
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

// ---------------------------------------------------------------------------------------------- credentials

#[test]
fn proxy_logins_live_only_in_the_keychain_and_never_leave_it() {
    let f = fixture();
    let mem = keychain(&f);
    let profile_id = workspace_with_profile(&f);
    let password = secret();
    let username = "agency-user-17";
    let created = create_proxy(
        &f,
        json!({ "name": "Residential DE", "type": "http", "host": "proxy.example.net", "port": 3128,
                "login": { "username": username, "password": password }, "expires_at": "2030-01-31" }),
    );
    let proxy_id = created["id"].as_str().unwrap_or_default().to_owned();
    assert_eq!(created["has_login"], json!(true));
    assert!(created.get("credential_ref").is_none());
    let accounts = mem.accounts();
    assert_eq!(accounts.len(), 1);
    assert!(accounts[0].starts_with(&format!("proxy:{proxy_id}#")));
    assign(&f, &profile_id, Some(&proxy_id), true);

    // Nothing the manager shows, stores or exports contains the login.
    let listed = ok(invoke(&f, "list_proxies", json!({})));
    let diagnostics = ok(invoke(&f, "get_diagnostics", json!({})));
    let sel: pb_desktop_lib::manage::Selection =
        serde_json::from_value(json!({ "kind": "filter", "filter": {}, "expected_total": 1 }))
            .unwrap_or_else(|e| panic!("{e}"));
    let mut exported = vec![];
    for format in [
        pb_desktop_lib::transfer::ExportFormat::Csv,
        pb_desktop_lib::transfer::ExportFormat::Json,
        pb_desktop_lib::transfer::ExportFormat::Bundle,
    ] {
        let e = f
            .state
            .prepare_export(sel.clone(), format, true)
            .unwrap_or_else(|e| panic!("{e:?}"));
        exported.extend(e.bytes);
    }
    let shown = [
        created.to_string(),
        listed.to_string(),
        diagnostics.to_string(),
        profile(&f, &profile_id).to_string(),
    ]
    .concat();
    for blob in [shown.as_bytes(), &exported, &store_bytes(&f)] {
        assert!(!contains(blob, &password), "password leaked");
        assert!(!contains(blob, username), "username leaked");
    }

    // A new login goes to a new keychain entry; the old one is removed once the change is saved.
    let updated = ok(invoke(
        &f,
        "update_proxy",
        json!({ "proxyId": proxy_id, "expectedVersion": 1,
                "changes": { "login": { "username": "second", "password": "pw2" } } }),
    ));
    assert_eq!(updated["version"], json!(2));
    let after = mem.accounts();
    assert_eq!(after.len(), 1);
    assert_ne!(after, accounts);
    // A stale edit is refused before anything is written.
    let stale = invoke(
        &f,
        "update_proxy",
        json!({ "proxyId": proxy_id, "expectedVersion": 1,
                "changes": { "login": { "username": "third", "password": "pw3" } } }),
    );
    assert_eq!(code(&stale).as_deref(), Some("VERSION_CONFLICT"));
    assert_eq!(mem.accounts(), after);
    let removed = ok(invoke(
        &f,
        "update_proxy",
        json!({ "proxyId": proxy_id, "expectedVersion": 2, "changes": { "remove_login": true } }),
    ));
    assert_eq!(removed["has_login"], json!(false));
    assert!(mem.accounts().is_empty());

    // Without a working keychain a login is refused, never kept anywhere else.
    if let Ok(mut k) = f.state.keychain.write() {
        *k = KeychainStatus {
            available: false,
            reason: Some("keychain_unavailable"),
        };
    }
    let refused = invoke(
        &f,
        "create_proxy",
        json!({ "proxy": { "name": "B", "type": "socks5", "host": "socks.example.net", "port": 1080,
                           "login": { "username": "u", "password": "p" } } }),
    );
    assert_eq!(code(&refused).as_deref(), Some("KEYCHAIN_UNAVAILABLE"));
    create_proxy(
        &f,
        json!({ "name": "B", "type": "socks5", "host": "socks.example.net", "port": 1080 }),
    );
    assert!(mem.accounts().is_empty());
}

#[test]
fn proxy_settings_are_validated_before_saving() {
    let f = fixture();
    keychain(&f);
    workspace_with_profile(&f);
    let base = json!({ "name": "P", "type": "http", "host": "proxy.example.net", "port": 8080 });
    let with = |patch: Value| {
        let mut p = base.clone();
        if let (Some(p), Some(patch)) = (p.as_object_mut(), patch.as_object()) {
            for (k, v) in patch {
                p.insert(k.clone(), v.clone());
            }
        }
        p
    };
    let cases = [
        (json!({ "type": "socks4" }), "INVALID_PROXY_TYPE"),
        (
            json!({ "host": "http://proxy.example.net" }),
            "PROXY_BAD_HOST",
        ),
        (
            json!({ "host": "user:pw@proxy.example.net" }),
            "PROXY_BAD_HOST",
        ),
        (json!({ "host": "proxy.example.net/x" }), "PROXY_BAD_HOST"),
        (json!({ "host": "proxy example" }), "PROXY_BAD_HOST"),
        (json!({ "port": 0 }), "PROXY_BAD_PORT"),
        (json!({ "port": 70000 }), "PROXY_BAD_PORT"),
        (
            json!({ "login": { "username": "a:b", "password": "c" } }),
            "PROXY_BAD_CREDENTIALS",
        ),
        (
            json!({ "login": { "username": "a", "password": "x".repeat(256) } }),
            "PROXY_BAD_CREDENTIALS",
        ),
        (json!({ "host": "127.0.0.1" }), "PROXY_PRIVATE_ADDRESS"),
        (json!({ "host": "192.168.1.10" }), "PROXY_PRIVATE_ADDRESS"),
        (
            json!({ "host": "169.254.169.254" }),
            "PROXY_FORBIDDEN_ADDRESS",
        ),
        (json!({ "host": "fe80::1" }), "PROXY_FORBIDDEN_ADDRESS"),
        (json!({ "host": "0.0.0.0" }), "PROXY_FORBIDDEN_ADDRESS"),
        (json!({ "expires_at": "2026-13-01" }), "INVALID_DATE"),
        (json!({ "notes": "password: hunter2" }), "NOTES_LOOK_SECRET"),
        (json!({ "name": " " }), "INVALID_PROXY_NAME"),
    ];
    for (patch, expected) in cases {
        let r = invoke(&f, "create_proxy", json!({ "proxy": with(patch.clone()) }));
        assert_eq!(code(&r).as_deref(), Some(expected), "{patch}");
    }
    // A URL with a login, or any unknown field, does not even deserialize.
    let r = invoke(
        &f,
        "create_proxy",
        json!({ "proxy": with(json!({ "url": "http://u:p@proxy.example.net:8080" })) }),
    );
    assert!(r.is_err());
    assert_eq!(ok(invoke(&f, "list_proxies", json!({}))), json!([]));

    // Local proxies need the explicit setting; link-local and metadata addresses never work.
    allow_local_proxies(&f);
    create_proxy(&f, with(json!({ "host": "127.0.0.1" })));
    create_proxy(
        &f,
        with(json!({ "name": "LAN", "host": "192.168.1.10", "type": "socks5" })),
    );
    let r = invoke(
        &f,
        "create_proxy",
        json!({ "proxy": with(json!({ "name": "Meta", "host": "169.254.169.254" })) }),
    );
    assert_eq!(code(&r).as_deref(), Some("PROXY_FORBIDDEN_ADDRESS"));
    let r = invoke(&f, "create_proxy", json!({ "proxy": with(json!({})) }));
    assert_eq!(
        code(&r).as_deref(),
        Some("DUPLICATE_NAME"),
        "names are unique per workspace"
    );
    // Hosts are stored normalised (lower case, no trailing dot).
    let p = create_proxy(
        &f,
        with(json!({ "name": "Case", "host": "Proxy.Example.NET." })),
    );
    assert_eq!(p["host"], json!("proxy.example.net"));
}

// ---------------------------------------------------------------------------------------------- routing

#[test]
fn a_proxied_profile_reaches_sites_only_through_its_gateway() {
    let f = fixture();
    keychain(&f);
    let password = secret();
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), password.clone())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let profile_id = workspace_with_profile(&f);
    allow_local_proxies(&f);
    let proxy_id = local_proxy(&f, "Local", &proxy, Some(("alice", &password)));
    let assigned = assign(&f, &profile_id, Some(&proxy_id), true);
    assert_eq!(
        (
            &assigned["proxy_id"],
            &assigned["proxy_label"],
            &assigned["fail_closed"],
            &assigned["network"]["status"]
        ),
        (
            &json!(proxy_id),
            &json!("Local"),
            &json!(true),
            &json!("ready")
        )
    );

    launch(&f, &profile_id);
    let args = args(&f);
    let port = gateway_port(&args);
    for expected in ["--proxy-bypass-list=<-loopback>", "--disable-quic"] {
        assert!(args.iter().any(|a| a == expected), "{args:?}");
    }
    let joined = args.join(" ");
    assert!(
        !joined.contains(&password) && !joined.contains("alice"),
        "no login on the command line"
    );

    // The site is reached through the proxy, which received the login; the browser itself never sees a 407.
    let (head, body) = tunnel(port, "origin.pb.test:80", "/hello");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /hello"), "{body}");
    // (The test proxy requires the login, so an accepted request carried it.)
    assert!(
        proxy
            .log()
            .iter()
            .any(|e| e.accepted && e.login.as_deref().is_some_and(|l| l.starts_with("Basic ")))
    );
    // Proxied profiles: WebRTC may use only the proxy, and the browser does not pre-connect on its own.
    let p = prefs(&f, &profile_id);
    assert_eq!(
        p["webrtc"]["ip_handling_policy"],
        json!("disable_non_proxied_udp")
    );
    assert_eq!(p["net"]["network_prediction_options"], json!(2));
    assert_eq!(
        profile(&f, &profile_id)["network"]["status"],
        json!("active")
    );

    // Outage: traffic is blocked (not sent directly), the user is told, and it recovers by itself.
    proxy.stop();
    let (head, _) = tunnel(port, "origin.pb.test:80", "/during");
    assert!(head.contains("X-Pb-Error: PROXY_UNREACHABLE"), "{head}");
    f.state.poll_once();
    let failing = warnings(&f, "PROXY_FAILING");
    assert_eq!(failing.len(), 1);
    assert_eq!(failing[0]["profile_id"], json!(profile_id));
    let net = profile(&f, &profile_id)["network"].clone();
    assert_eq!(
        (&net["status"], &net["last_error"]),
        (&json!("failing"), &json!("PROXY_UNREACHABLE"))
    );
    assert_eq!(
        origin.seen().len(),
        1,
        "nothing reached the site during the outage"
    );
    proxy.restart();
    assert!(
        tunnel(port, "origin.pb.test:80", "/after")
            .1
            .contains("origin /after")
    );
    f.state.poll_once();
    assert_eq!(
        profile(&f, &profile_id)["network"]["status"],
        json!("active")
    );

    // Editing the proxy never changes an open profile's route: it asks for a restart instead.
    ok(invoke(
        &f,
        "update_proxy",
        json!({ "proxyId": proxy_id, "expectedVersion": 1, "changes": { "name": "Local (edited)" } }),
    ));
    assert_eq!(
        profile(&f, &profile_id)["network"]["restart_required"],
        json!(true)
    );

    // Closing the profile stops its gateway and forgets the session.
    stop(&f, &profile_id);
    eventually("the gateway to close", || {
        TcpStream::connect(("127.0.0.1", port)).is_err()
    });
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    let pid = pb_runtime::ProfileId::parse(&profile_id).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(store.gateway_session(&pid).ok().flatten(), None);
    let after_close = profile(&f, &profile_id)["network"].clone();
    assert_eq!(
        (&after_close["status"], &after_close["restart_required"]),
        (&json!("ready"), &json!(false))
    );
}

#[test]
fn launch_is_refused_before_anything_starts_when_the_login_is_missing() {
    let f = fixture();
    let mem = keychain(&f);
    let proxy = TestProxy::socks5(ProxyOptions {
        login: Some(("bob".into(), "pw".into())),
        ..Default::default()
    });
    let profile_id = workspace_with_profile(&f);
    allow_local_proxies(&f);
    let proxy_id = local_proxy(&f, "Socks", &proxy, Some(("bob", "pw")));
    assign(&f, &profile_id, Some(&proxy_id), true);
    // The user removed the entry in the OS keychain app (or a Linux session keyring was cleared at logout).
    for a in mem.accounts() {
        mem.forget(&a);
    }
    let r = invoke(&f, "launch_profile", json!({ "profileId": profile_id }));
    assert_eq!(code(&r).as_deref(), Some("PROXY_CREDENTIALS_MISSING"));
    assert_eq!(
        f.launcher.spawns.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    // The check reports it too, as a recorded result the UI can show next to the "enter login" prompt.
    let check = ok(invoke(&f, "test_proxy", json!({ "proxyId": proxy_id })));
    assert_eq!(
        (&check["result"], &check["error_code"]),
        (&json!("error"), &json!("PROXY_CREDENTIALS_MISSING"))
    );
    // Entering the login again (the credential prompt) fixes it.
    ok(invoke(
        &f,
        "update_proxy",
        json!({ "proxyId": proxy_id, "expectedVersion": 1,
                "changes": { "login": { "username": "bob", "password": "pw" } } }),
    ));
    launch(&f, &profile_id);
    assert!(gateway_port(&args(&f)) > 0);
    // A local proxy stops working when the local-address setting is turned off again.
    stop(&f, &profile_id);
    ok(invoke(
        &f,
        "update_setting",
        json!({ "key": "proxies.allow_private_addresses", "value": false }),
    ));
    let r = invoke(&f, "launch_profile", json!({ "profileId": profile_id }));
    assert_eq!(code(&r).as_deref(), Some("PROXY_PRIVATE_ADDRESS"));
}

#[test]
fn fail_open_profiles_go_direct_only_visibly() {
    let f = fixture();
    keychain(&f);
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions::default());
    let profile_id = workspace_with_profile(&f);
    allow_local_proxies(&f);
    let proxy_id = local_proxy(&f, "Flaky", &proxy, None);
    assign(&f, &profile_id, Some(&proxy_id), false);
    launch(&f, &profile_id);
    let port = gateway_port(&args(&f));
    // Without fail-closed routing the profile's own WebRTC choice applies (browser default here).
    assert_eq!(
        prefs(&f, &profile_id)["webrtc"]["ip_handling_policy"],
        Value::Null
    );
    proxy.stop();
    let authority = origin.addr().to_string();
    let (head, body) = tunnel(port, &authority, "/direct");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /direct"));
    f.state.poll_once();
    let bypass = warnings(&f, "PROXY_BYPASSED");
    assert_eq!(bypass.len(), 1, "the user is told once per outage");
    let net = profile(&f, &profile_id)["network"].clone();
    assert_eq!(
        (&net["status"], &net["direct_connections"]),
        (&json!("bypassing"), &json!(1))
    );
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    let audit = store.list_audit(None, 50).unwrap_or_default();
    assert!(
        serde_json::to_string(&audit)
            .unwrap_or_default()
            .contains("direct_fallback")
    );
}

// ---------------------------------------------------------------------------------------------- checks

#[test]
fn connectivity_checks_record_latency_exit_address_and_failures() {
    let f = fixture();
    keychain(&f);
    let service = TestCheckService::start("check.pb.test", "203.0.113.7");
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("carol".into(), "right".into())),
        hosts: hosts(&[("check.pb.test", service.addr())]),
        ..Default::default()
    });
    f.state
        .set_network_settings(pb_desktop_lib::network::NetworkSettings {
            trust: service.ca.trust(),
            check: CheckTarget {
                host: "check.pb.test".into(),
                port: 443,
                path: "/cdn-cgi/trace".into(),
            },
        });
    workspace_with_profile(&f);
    allow_local_proxies(&f);
    let good = local_proxy(&f, "Good", &proxy, Some(("carol", "right")));
    let bad = local_proxy(&f, "Bad", &proxy, Some(("carol", "wrong")));

    let check = ok(invoke(&f, "test_proxy", json!({ "proxyId": good })));
    assert_eq!(
        (&check["result"], &check["egress_ip"], &check["error_code"]),
        (&json!("ok"), &json!("203.0.113.7"), &Value::Null)
    );
    assert!(check["latency_ms"].as_u64().is_some());
    assert!(
        check["checked_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );
    let failed = ok(invoke(&f, "test_proxy", json!({ "proxyId": bad })));
    assert_eq!(
        (
            &failed["result"],
            &failed["error_code"],
            &failed["egress_ip"]
        ),
        (&json!("error"), &json!("PROXY_AUTH_FAILED"), &Value::Null)
    );
    assert_eq!(
        service.requests(),
        1,
        "the failed login never reached the service"
    );
    // The outage case: the proxy is down.
    proxy.stop();
    let down = ok(invoke(&f, "test_proxy", json!({ "proxyId": good })));
    assert_eq!(down["error_code"], json!("PROXY_UNREACHABLE"));

    let history = ok(invoke(&f, "list_proxy_checks", json!({ "proxyId": good })));
    assert_eq!(history.as_array().map(Vec::len), Some(2));
    let listed = ok(invoke(&f, "list_proxies", json!({})));
    let good_view = listed
        .as_array()
        .and_then(|l| l.iter().find(|p| p["id"] == json!(good)))
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        good_view["last_check"]["error_code"],
        json!("PROXY_UNREACHABLE")
    );
    // Checks are diagnostic records only: older than seven days they are deleted.
    let db =
        rusqlite::Connection::open(f.data().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
    db.execute(
        "update network_checks set checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') where result = 'ok'",
        [],
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(store.purge_checks().ok(), Some(1));
}

// ---------------------------------------------------------------------------------------------- assignment

#[test]
fn assignment_is_versioned_scoped_bulk_capable_and_protects_used_proxies() {
    let f = fixture();
    let mem = keychain(&f);
    let a = workspace_with_profile(&f);
    let b = ok(invoke(&f, "create_profile", json!({ "name": "Second" })))["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let px = create_proxy(
        &f,
        json!({ "name": "Shared", "type": "https", "host": "secure-proxy.example.net", "port": 443,
                "login": { "username": "u", "password": "p" } }),
    )["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // Stale versions and proxies of another workspace are refused.
    let stale = invoke(
        &f,
        "assign_proxy",
        json!({ "profileId": a, "proxyId": px, "failClosed": true, "expectedVersion": 0 }),
    );
    assert_eq!(code(&stale).as_deref(), Some("VERSION_CONFLICT"));
    let unknown = invoke(
        &f,
        "assign_proxy",
        json!({ "profileId": a, "proxyId": "prx_01J9ZSEED0A010000000000000", "failClosed": true,
                "expectedVersion": profile_version(&f, &a) }),
    );
    assert_eq!(code(&unknown).as_deref(), Some("UNKNOWN_PROXY"));

    // Bulk assignment with undo, and a filter by proxy.
    let sel = json!({ "kind": "ids", "ids": [a, b] });
    let r = ok(invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "set_proxy", "proxy_id": px, "fail_closed": true }, "selection": sel }),
    ));
    assert_eq!(r["changed"], json!(2));
    let page = ok(invoke(
        &f,
        "query_profiles",
        json!({ "filter": { "proxy": px } }),
    ));
    assert_eq!(page["total"], json!(2));
    // Duplicates keep the proxy and settings (never the browser data).
    let dup = ok(invoke(
        &f,
        "duplicate_profile",
        json!({ "profileId": a, "name": "Copy" }),
    ));
    assert_eq!(dup["proxy_id"], json!(px));

    // A used proxy cannot be deleted; once unassigned it can, and its keychain entry goes with it.
    let r = invoke(&f, "delete_proxy", json!({ "proxyId": px }));
    assert_eq!(code(&r).as_deref(), Some("PROXY_IN_USE"));
    let token = unassign_with_undo(&f, &a, &b, &px);
    assert!(token.is_some());
    let dup_id = dup["id"].as_str().unwrap_or_default().to_owned();
    assign(&f, &dup_id, None, true);
    assert_eq!(mem.accounts().len(), 1);
    ok(invoke(&f, "delete_proxy", json!({ "proxyId": px })));
    assert!(mem.accounts().is_empty());
    assert_eq!(ok(invoke(&f, "list_proxies", json!({}))), json!([]));
}

/// Unassigns `a` and `b` with a bulk action, undoes it, then unassigns them again; returns the undo token.
fn unassign_with_undo(f: &Fixture, a: &str, b: &str, px: &str) -> Option<String> {
    let sel = json!({ "kind": "ids", "ids": [a, b] });
    let r = ok(invoke(
        f,
        "bulk_profiles",
        json!({ "action": { "action": "set_proxy", "proxy_id": null, "fail_closed": true }, "selection": sel }),
    ));
    let token = r["undo_token"].as_str().map(str::to_owned);
    ok(invoke(f, "undo_action", json!({ "token": token })));
    assert_eq!(
        profile(f, a)["proxy_id"],
        json!(px),
        "undo restores the proxy"
    );
    ok(invoke(
        f,
        "bulk_profiles",
        json!({ "action": { "action": "set_proxy", "proxy_id": null, "fail_closed": true }, "selection": sel }),
    ));
    token
}

// ---------------------------------------------------------------------------------------------- privacy

#[test]
fn privacy_and_environment_settings_are_validated_and_applied_at_launch() {
    let f = fixture();
    let profile_id = workspace_with_profile(&f);
    let options = ok(invoke(&f, "get_privacy_options", json!({})));
    assert!(
        options["presets"]
            .as_array()
            .is_some_and(|p| p.iter().any(|x| x["id"] == json!("accessibility")))
    );
    assert!(
        options["languages"]
            .as_array()
            .is_some_and(|l| l.iter().any(|x| x["tag"] == json!("ne-NP")))
    );

    let config = json!({ "webrtc": "public_interface_only", "block_third_party_cookies": true,
        "do_not_track": true, "language": "de-DE", "timezone": "Europe/Berlin",
        "window": { "width": 1366, "height": 768 }, "text_size": "larger", "reduced_motion": true,
        "preset": "locale-de-de" });
    let v = ok(invoke(&f, "validate_privacy", json!({ "config": config })));
    assert_eq!(v["valid"], json!(true));
    let tz = v["report"]
        .as_array()
        .and_then(|r| r.iter().find(|x| x["field"] == json!("timezone")))
        .cloned()
        .unwrap_or_default();
    let expected_tz = if cfg!(windows) {
        "unavailable"
    } else {
        "applied"
    };
    assert_eq!(tz["support"], json!(expected_tz));
    // With a fail-closed proxy, WebRTC is reported as proxy-only whatever the profile chose.
    let v = ok(invoke(
        &f,
        "validate_privacy",
        json!({ "config": config, "failClosedProxy": true }),
    ));
    assert!(v.to_string().contains("set by fail-closed routing"));
    for (bad, expected) in [
        (json!({ "language": "xx-XX" }), "INVALID_LANGUAGE"),
        (json!({ "timezone": "Mars/Base" }), "INVALID_TIMEZONE"),
        (
            json!({ "window": { "width": 100, "height": 100 } }),
            "INVALID_WINDOW_SIZE",
        ),
    ] {
        let v = ok(invoke(&f, "validate_privacy", json!({ "config": bad })));
        assert_eq!(
            (&v["valid"], &v["error"]["code"]),
            (&json!(false), &json!(expected))
        );
        let r = invoke(
            &f,
            "update_profile",
            json!({ "profileId": profile_id, "expectedVersion": profile_version(&f, &profile_id), "privacy": bad }),
        );
        assert_eq!(code(&r).as_deref(), Some(expected));
    }
    // Unknown settings (e.g. a fingerprint knob) do not deserialize.
    let r = invoke(
        &f,
        "update_profile",
        json!({ "profileId": profile_id, "expectedVersion": profile_version(&f, &profile_id),
                "privacy": { "canvas_noise": true } }),
    );
    assert!(r.is_err());

    let saved = ok(invoke(
        &f,
        "update_profile",
        json!({ "profileId": profile_id, "expectedVersion": profile_version(&f, &profile_id), "privacy": config }),
    ));
    assert_eq!(saved["privacy"]["timezone"], json!("Europe/Berlin"));
    launch(&f, &profile_id);
    let args = args(&f);
    for expected in [
        "--lang=de-DE",
        "--window-size=1366,768",
        "--force-prefers-reduced-motion",
    ] {
        assert!(args.iter().any(|a| a == expected), "{expected}: {args:?}");
    }
    assert!(!args.iter().any(|a| a.starts_with("--proxy-server")));
    let env = f
        .launcher
        .last_env
        .lock()
        .map(|e| e.clone())
        .unwrap_or_default();
    let tz_env: Vec<_> = env.iter().filter(|(k, _)| k == "TZ").collect();
    if cfg!(windows) {
        assert!(tz_env.is_empty());
    } else {
        assert_eq!(tz_env, [&("TZ".to_owned(), "Europe/Berlin".to_owned())]);
    }
    let p = prefs(&f, &profile_id);
    assert_eq!(p["intl"]["accept_languages"], json!("de-DE,de"));
    assert_eq!(p["enable_do_not_track"], json!(true));
    assert_eq!(
        p["webrtc"]["ip_handling_policy"],
        json!("default_public_interface_only")
    );
    assert_eq!(p["webkit"]["webprefs"]["default_font_size"], json!(24));
    assert_eq!(p["profile"]["block_third_party_cookies"], json!(true));
    assert_ne!(
        p["net"]["network_prediction_options"],
        json!(2),
        "unchanged without a proxy"
    );

    // Changing settings of an open profile takes effect after a restart, and says so.
    ok(invoke(
        &f,
        "update_profile",
        json!({ "profileId": profile_id, "expectedVersion": profile_version(&f, &profile_id),
                "privacy": { "language": "ja-JP" } }),
    ));
    assert_eq!(
        profile(&f, &profile_id)["network"]["restart_required"],
        json!(true)
    );
    stop(&f, &profile_id);
    launch(&f, &profile_id);
    assert_eq!(
        prefs(&f, &profile_id)["intl"]["accept_languages"],
        json!("ja-JP,ja")
    );
    assert_eq!(
        prefs(&f, &profile_id)["webrtc"]["ip_handling_policy"],
        Value::Null,
        "settings back at their default are removed"
    );
}

// ---------------------------------------------------------------------------------------------- restart

#[test]
fn gateways_come_back_for_profiles_left_running_across_a_manager_restart() {
    let procs = Arc::new(FakeProcesses::default());
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let mem = Arc::new(MemoryStore::default());
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("dave".into(), "pw".into())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let first = fixture_in(tmp, procs.clone());
    first.state.use_secret_store(mem.clone());
    let profile_id = workspace_with_profile(&first);
    allow_local_proxies(&first);
    let proxy_id = local_proxy(&first, "Local", &proxy, Some(("dave", "pw")));
    assign(&first, &profile_id, Some(&proxy_id), true);
    launch(&first, &profile_id);
    let port = gateway_port(&args(&first));
    // The manager quits and leaves the profile running: its gateway goes away with it.
    let Fixture {
        tmp,
        webview,
        _app,
        state,
        launcher,
        ..
    } = first;
    drop((webview, _app, launcher));
    state.supervisor.detach_all();
    state.stop_all_gateways();
    drop(state);
    eventually("the old gateway to close", || {
        TcpStream::connect(("127.0.0.1", port)).is_err()
    });

    let second = fixture_in(tmp, procs);
    second.state.use_secret_store(mem);
    second.state.restore_networks();
    let restored = profile(&second, &profile_id);
    assert_eq!(restored["network"]["status"], json!("active"));
    let (head, body) = tunnel(port, "origin.pb.test:80", "/again");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /again"));
}
