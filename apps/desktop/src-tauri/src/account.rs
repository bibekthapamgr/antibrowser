//! The signed-in account and organizations (milestone 06, ADR-0013).
//!
//! Sign-in: the manager asks our API for its identity-provider settings, discovers the provider, and opens the
//! system browser with an Authorization Code + PKCE request (fresh state, nonce and verifier, kept in memory; the
//! state is also recorded once in the local store). The provider redirects to `projectbrowser://auth/callback`; the
//! deep-link code binds the callback to that one-time state, then [`AppState::finish_sign_in`] checks the issuer,
//! exchanges the code for an ID token and hands that token to the API once, which returns this device's session.
//!
//! Session: the refresh token is kept in the OS keychain (in memory only when no keychain works; never on disk); the
//! short-lived access token stays in memory. Refreshes are serialized. When the session ends (signed out elsewhere,
//! device revoked, expired), the account is shown as signed out — local profiles, browser data and settings are
//! never touched.
//!
//! Organization data: the manager window asks the shell to make a fixed set of API requests for it
//! ([`pb_cloud::allow`]); the window never sees a token. Successful reads are cached so the manager can show them
//! offline, always marked stale; a cache never authorizes anything.

use crate::events::ACCOUNT;
use crate::ipc::{self, IpcError};
use crate::state::AppState;
use pb_cloud::oidc::{self, Callback, Discovery, ProviderConfig, SignInError};
use pb_cloud::pkce::Attempt;
use pb_cloud::{Http, HttpError, Method, allow};
use pb_runtime::{ProfileId, WorkspaceId};
use pb_storage::cloud as cs;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use url::Url;

/// Keychain account holding the refresh token.
pub const SESSION_SECRET: &str = "cloud-session";
/// The only redirect this app handles (registered by the installer, milestone 02).
pub const REDIRECT_URI: &str = "projectbrowser://auth/callback";
/// A sign-in must finish within this time.
const SIGN_IN_TTL: Duration = Duration::from_secs(600);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN: Duration = Duration::from_secs(30);
/// Largest JSON body the window may send through the shell.
const MAX_REQUEST_BODY: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    SignedOut,
    SignedIn,
    /// The session ended without a sign-out on this device; sign in again. Nothing local was removed.
    Expired,
}

struct Pending {
    attempt: Attempt,
    discovery: Discovery,
    config: ProviderConfig,
    server: String,
    reauth: bool,
    started: Instant,
}

struct Access {
    token: String,
    until: Instant,
}

pub struct Cloud {
    http: Http,
    pending: Mutex<Option<Pending>>,
    access: Mutex<Option<Access>>,
    /// One refresh at a time: two concurrent refreshes of a rotating token would end the session.
    refresh_lock: Mutex<()>,
    /// The refresh token when no keychain works. Never written anywhere.
    memory_refresh: Mutex<Option<String>>,
    status: Mutex<SessionStatus>,
}

impl Cloud {
    pub fn new(signed_in: bool) -> Self {
        Self {
            // Plain http is accepted only for loopback addresses (a developer's local server).
            http: Http::new(true),
            pending: Mutex::new(None),
            access: Mutex::new(None),
            refresh_lock: Mutex::new(()),
            memory_refresh: Mutex::new(None),
            status: Mutex::new(if signed_in {
                SessionStatus::SignedIn
            } else {
                SessionStatus::SignedOut
            }),
        }
    }
}

#[derive(Serialize)]
pub struct AccountView {
    pub server_url: Option<String>,
    pub status: SessionStatus,
    pub signing_in: bool,
    /// `{ id, display_name, email, email_verified }`
    pub user: Option<Value>,
    pub device_id: Option<String>,
    /// False when the keychain is unavailable: the session lasts until the manager closes.
    pub session_saved: bool,
}

#[derive(Serialize)]
pub struct SignInStarted {
    pub opened: bool,
}

/// An API answer passed to the window. `stale`: served from the offline cache because the server could not be
/// reached (or the session ended); `fetched_at` says when it was current.
#[derive(Serialize, Debug)]
pub struct CloudResponse {
    pub status: u16,
    pub body: Value,
    pub stale: bool,
    pub fetched_at: Option<String>,
}

#[derive(Serialize)]
pub struct ImportClient {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct OrgImportView {
    /// HTTP status of the server's answer; the body is its plan/result or error.
    pub status: u16,
    pub body: Value,
    pub clients: Vec<ImportClient>,
    pub profiles: u32,
    /// Local profiles linked to their organization copies (after a committed copy).
    pub linked: u32,
}

/// Why an authenticated request could not be made.
enum NoAccess {
    Offline,
    SignedOut,
    Unavailable,
}

impl From<SignInError> for IpcError {
    fn from(e: SignInError) -> Self {
        match e {
            SignInError::Unavailable => ipc::SIGN_IN_UNAVAILABLE,
            SignInError::Misconfigured => ipc::SIGN_IN_MISCONFIGURED,
            SignInError::IssuerMismatch => ipc::SIGN_IN_ISSUER_MISMATCH,
            SignInError::Provider(code) if code == "access_denied" => ipc::SIGN_IN_CANCELLED,
            SignInError::Provider(_) => ipc::SIGN_IN_REFUSED,
            SignInError::ExchangeFailed => ipc::SIGN_IN_FAILED,
        }
    }
}

fn http_err(e: HttpError) -> IpcError {
    match e {
        HttpError::Offline => ipc::CLOUD_OFFLINE,
        HttpError::Insecure | HttpError::BadUrl => ipc::CLOUD_BAD_SERVER,
        HttpError::Tls => ipc::CLOUD_TLS,
        HttpError::TooLarge | HttpError::Other => ipc::CLOUD_BAD_RESPONSE,
    }
}

/// `https://host[/base]` without a trailing slash; plain http only for loopback.
pub fn normalize_server(raw: &str) -> Result<String, IpcError> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 300 {
        return Err(ipc::CLOUD_BAD_SERVER);
    }
    let url = Url::parse(raw).map_err(|_| ipc::CLOUD_BAD_SERVER)?;
    Http::new(true)
        .check(&url)
        .map_err(|_| ipc::CLOUD_BAD_SERVER)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ipc::CLOUD_BAD_SERVER);
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn api_url(server: &str, path_and_query: &str) -> Result<Url, IpcError> {
    Url::parse(&format!("{server}{path_and_query}")).map_err(|_| ipc::CLOUD_BAD_SERVER)
}

fn device_name() -> String {
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "Mac",
        "linux" => "Linux",
        other => other,
    };
    format!("Project Browser on {os}")
}

fn api_code(body: &Value) -> &str {
    body.get("code").and_then(Value::as_str).unwrap_or("")
}

impl AppState {
    fn cloud_status(&self) -> SessionStatus {
        self.cloud
            .status
            .lock()
            .map(|s| *s)
            .unwrap_or(SessionStatus::SignedOut)
    }

    fn set_cloud_status(&self, status: SessionStatus) {
        if let Ok(mut s) = self.cloud.status.lock() {
            *s = status;
        }
    }

    pub fn account_view(&self) -> Result<AccountView, IpcError> {
        let store = self.store()?;
        let account = store
            .cloud_state(cs::ACCOUNT)?
            .and_then(|a| serde_json::from_str::<Value>(&a).ok());
        let status = self.cloud_status();
        Ok(AccountView {
            server_url: store.cloud_state(cs::SERVER_URL)?,
            status,
            signing_in: self
                .cloud
                .pending
                .lock()
                .map(|p| p.is_some())
                .unwrap_or(false),
            user: if status == SessionStatus::SignedOut {
                None
            } else {
                account.as_ref().and_then(|a| a.get("user")).cloned()
            },
            device_id: store.cloud_state(cs::DEVICE_ID)?,
            session_saved: self
                .cloud
                .memory_refresh
                .lock()
                .map(|m| m.is_none())
                .unwrap_or(true),
        })
    }

    /// Sets (or clears) the organization server. Changing it signs this device out of the previous server and
    /// forgets that server's cached data and device enrollment.
    pub fn set_cloud_server(&self, url: Option<&str>) -> Result<AccountView, IpcError> {
        let store = self.store()?;
        let next = url.map(normalize_server).transpose()?;
        let current = store.cloud_state(cs::SERVER_URL)?;
        if next != current {
            self.forget_session();
            store.cache_clear()?;
            store.set_cloud_state(cs::ACCOUNT, None)?;
            store.set_cloud_state(cs::DEVICE_ID, None)?;
            store.set_cloud_state(cs::SERVER_URL, next.as_deref())?;
            self.set_cloud_status(SessionStatus::SignedOut);
        }
        self.account_view()
    }

    /// Prepares a sign-in and returns the provider URL to open in the system browser.
    pub fn begin_sign_in(&self, reauth: bool) -> Result<Url, IpcError> {
        let store = self.store()?;
        let server = store
            .cloud_state(cs::SERVER_URL)?
            .ok_or(ipc::CLOUD_NOT_CONFIGURED)?;
        let http = &self.cloud.http;
        let res = http
            .request(
                Method::Get,
                &api_url(&server, "/v1/auth/config")?,
                None,
                &[],
                None,
            )
            .map_err(|e| match e {
                HttpError::Offline => ipc::SIGN_IN_UNAVAILABLE,
                other => http_err(other),
            })?;
        if !res.ok() {
            return Err(ipc::SIGN_IN_MISCONFIGURED);
        }
        let config: ProviderConfig =
            serde_json::from_slice(&res.body).map_err(|_| ipc::SIGN_IN_MISCONFIGURED)?;
        if config.redirect_uri != REDIRECT_URI || !config.scopes.iter().any(|s| s == "openid") {
            return Err(ipc::SIGN_IN_MISCONFIGURED);
        }
        let discovery = oidc::discover(http, &config.issuer)?;
        let attempt = Attempt::new().map_err(|_| ipc::INTERNAL)?;
        store.begin_auth_transaction(&attempt.state, SIGN_IN_TTL.as_secs() as u32)?;
        let url = oidc::authorization_url(&discovery, &config, &attempt, reauth);
        // A newer attempt replaces an unfinished one (its callback will be refused).
        *self.cloud.pending.lock().map_err(|_| ipc::INTERNAL)? = Some(Pending {
            attempt,
            discovery,
            config,
            server,
            reauth,
            started: Instant::now(),
        });
        Ok(url)
    }

    pub fn cancel_sign_in(&self) {
        if let Ok(mut p) = self.cloud.pending.lock() {
            *p = None;
        }
    }

    /// Completes a sign-in from an accepted callback and tells the window how it went.
    pub fn finish_sign_in(&self, callback: &crate::deeplink::AuthCallback) {
        let reauth = self
            .cloud
            .pending
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.reauth))
            .unwrap_or(false);
        match self.complete_sign_in(callback) {
            Ok(()) => self
                .events
                .emit_json(ACCOUNT, json!({ "status": "signed_in", "reauth": reauth })),
            Err(e) => self.events.emit_json(
                ACCOUNT,
                json!({ "status": "failed", "code": e.code, "message": e.message }),
            ),
        }
    }

    pub fn complete_sign_in(
        &self,
        callback: &crate::deeplink::AuthCallback,
    ) -> Result<(), IpcError> {
        let pending = {
            let mut slot = self.cloud.pending.lock().map_err(|_| ipc::INTERNAL)?;
            match slot.as_ref() {
                Some(p) if p.attempt.state == callback.state => slot.take(),
                _ => None,
            }
        }
        .ok_or(ipc::SIGN_IN_INTERRUPTED)?;
        if pending.started.elapsed() > SIGN_IN_TTL {
            return Err(ipc::SIGN_IN_INTERRUPTED);
        }
        let code = oidc::check_callback(
            &Callback {
                state: callback.state.clone(),
                code: callback.code.clone(),
                error: callback.error.clone(),
                iss: callback.iss.clone(),
            },
            &pending.discovery.issuer,
        )?;
        let http = &self.cloud.http;
        let id_token = oidc::exchange_code(
            http,
            &pending.discovery,
            &pending.config,
            &code,
            &pending.attempt.verifier,
        )?;

        let store = self.store()?;
        let nonce = &pending.attempt.nonce;
        let enroll = || {
            http.request(
                Method::Post,
                &api_url(&pending.server, "/v1/devices")?,
                None,
                &[],
                Some(&json!({
                    "id_token": id_token,
                    "nonce": nonce,
                    "name": device_name(),
                    "platform": crate::state::platform(),
                })),
            )
            .map_err(http_err)
        };
        let mut res = match store.cloud_state(cs::DEVICE_ID)? {
            // This device is enrolled: start a new session on it (also how a re-authentication works).
            Some(device_id) => {
                let r = http
                    .request(
                        Method::Post,
                        &api_url(&pending.server, "/v1/auth/token")?,
                        None,
                        &[],
                        Some(&json!({
                            "grant_type": "id_token",
                            "id_token": id_token,
                            "nonce": nonce,
                            "device_id": device_id,
                        })),
                    )
                    .map_err(http_err)?;
                let not_enrolled = r.status == 401
                    && r.json()
                        .and_then(|b| b.pointer("/safe_details/reason").cloned())
                        .is_some_and(|v| v == "device_not_enrolled");
                if not_enrolled { enroll()? } else { r }
            }
            None => enroll()?,
        };
        if res.status == 429 {
            return Err(ipc::SIGN_IN_RATE_LIMITED);
        }
        if !res.ok() {
            return Err(match res.json().as_ref().map(api_code) {
                Some("UNAVAILABLE") => ipc::SIGN_IN_UNAVAILABLE,
                _ => ipc::SIGN_IN_FAILED,
            });
        }
        let session = res.json().ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        res.body.clear();
        self.accept_session(&session)
    }

    /// Stores a session answer from the API (sign-in or refresh).
    fn accept_session(&self, session: &Value) -> Result<(), IpcError> {
        let refresh = session
            .get("refresh_token")
            .and_then(Value::as_str)
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let access = session
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let expires_in = session
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(300)
            .clamp(30, 3600);
        let user = session
            .get("user")
            .cloned()
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let device = session
            .get("device")
            .cloned()
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let device_id = device
            .get("id")
            .and_then(Value::as_str)
            .filter(|d| d.len() == 30 && d.starts_with("dev_"))
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;

        let store = self.store()?;
        // Another person on this device: the previous account's cached organization data goes.
        let previous_user = store
            .cloud_state(cs::ACCOUNT)?
            .and_then(|a| serde_json::from_str::<Value>(&a).ok())
            .and_then(|a| {
                a.pointer("/user/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        if previous_user.as_deref() != user.get("id").and_then(Value::as_str) {
            store.cache_clear()?;
        }
        self.save_refresh(refresh);
        store.set_cloud_state(cs::DEVICE_ID, Some(device_id))?;
        let summary = json!({
            "user": {
                "id": user.get("id"),
                "display_name": user.get("display_name"),
                "email": user.get("email"),
                "email_verified": user.get("email_verified"),
            },
            "device": { "id": device_id, "name": device.get("name"), "platform": device.get("platform") },
        });
        store.set_cloud_state(cs::ACCOUNT, Some(&summary.to_string()))?;
        *self.cloud.access.lock().map_err(|_| ipc::INTERNAL)? = Some(Access {
            token: access.to_owned(),
            until: Instant::now() + Duration::from_secs(expires_in),
        });
        self.set_cloud_status(SessionStatus::SignedIn);
        Ok(())
    }

    /// Keychain when it works; otherwise memory only (never a file).
    fn save_refresh(&self, token: &str) {
        let saved = self
            .writable_secret_store()
            .ok()
            .is_some_and(|s| s.set(SESSION_SECRET, token).is_ok());
        if let Ok(mut m) = self.cloud.memory_refresh.lock() {
            *m = (!saved).then(|| token.to_owned());
        }
    }

    fn load_refresh(&self) -> Option<String> {
        if let Some(t) = self
            .cloud
            .memory_refresh
            .lock()
            .ok()
            .and_then(|m| m.clone())
        {
            return Some(t);
        }
        self.secret_store()
            .ok()
            .and_then(|s| s.get(SESSION_SECRET).ok().flatten())
    }

    /// Drops every token this device holds (keychain and memory). Local data is untouched.
    fn forget_session(&self) {
        if let Ok(s) = self.secret_store() {
            let _ = s.delete(SESSION_SECRET);
        }
        if let Ok(mut m) = self.cloud.memory_refresh.lock() {
            *m = None;
        }
        if let Ok(mut a) = self.cloud.access.lock() {
            *a = None;
        }
        self.cancel_sign_in();
    }

    /// The session ended on the server side. Shows the account as signed out; keeps local data and the cache.
    fn expire_session(&self) {
        self.forget_session();
        if self.cloud_status() == SessionStatus::SignedIn {
            self.set_cloud_status(SessionStatus::Expired);
            self.events
                .emit_json(ACCOUNT, json!({ "status": "expired" }));
        }
    }

    /// A valid access token, refreshing (serialized) when needed or when `force`d after a 401.
    fn access_token(&self, server: &str, force: bool) -> Result<String, NoAccess> {
        let _one_at_a_time = self
            .cloud
            .refresh_lock
            .lock()
            .map_err(|_| NoAccess::Unavailable)?;
        if !force
            && let Some(a) = self
                .cloud
                .access
                .lock()
                .ok()
                .as_ref()
                .and_then(|a| a.as_ref())
            && a.until > Instant::now() + REFRESH_MARGIN
        {
            return Ok(a.token.clone());
        }
        let Some(refresh) = self.load_refresh() else {
            self.expire_session();
            return Err(NoAccess::SignedOut);
        };
        let url = api_url(server, "/v1/auth/token").map_err(|_| NoAccess::Unavailable)?;
        let res = self.cloud.http.request(
            Method::Post,
            &url,
            None,
            &[],
            Some(&json!({ "grant_type": "refresh_token", "refresh_token": refresh })),
        );
        match res {
            Err(HttpError::Offline) => Err(NoAccess::Offline),
            Err(_) => Err(NoAccess::Unavailable),
            Ok(r) if r.ok() => {
                let session = r.json().ok_or(NoAccess::Unavailable)?;
                self.accept_session(&session)
                    .map_err(|_| NoAccess::Unavailable)?;
                self.cloud
                    .access
                    .lock()
                    .ok()
                    .and_then(|a| a.as_ref().map(|a| a.token.clone()))
                    .ok_or(NoAccess::Unavailable)
            }
            Ok(r) if r.status == 401 => {
                self.expire_session();
                Err(NoAccess::SignedOut)
            }
            Ok(_) => Err(NoAccess::Unavailable),
        }
    }

    pub fn sign_out(&self) -> Result<AccountView, IpcError> {
        let store = self.store()?;
        if let Some(server) = store.cloud_state(cs::SERVER_URL)?
            && let Some(token) = self
                .cloud
                .access
                .lock()
                .ok()
                .and_then(|a| a.as_ref().map(|a| a.token.clone()))
            && let Ok(url) = api_url(&server, "/v1/auth/sign-out")
        {
            // Best effort: the local sign-out happens even when the server cannot be reached.
            let _ = self
                .cloud
                .http
                .request(Method::Post, &url, Some(&token), &[], None);
        }
        self.forget_session();
        store.cache_clear()?;
        store.set_cloud_state(cs::ACCOUNT, None)?;
        self.set_cloud_status(SessionStatus::SignedOut);
        self.events
            .emit_json(ACCOUNT, json!({ "status": "signed_out" }));
        self.account_view()
    }

    /// An allow-listed API request on behalf of the manager window.
    pub fn cloud_request(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<&Value>,
        if_match: Option<&str>,
    ) -> Result<CloudResponse, IpcError> {
        let allowed =
            allow::check(method, path, query, if_match).map_err(|_| ipc::CLOUD_NOT_ALLOWED)?;
        if let Some(b) = body
            && (!b.is_object() || b.to_string().len() > MAX_REQUEST_BODY)
        {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let server = store
            .cloud_state(cs::SERVER_URL)?
            .ok_or(ipc::CLOUD_NOT_CONFIGURED)?;
        let stale_or = |err: IpcError| -> Result<CloudResponse, IpcError> {
            match allowed
                .cache_key
                .as_deref()
                .and_then(|k| store.cache_get(k).ok().flatten())
            {
                Some(cached) => Ok(CloudResponse {
                    status: 200,
                    body: serde_json::from_str(&cached.body).unwrap_or(Value::Null),
                    stale: true,
                    fetched_at: Some(cached.fetched_at),
                }),
                None => Err(err),
            }
        };
        match self.cloud_status() {
            SessionStatus::SignedOut => return Err(ipc::CLOUD_SIGNED_OUT),
            SessionStatus::Expired => return stale_or(ipc::CLOUD_SIGNED_OUT),
            SessionStatus::SignedIn => {}
        }
        let url = api_url(&server, &allowed.path_and_query)?;
        let headers: Vec<(&str, &str)> = allowed
            .if_match
            .as_deref()
            .map(|v| vec![("if-match", v)])
            .unwrap_or_default();
        let mut retried = false;
        loop {
            let token = match self.access_token(&server, retried) {
                Ok(t) => t,
                Err(NoAccess::Offline) => return stale_or(ipc::CLOUD_OFFLINE),
                Err(NoAccess::SignedOut) => return stale_or(ipc::CLOUD_SIGNED_OUT),
                Err(NoAccess::Unavailable) => return stale_or(ipc::CLOUD_UNAVAILABLE),
            };
            let res =
                match self
                    .cloud
                    .http
                    .request(allowed.method, &url, Some(&token), &headers, body)
                {
                    Ok(r) => r,
                    Err(HttpError::Offline) => return stale_or(ipc::CLOUD_OFFLINE),
                    Err(e) => return Err(http_err(e)),
                };
            if res.status == 401 && !retried {
                retried = true; // the access token was revoked or expired early: refresh once
                continue;
            }
            let body = res.json().ok_or(ipc::CLOUD_BAD_RESPONSE)?;
            if res.ok()
                && let Some(key) = &allowed.cache_key
            {
                let _ = store.cache_put(key, &String::from_utf8_lossy(&res.body));
            }
            return Ok(CloudResponse {
                status: res.status,
                body,
                stale: false,
                fetched_at: None,
            });
        }
    }

    /// Copies a local workspace's profiles (metadata) into an organization: `dry_run` returns the server's plan;
    /// otherwise the copy is committed once (idempotent retry) and each local profile is linked to its copy. Local
    /// records are kept as they are.
    pub fn org_import(
        &self,
        workspace: &WorkspaceId,
        org_id: &str,
        mapping: &BTreeMap<String, String>,
        dry_run: bool,
    ) -> Result<OrgImportView, IpcError> {
        if org_id.len() != 30 || !org_id.starts_with("org_") {
            return Err(ipc::INVALID_ARGUMENT);
        }
        if mapping.len() > 1000
            || mapping.iter().any(|(k, v)| {
                k.len() != 30 || !k.starts_with("cli_") || v.len() != 30 || !v.starts_with("cli_")
            })
        {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        store
            .get_workspace(workspace)?
            .ok_or(ipc::UNKNOWN_WORKSPACE)?;
        let profiles = store.search_profiles(Some(workspace), None, pb_storage::MAX_LIST)?;
        if profiles.is_empty() {
            return Err(ipc::ORG_IMPORT_EMPTY);
        }
        let names: HashMap<String, String> = store
            .list_clients(workspace, true)?
            .into_iter()
            .map(|c| (c.id.to_string(), c.name))
            .collect();
        let mut used: Vec<String> = profiles
            .iter()
            .filter_map(|p| p.client_id.as_ref().map(ToString::to_string))
            .collect();
        used.sort();
        used.dedup();
        let clients: Vec<ImportClient> = used
            .iter()
            .filter_map(|id| {
                names.get(id).map(|name| ImportClient {
                    reference: id.clone(),
                    name: name.clone(),
                })
            })
            .collect();
        let request = json!({
            "dry_run": dry_run,
            "clients": clients.iter().map(|c| {
                let mut v = json!({ "ref": c.reference, "name": c.name });
                if let Some(target) = mapping.get(&c.reference) {
                    v["map_to"] = json!(target);
                }
                v
            }).collect::<Vec<_>>(),
            "profiles": profiles.iter().map(|p| {
                let mut v = json!({ "local_id": p.id.as_str(), "name": p.name });
                if let Some(c) = p.client_id.as_ref().filter(|c| names.contains_key(&c.to_string())) {
                    v["client_ref"] = json!(c.to_string());
                }
                if !p.notes.is_empty() {
                    v["notes"] = json!(p.notes);
                }
                v
            }).collect::<Vec<_>>(),
        });
        let server = store
            .cloud_state(cs::SERVER_URL)?
            .ok_or(ipc::CLOUD_NOT_CONFIGURED)?;
        if self.cloud_status() != SessionStatus::SignedIn {
            return Err(ipc::CLOUD_SIGNED_OUT);
        }
        // The same copy retried (e.g. after a lost answer) uses the same key, so the server replays its result.
        let key = hex::encode(Sha256::digest(format!("{org_id}\n{request}").as_bytes()));
        let url = api_url(&server, &format!("/v1/orgs/{org_id}/local-import"))?;
        let mut retried = false;
        let res = loop {
            let token = self.access_token(&server, retried).map_err(|e| match e {
                NoAccess::Offline => ipc::CLOUD_OFFLINE,
                NoAccess::SignedOut => ipc::CLOUD_SIGNED_OUT,
                NoAccess::Unavailable => ipc::CLOUD_UNAVAILABLE,
            })?;
            let headers: Vec<(&str, &str)> = if dry_run {
                vec![]
            } else {
                vec![("idempotency-key", key.as_str())]
            };
            let r = self
                .cloud
                .http
                .request(Method::Post, &url, Some(&token), &headers, Some(&request))
                .map_err(http_err)?;
            if r.status == 401 && !retried {
                retried = true;
                continue;
            }
            break r;
        };
        let body = res.json().ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let mut linked = 0;
        if res.ok() && !dry_run {
            let pairs: Vec<(ProfileId, String)> = body
                .get("profiles")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| {
                            let local = ProfileId::parse(r.get("local_id")?.as_str()?).ok()?;
                            let remote = r.get("profile_id")?.as_str()?.to_owned();
                            Some((local, remote))
                        })
                        .collect()
                })
                .unwrap_or_default();
            store.link_org_profiles(org_id, &pairs)?;
            linked = pairs.len() as u32;
        }
        Ok(OrgImportView {
            status: res.status,
            body,
            clients,
            profiles: profiles.len() as u32,
            linked,
        })
    }

    pub fn org_links(&self, org_id: Option<&str>) -> Result<Vec<cs::OrgLink>, IpcError> {
        Ok(self.store()?.org_links(org_id)?)
    }

    /// An API request made by the shell's own code (snapshot uploads and restores, milestone 07): never reachable
    /// from the window, never cached. Errors are mapped to what the sync engine distinguishes.
    pub(crate) fn shell_api(
        &self,
        method: Method,
        path: &str,
        idempotency_key: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, pb_sync::ApiError> {
        use pb_sync::ApiError as E;
        let local = |code: &str| E::Code {
            status: 0,
            code: code.to_owned(),
        };
        let store = self.store().map_err(|_| local("LOCAL_STORE_ERROR"))?;
        let server = store
            .cloud_state(cs::SERVER_URL)
            .map_err(|_| local("LOCAL_STORE_ERROR"))?
            .ok_or(E::SignedOut)?;
        if self.cloud_status() != SessionStatus::SignedIn {
            return Err(E::SignedOut);
        }
        let url = api_url(&server, path).map_err(|_| local("CLOUD_BAD_SERVER"))?;
        let headers: Vec<(&str, &str)> = idempotency_key
            .map(|k| vec![("idempotency-key", k)])
            .unwrap_or_default();
        let mut retried = false;
        loop {
            let token = self.access_token(&server, retried).map_err(|e| match e {
                NoAccess::Offline => E::Offline,
                NoAccess::SignedOut => E::SignedOut,
                NoAccess::Unavailable => local("CLOUD_UNAVAILABLE"),
            })?;
            let res = match self
                .cloud
                .http
                .request(method, &url, Some(&token), &headers, body)
            {
                Ok(r) => r,
                Err(HttpError::Offline) => return Err(E::Offline),
                Err(e) => return Err(local(http_err(e).code)),
            };
            if res.status == 401 && !retried {
                retried = true;
                continue;
            }
            let json = res.json().ok_or_else(|| local("CLOUD_BAD_RESPONSE"))?;
            if res.ok() {
                return Ok(json);
            }
            if res.status == 401 {
                self.expire_session();
            }
            return Err(pb_sync::rest::map_error(res.status, &json));
        }
    }
}
