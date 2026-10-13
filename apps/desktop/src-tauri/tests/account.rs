//! Milestone 06 desktop acceptance tests: sign-in through the system browser (Authorization Code + PKCE, state,
//! nonce, issuer check), the session kept in the keychain only, refresh rotation, revoked and expired sessions,
//! offline organization data shown as stale, sign-out, and copying a local workspace into an organization.
//!
//! A small HTTP server on 127.0.0.1 plays both the identity provider and the API with the same contract as the real
//! ones (services/api tests cover the API, `keycloak.test.ts` the real provider).

mod support;

use pb_desktop_lib::deeplink::{self, Outcome};
use pb_desktop_lib::secrets::{KeychainStatus, MemoryStore, SecretStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use support::*;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";

// ----------------------------------------------------------------------------- mock provider + API
#[derive(Clone, Debug)]
struct Req {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Default)]
struct World {
    issuer: String,
    /// code -> (challenge, nonce) registered when the "browser" visits the authorization URL.
    codes: HashMap<String, (String, String)>,
    /// nonce the API expects with the ID token (set by the token endpoint).
    nonce: Option<String>,
    refresh: Option<String>,
    access: Option<String>,
    generation: u32,
    enrolled_device: Option<String>,
    import_keys: Vec<String>,
}

struct Mock {
    base: String,
    addr: SocketAddr,
    log: Arc<Mutex<Vec<Req>>>,
    world: Arc<Mutex<World>>,
    stop: Arc<AtomicBool>,
}

const DEVICE: &str = "dev_01J9ZSEED0D1D1000000000000";
const USER: &str = "usr_01J9ZSEED0U100000000000000";

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Mock {
    fn start() -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let base = format!("http://{addr}");
        let world = Arc::new(Mutex::new(World {
            issuer: format!("{base}/idp"),
            ..World::default()
        }));
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (w, l, s) = (world.clone(), log.clone(), stop.clone());
        let b = base.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if s.load(Ordering::SeqCst) {
                    break; // the listener is dropped: connections are refused from now on
                }
                let Ok(stream) = stream else { continue };
                let (w, l, b) = (w.clone(), l.clone(), b.clone());
                std::thread::spawn(move || serve(stream, &b, &w, &l));
            }
        });
        Mock {
            base,
            addr,
            log,
            world,
            stop,
        }
    }

    /// The server goes away (connection refused).
    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    fn requests(&self, method: &str, path: &str) -> Vec<Req> {
        self.log
            .lock()
            .map(|l| {
                l.iter()
                    .filter(|r| r.method == method && r.path.split('?').next() == Some(path))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap_or_else(|e| panic!("{e}"))
    }
}

fn serve(stream: TcpStream, base: &str, world: &Mutex<World>, log: &Mutex<Vec<Req>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap_or_else(|e| panic!("{e}")));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.is_empty() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; len];
    let _ = reader.read_exact(&mut body);
    let req = Req {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    if let Ok(mut l) = log.lock() {
        l.push(req.clone());
    }
    let (status, body) = {
        let mut w = world.lock().unwrap_or_else(|e| panic!("{e}"));
        route(&req, base, &mut w)
    };
    let text = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    let mut out = stream;
    let _ = write!(
        out,
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
}

fn unauthenticated(reason: &str) -> (u16, Value) {
    (
        401,
        json!({ "code": "UNAUTHENTICATED", "message": "no", "request_id": "req_x", "retryable": false,
                "safe_details": { "reason": reason } }),
    )
}

fn session(w: &mut World) -> Value {
    w.generation += 1;
    let refresh = format!("ses_01J9ZSEED0S100000000000000.r{:0>42}", w.generation);
    let access = format!("access-{}", w.generation);
    w.refresh = Some(refresh.clone());
    w.access = Some(access.clone());
    json!({
        "access_token": access, "token_type": "Bearer", "expires_in": 600, "refresh_token": refresh,
        "refresh_expires_at": "2026-11-01T00:00:00.000000Z", "auth_time": "2026-10-13T00:00:00.000000Z",
        "device": { "id": DEVICE, "name": "Project Browser on Linux", "platform": "linux-x64",
                    "created_at": "2026-10-13T00:00:00.000000Z", "last_seen_at": null, "revoked_at": null, "current": true },
        "user": { "id": USER, "display_name": "Alice", "email": "alice@people.test", "email_verified": true },
    })
}

fn route(req: &Req, base: &str, w: &mut World) -> (u16, Value) {
    let json_body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
    let bearer = req
        .headers
        .get("authorization")
        .and_then(|a| a.strip_prefix("Bearer "))
        .map(str::to_owned);
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/auth/config") => (
            200,
            json!({ "issuer": w.issuer, "client_id": "pb-desktop", "redirect_uri": "projectbrowser://auth/callback",
                    "scopes": ["openid", "email", "profile"] }),
        ),
        ("GET", "/idp/.well-known/openid-configuration") => (
            200,
            json!({ "issuer": w.issuer, "authorization_endpoint": format!("{base}/idp/auth"),
                    "token_endpoint": format!("{base}/idp/token"), "code_challenge_methods_supported": ["S256"] }),
        ),
        ("POST", "/idp/token") => {
            let form: HashMap<String, String> = url::form_urlencoded::parse(req.body.as_bytes())
                .into_owned()
                .collect();
            let code = form.get("code").cloned().unwrap_or_default();
            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
            match w.codes.remove(&code) {
                Some((challenge, nonce))
                    if b64url(&Sha256::digest(verifier.as_bytes())) == challenge
                        && form.get("grant_type").map(String::as_str)
                            == Some("authorization_code")
                        && form.get("redirect_uri").map(String::as_str)
                            == Some("projectbrowser://auth/callback")
                        && form.get("client_id").map(String::as_str) == Some("pb-desktop") =>
                {
                    w.nonce = Some(nonce);
                    (
                        200,
                        json!({ "id_token": "aGVhZGVy.cGF5bG9hZA.c2ln", "access_token": "idp-access",
                                "refresh_token": "idp-refresh", "token_type": "Bearer" }),
                    )
                }
                _ => (400, json!({ "error": "invalid_grant" })),
            }
        }
        ("POST", "/v1/devices") => {
            if json_body["nonce"].as_str() != w.nonce.as_deref() {
                return unauthenticated("id_token_invalid");
            }
            w.enrolled_device = Some(DEVICE.into());
            (201, session(w))
        }
        ("POST", "/v1/auth/token") => match json_body["grant_type"].as_str() {
            Some("refresh_token")
                if json_body["refresh_token"].as_str() == w.refresh.as_deref() =>
            {
                (200, session(w))
            }
            Some("id_token")
                if json_body["device_id"].as_str() == w.enrolled_device.as_deref()
                    && json_body["nonce"].as_str() == w.nonce.as_deref() =>
            {
                (200, session(w))
            }
            Some("id_token") => unauthenticated("device_not_enrolled"),
            _ => unauthenticated("session_ended"),
        },
        _ if bearer.is_none() || bearer != w.access => unauthenticated("token_invalid"),
        ("POST", "/v1/auth/sign-out") => {
            w.refresh = None;
            w.access = None;
            (204, Value::Null)
        }
        ("GET", "/v1/me/workspaces") => (
            200,
            json!({ "items": [{ "kind": "organization", "org_id": ORG, "name": "Acme", "role": "owner", "profiles": 2 }] }),
        ),
        ("POST", p) if p == format!("/v1/orgs/{ORG}/local-import") => {
            let dry = json_body["dry_run"].as_bool().unwrap_or(true);
            if !dry {
                let key = req
                    .headers
                    .get("idempotency-key")
                    .cloned()
                    .unwrap_or_default();
                w.import_keys.push(key);
            }
            let profiles: Vec<Value> = json_body["profiles"]
                .as_array()
                .map(|ps| {
                    ps.iter()
                        .enumerate()
                        .map(|(i, p)| {
                            json!({ "local_id": p["local_id"],
                                    "profile_id": if dry { Value::Null } else { json!(format!("prf_01J9ZSEED0R{i:0>15}")) },
                                    "outcome": "create" })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let clients: Vec<Value> = json_body["clients"]
                .as_array()
                .map(|cs| {
                    cs.iter()
                        .map(|c| json!({ "ref": c["ref"], "client_id": c.get("map_to").cloned().unwrap_or(Value::Null),
                                         "outcome": if c.get("map_to").is_some() { "mapped" } else { "create" } }))
                        .collect()
                })
                .unwrap_or_default();
            (
                if dry { 200 } else { 201 },
                json!({ "dry_run": dry, "clients": clients, "profiles": profiles }),
            )
        }
        (_, p) if p.starts_with("/v1/") => (
            200,
            json!({ "path": p, "if_match": req.headers.get("if-match") }),
        ),
        _ => (404, json!({ "code": "NOT_FOUND" })),
    }
}

// ----------------------------------------------------------------------------- helpers
fn ok(r: Result<Value, Value>) -> Value {
    r.unwrap_or_else(|e| panic!("{e}"))
}

fn keychain(f: &Fixture) -> Arc<MemoryStore> {
    let mem = Arc::new(MemoryStore::default());
    f.state.use_secret_store(mem.clone());
    mem
}

/// The browser part of a sign-in: read the authorization URL, "log in" (register a code) and come back.
fn browser_round_trip(
    f: &Fixture,
    mock: &Mock,
    reauth: bool,
    iss: Option<&str>,
) -> (Outcome, HashMap<String, String>) {
    let url = f
        .state
        .begin_sign_in(reauth)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert!(
        url.as_str()
            .starts_with(&format!("{}/idp/auth?", mock.base))
    );
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let code = format!(
        "authorization-code-{:04}",
        mock.log.lock().map(|l| l.len()).unwrap_or(0)
    );
    mock.world().codes.insert(
        code.clone(),
        (q["code_challenge"].clone(), q["nonce"].clone()),
    );
    let issuer = mock.world().issuer.clone();
    let iss: String =
        url::form_urlencoded::byte_serialize(iss.unwrap_or(&issuer).as_bytes()).collect();
    let raw = format!(
        "projectbrowser://auth/callback?state={}&session_state=4f1c2a9e-1b2c-4d5e-8f90-123456789abc&iss={iss}&code={code}",
        q["state"]
    );
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    let (outcome, callback) = deeplink::handle(&raw, Some(&store));
    if let Some(cb) = callback {
        f.state.finish_sign_in(&cb);
    }
    (outcome, q)
}

fn connect(f: &Fixture, mock: &Mock) {
    ok(invoke(
        f,
        "set_cloud_server",
        json!({ "url": format!("{}/", mock.base) }),
    ));
}

fn last_account_event(f: &Fixture) -> Value {
    f.events
        .events
        .lock()
        .ok()
        .and_then(|e| {
            e.iter()
                .rev()
                .find(|(n, _)| n == "account")
                .map(|(_, v)| v.clone())
        })
        .unwrap_or(Value::Null)
}

fn request(f: &Fixture, method: &str, path: &str) -> Result<Value, Value> {
    invoke(
        f,
        "cloud_request",
        json!({ "method": method, "path": path }),
    )
}

/// Every byte of the local database (and its WAL) as text, to prove a secret never reached it.
fn local_files(f: &Fixture) -> String {
    let mut all = Vec::new();
    for name in ["local.db", "local.db-wal"] {
        if let Ok(b) = std::fs::read(f.data().join(name)) {
            all.extend(b);
        }
    }
    String::from_utf8_lossy(&all).into_owned()
}

// ----------------------------------------------------------------------------- tests
#[test]
fn signs_in_with_pkce_and_keeps_only_the_refresh_token_in_the_keychain() {
    let f = fixture();
    let mem = keychain(&f);
    let mock = Mock::start();
    connect(&f, &mock);
    assert_eq!(
        ok(invoke(&f, "get_account", json!({})))["server_url"],
        json!(mock.base)
    );

    let (outcome, q) = browser_round_trip(&f, &mock, false, None);
    assert_eq!(outcome, Outcome::Accepted);
    assert_eq!(q["code_challenge_method"], "S256");
    assert!(!q.contains_key("prompt"));
    assert_eq!(last_account_event(&f)["status"], "signed_in");

    let account = ok(invoke(&f, "get_account", json!({})));
    assert_eq!(account["status"], "signed_in");
    assert_eq!(account["user"]["email"], "alice@people.test");
    assert_eq!(account["device_id"], DEVICE);
    assert_eq!(account["session_saved"], true);

    // The provider got the verifier matching the challenge (checked by the mock) and only the API got the ID token.
    assert_eq!(mock.requests("POST", "/idp/token").len(), 1);
    let enroll = &mock.requests("POST", "/v1/devices")[0];
    let body: Value = serde_json::from_str(&enroll.body).unwrap_or(Value::Null);
    assert_eq!(body["nonce"], json!(q["nonce"]));
    assert_eq!(body["platform"], "linux-x64");

    // Keychain: exactly the refresh token. Database and WAL: no token of any kind.
    let refresh = mock.world().refresh.clone().unwrap_or_default();
    assert_eq!(mem.accounts(), vec!["cloud-session".to_owned()]);
    assert_eq!(
        mem.get("cloud-session").ok().flatten(),
        Some(refresh.clone())
    );
    let files = local_files(&f);
    for secret in [
        refresh.as_str(),
        "access-1",
        "idp-refresh",
        "idp-access",
        "aGVhZGVy.cGF5bG9hZA.c2ln",
        &q["code_challenge"],
    ] {
        assert!(
            !files.contains(secret),
            "{secret} reached the local database"
        );
    }
    // The window can never read a token.
    assert!(!account.to_string().contains("access-1"));
}

#[test]
fn refuses_replayed_mismatched_or_unknown_callbacks() {
    let f = fixture();
    keychain(&f);
    let mock = Mock::start();
    connect(&f, &mock);

    // A response naming another issuer (mix-up attack) is refused before any code exchange.
    let (outcome, _) = browser_round_trip(&f, &mock, false, Some("https://evil.example.test"));
    assert_eq!(outcome, Outcome::Accepted);
    assert_eq!(last_account_event(&f)["code"], "SIGN_IN_ISSUER_MISMATCH");
    assert!(mock.requests("POST", "/idp/token").is_empty());
    assert_eq!(
        ok(invoke(&f, "get_account", json!({})))["status"],
        "signed_out"
    );

    // A callback whose state this device never issued is not even bound.
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    let forged =
        "projectbrowser://auth/callback?state=attacker-state-0123456789&code=attacker-code-0123";
    assert_eq!(
        deeplink::handle(forged, Some(&store)).0,
        Outcome::UnknownTransaction
    );

    // A real callback replayed after use is refused.
    let url = f
        .state
        .begin_sign_in(false)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    mock.world().codes.insert(
        "replay-code-0123456".into(),
        (q["code_challenge"].clone(), q["nonce"].clone()),
    );
    let raw = format!(
        "projectbrowser://auth/callback?state={}&code=replay-code-0123456",
        q["state"]
    );
    let (first, cb) = deeplink::handle(&raw, Some(&store));
    assert_eq!(first, Outcome::Accepted);
    if let Some(cb) = cb {
        f.state.finish_sign_in(&cb);
    }
    assert_eq!(last_account_event(&f)["status"], "signed_in");
    assert_eq!(
        deeplink::handle(&raw, Some(&store)).0,
        Outcome::ReplayedTransaction
    );

    // A cancelled attempt: its (valid, unused) callback no longer completes anything.
    let url = f
        .state
        .begin_sign_in(false)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    ok(invoke(&f, "cancel_sign_in", json!({})));
    let raw = format!(
        "projectbrowser://auth/callback?state={}&code=late-code-012345678",
        q["state"]
    );
    let (outcome, cb) = deeplink::handle(&raw, Some(&store));
    assert_eq!(outcome, Outcome::Accepted);
    if let Some(cb) = cb {
        f.state.finish_sign_in(&cb);
    }
    assert_eq!(last_account_event(&f)["code"], "SIGN_IN_INTERRUPTED");
    // The earlier session is still there.
    assert_eq!(
        ok(invoke(&f, "get_account", json!({})))["status"],
        "signed_in"
    );
}

#[test]
fn requests_refresh_on_401_rotate_the_keychain_and_fall_back_to_stale_data_offline() {
    let f = fixture();
    let mem = keychain(&f);
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);

    let first = ok(request(&f, "GET", "/v1/me/workspaces"));
    assert_eq!(first["status"], 200);
    assert_eq!(first["stale"], false);
    assert_eq!(first["body"]["items"][0]["org_id"], ORG);

    // The server stops accepting the access token (revoked or expired early): one refresh, then the retry works.
    mock.world().access = Some("something-else".into());
    let before = mem.get("cloud-session").ok().flatten();
    let again = ok(request(&f, "GET", "/v1/me/workspaces"));
    assert_eq!(again["status"], 200);
    assert_eq!(mock.requests("POST", "/v1/auth/token").len(), 1);
    let after = mem.get("cloud-session").ok().flatten();
    assert_ne!(
        before, after,
        "the rotated refresh token replaced the old one"
    );
    assert_eq!(after, mock.world().refresh.clone());

    // Requests outside the allow-list never leave the manager.
    let refused = request(
        &f,
        "POST",
        &format!("/v1/orgs/{ORG}/profiles/prf_01J9ZSEED0A010000000000000/lease"),
    );
    assert_eq!(code(&refused).as_deref(), Some("CLOUD_NOT_ALLOWED"));
    let refused = request(&f, "POST", "/v1/auth/token");
    assert_eq!(code(&refused).as_deref(), Some("CLOUD_NOT_ALLOWED"));
    let edits = invoke(
        &f,
        "cloud_request",
        json!({ "method": "PATCH", "path": format!("/v1/orgs/{ORG}"), "body": { "name": "x" }, "ifMatch": "\"4\"" }),
    );
    assert_eq!(ok(edits)["body"]["if_match"], "\"4\"");

    // Offline: reads come from the cache, marked stale; changes are refused.
    mock.shutdown();
    let stale = ok(request(&f, "GET", "/v1/me/workspaces"));
    assert_eq!(stale["stale"], true);
    assert!(stale["fetched_at"].is_string());
    assert_eq!(stale["body"], first["body"]);
    let write = invoke(
        &f,
        "cloud_request",
        json!({ "method": "POST", "path": "/v1/organizations", "body": { "name": "New" } }),
    );
    assert_eq!(code(&write).as_deref(), Some("CLOUD_OFFLINE"));
    let uncached = request(&f, "GET", &format!("/v1/orgs/{ORG}/members"));
    assert_eq!(code(&uncached).as_deref(), Some("CLOUD_OFFLINE"));
    // Still signed in: being offline does not end the session.
    assert_eq!(
        ok(invoke(&f, "get_account", json!({})))["status"],
        "signed_in"
    );
}

#[test]
fn an_ended_session_signs_out_without_touching_local_data() {
    let f = fixture();
    let mem = keychain(&f);
    let local = workspace_with_profile(&f);
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);
    ok(request(&f, "GET", "/v1/me/workspaces"));

    // Revoked elsewhere (device revoked, signed out everywhere): access and refresh both stop working.
    {
        let mut w = mock.world();
        w.access = Some("revoked".into());
        w.refresh = Some("revoked".into());
    }
    let res = ok(request(&f, "GET", "/v1/me/workspaces"));
    assert_eq!(res["stale"], true, "cached data is still shown, as stale");
    assert_eq!(last_account_event(&f)["status"], "expired");
    let account = ok(invoke(&f, "get_account", json!({})));
    assert_eq!(account["status"], "expired");
    assert!(
        mem.accounts().is_empty(),
        "the dead refresh token is gone from the keychain"
    );
    // Nothing local was removed.
    let profiles = ok(invoke(&f, "list_profiles", json!({})));
    assert_eq!(profiles[0]["id"], json!(local));
    // Changes need a new sign-in.
    let write = invoke(
        &f,
        "cloud_request",
        json!({ "method": "POST", "path": "/v1/organizations", "body": {} }),
    );
    assert_eq!(code(&write).as_deref(), Some("CLOUD_SIGNED_OUT"));
}

#[test]
fn sign_out_ends_the_session_and_forgets_cached_organization_data() {
    let f = fixture();
    let mem = keychain(&f);
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);
    ok(request(&f, "GET", "/v1/me/workspaces"));
    let out = ok(invoke(&f, "sign_out", json!({})));
    assert_eq!(out["status"], "signed_out");
    assert!(out["user"].is_null());
    assert_eq!(mock.requests("POST", "/v1/auth/sign-out").len(), 1);
    assert!(mem.accounts().is_empty());
    assert_eq!(
        code(&request(&f, "GET", "/v1/me/workspaces")).as_deref(),
        Some("CLOUD_SIGNED_OUT")
    );
    assert_eq!(last_account_event(&f)["status"], "signed_out");
    // The device stays enrolled: the next sign-in starts a session on it instead of enrolling again.
    browser_round_trip(&f, &mock, false, None);
    assert_eq!(mock.requests("POST", "/v1/devices").len(), 1);
}

#[test]
fn reauthentication_asks_for_a_fresh_login_on_the_enrolled_device() {
    let f = fixture();
    keychain(&f);
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);
    let (_, q) = browser_round_trip(&f, &mock, true, None);
    assert_eq!(q["prompt"], "login");
    assert_eq!(q["max_age"], "0");
    let event = last_account_event(&f);
    assert_eq!(event["status"], "signed_in");
    assert_eq!(event["reauth"], true);
    let grants: Vec<Value> = mock
        .requests("POST", "/v1/auth/token")
        .iter()
        .map(|r| serde_json::from_str(&r.body).unwrap_or(Value::Null))
        .collect();
    assert_eq!(
        grants.last().map(|g| g["grant_type"].clone()),
        Some(json!("id_token"))
    );
    assert_eq!(
        grants.last().map(|g| g["device_id"].clone()),
        Some(json!(DEVICE))
    );

    // A device the server no longer knows (revoked): the same ID token enrolls it again.
    mock.world().enrolled_device = Some("dev_01J9ZSEED0ZZZZ000000000000".into());
    browser_round_trip(&f, &mock, false, None);
    assert_eq!(last_account_event(&f)["status"], "signed_in");
    assert_eq!(mock.requests("POST", "/v1/devices").len(), 2);
}

#[test]
fn without_a_keychain_the_session_lives_in_memory_only() {
    let f = fixture();
    let mem = keychain(&f);
    if let Ok(mut k) = f.state.keychain.write() {
        *k = KeychainStatus {
            available: false,
            reason: Some("keychain_unavailable"),
        };
    }
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);
    let account = ok(invoke(&f, "get_account", json!({})));
    assert_eq!(account["status"], "signed_in");
    assert_eq!(account["session_saved"], false);
    assert!(mem.accounts().is_empty());
    let refresh = mock.world().refresh.clone().unwrap_or_default();
    assert!(!local_files(&f).contains(&refresh));
    assert_eq!(ok(request(&f, "GET", "/v1/me/workspaces"))["status"], 200);
}

#[test]
fn server_address_rules() {
    let f = fixture();
    for bad in [
        "http://api.example.test",
        "ftp://api.example.test",
        "https://user:pw@api.example.test",
        "https://api.example.test/?x=1",
        "not a url",
    ] {
        let r = invoke(&f, "set_cloud_server", json!({ "url": bad }));
        assert_eq!(code(&r).as_deref(), Some("CLOUD_BAD_SERVER"), "{bad}");
    }
    let r = ok(invoke(
        &f,
        "set_cloud_server",
        json!({ "url": "https://api.example.test/base/" }),
    ));
    assert_eq!(r["server_url"], "https://api.example.test/base");
    let r = invoke(
        &f,
        "cloud_request",
        json!({ "method": "GET", "path": "/v1/me" }),
    );
    assert_eq!(code(&r).as_deref(), Some("CLOUD_SIGNED_OUT"));
    let r = ok(invoke(&f, "set_cloud_server", json!({ "url": null })));
    assert!(r["server_url"].is_null());
    let r = invoke(&f, "begin_sign_in", json!({}));
    assert_eq!(code(&r).as_deref(), Some("CLOUD_NOT_CONFIGURED"));
}

#[test]
fn copies_a_local_workspace_into_an_organization_after_a_preview() {
    let f = fixture();
    keychain(&f);
    ok(invoke(&f, "create_workspace", json!({ "name": "Agency" })));
    for (name, client) in [
        ("Shop", "North"),
        ("Ads", "North"),
        ("Mail", "South"),
        ("Loose", ""),
    ] {
        let mut args = json!({ "name": name });
        if !client.is_empty() {
            args["client"] = json!(client);
        }
        ok(invoke(&f, "create_profile", args));
    }
    let workspace = ok(invoke(&f, "get_app_state", json!({})))["active_workspace_id"].clone();
    let mock = Mock::start();
    connect(&f, &mock);
    browser_round_trip(&f, &mock, false, None);

    let args = |dry: bool, mapping: Value| json!({ "workspaceId": workspace, "orgId": ORG, "dryRun": dry, "mapping": mapping });
    let preview = ok(invoke(&f, "org_import", args(true, json!({}))));
    assert_eq!(preview["status"], 200);
    assert_eq!(preview["profiles"], 4);
    assert_eq!(preview["linked"], 0);
    let clients = preview["clients"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        clients
            .iter()
            .map(|c| c["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("North"), json!("South")]
    );
    assert!(f.state.org_links(None).unwrap_or_default().is_empty());

    // Map "North" to an existing organization client, create "South".
    let north = clients[0]["ref"].as_str().unwrap_or_default().to_owned();
    let mapping = json!({ north.clone(): "cli_01J9ZSEED0AN00000000000000" });
    let sent: Value = serde_json::from_str(
        &mock.requests("POST", &format!("/v1/orgs/{ORG}/local-import"))[0].body,
    )
    .unwrap_or(Value::Null);
    assert_eq!(sent["dry_run"], true);
    assert!(sent.to_string().contains("\"Loose\""));

    let commit = ok(invoke(&f, "org_import", args(false, mapping.clone())));
    assert_eq!(commit["status"], 201);
    assert_eq!(commit["linked"], 4);
    assert_eq!(commit["body"]["clients"][0]["outcome"], "mapped");
    let links = f.state.org_links(Some(ORG)).unwrap_or_default();
    assert_eq!(links.len(), 4);
    // The local records stay exactly as they were.
    let local = ok(invoke(&f, "list_profiles", json!({})));
    assert_eq!(local.as_array().map(Vec::len), Some(4));

    // A retry of the same copy uses the same idempotency key (the server replays its first answer).
    ok(invoke(&f, "org_import", args(false, mapping)));
    let keys = mock.world().import_keys.clone();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1]);
    assert_eq!(keys[0].len(), 64);

    let refused = invoke(
        &f,
        "org_import",
        json!({ "workspaceId": workspace, "orgId": "acme", "dryRun": true }),
    );
    assert_eq!(code(&refused).as_deref(), Some("INVALID_ARGUMENT"));
}
