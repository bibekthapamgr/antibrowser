//! Proxies, per-profile routing and privacy/environment settings (milestone 05).
//!
//! Proxy metadata lives in SQLite. A proxy's login lives only in the OS keychain, as `{"u":…,"p":…}` under an
//! account named by the proxy's `credential_ref` (`proxy:<id>#<suffix>`; a new suffix on every change, so an
//! update rejected by the database never leaves a changed login behind). The database, exports, diagnostics, logs,
//! IPC answers and the browser's command line never contain a username or password.
//!
//! A profile with a proxy is launched against a loopback gateway (`pb-netproxy`) that the manager starts for it;
//! the gateway adds the login and is fail-closed unless the user turned that off for the profile. Proxies are
//! never changed under a running profile: an edit or a new assignment takes effect when the profile is reopened
//! (the profile shows "restart required"), so a session never switches exit address on its own.
//!
//! Checks (ADR-0027) go through the proxy to the account server's `/v1/netcheck` when one is configured (https):
//! it reports the exit address and an estimate of where it is (country, city, time zone, language). Without a
//! server the interim Cloudflare trace service is used, which reports the country only. A profile that matches its
//! proxy (`match_proxy`) takes its time zone and language from the proxy's last check; a check older than a day
//! (or older than the proxy's last edit) is repeated before the profile opens, for at most 10 seconds.

use crate::events::{PROFILES_CHANGED, WARNING};
use crate::ipc::{self, IpcError};
use crate::secrets::SecretStore;
use crate::state::{AppState, ProfileView};
use pb_netproxy::check::{self, CheckOutcome, CheckTarget, TraceGeo};
use pb_netproxy::gateway::{Fallback, Gateway};
use pb_netproxy::tls::TlsTrust;
use pb_netproxy::{AddressPolicy, Credentials, ProxyKind, Upstream};
use pb_runtime::environment::{self, FieldReport, Platform, Preset, Support};
use pb_runtime::{PrivacyConfig, ProfileId, ProxyGeo, ProxyId};
use pb_storage::network::{GatewaySession, NetworkCheck, NewProxy, ProxyChanges, ProxyConfig};
use pb_storage::{LocalProfile, LocalStore, ProfileUpdate, settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Reminders start this many days before a proxy's expiry date.
pub const EXPIRY_WARNING_DAYS: i64 = 7;
const PROXY_NAME_CHARS: usize = 80;
const PROXY_NOTES_CHARS: usize = 500;
/// A proxy's location is re-checked before a matching profile opens when its last check is older than this.
pub const MATCH_CHECK_MAX_AGE_SECS: i64 = 24 * 3600;
/// How long a launch waits for that check.
pub const MATCH_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// ----------------------------------------------------------------------------- IPC input and output
/// A proxy login as typed by the user. `Debug` never prints it.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Login(<redacted>)")
    }
}

impl From<Login> for Credentials {
    fn from(l: Login) -> Self {
        Credentials {
            username: l.username,
            password: l.password,
        }
    }
}

/// `proxies.create`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyInput {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u32,
    pub login: Option<Login>,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub notes: String,
}

/// `proxies.update`: absent fields are kept. `login` replaces the saved login; `remove_login` deletes it.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyEdit {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub host: Option<String>,
    pub port: Option<u32>,
    pub login: Option<Login>,
    #[serde(default)]
    pub remove_login: bool,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub clear_expiry: bool,
    pub notes: Option<String>,
}

/// A proxy as the UI sees it. The keychain reference is not included; `has_login` says whether one is saved.
#[derive(Debug, Serialize)]
pub struct ProxyView {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub has_login: bool,
    pub expires_at: Option<String>,
    /// `expired` | `expires_soon` | null
    pub expiry: Option<&'static str>,
    pub days_left: Option<i64>,
    pub notes: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub profiles: u64,
    pub last_check: Option<NetworkCheck>,
}

/// Routing state of one profile, shown in the table and drawer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetworkView {
    /// `off` (no proxy) | `ready` (proxy assigned, profile closed) | `active` | `failing` (traffic blocked) |
    /// `bypassing` (fail-closed is off and traffic is going direct) | `lost` (the manager restarted and could not
    /// restore the profile's connection: reopen it).
    pub status: &'static str,
    pub last_error: Option<&'static str>,
    /// Connections made without the proxy in this session (fail-closed off only).
    pub direct_connections: u64,
    /// The proxy, routing mode or environment changed while the profile was open.
    pub restart_required: bool,
}

#[derive(Debug, Serialize)]
pub struct PrivacyValidation {
    pub valid: bool,
    pub error: Option<IpcError>,
    pub platform: &'static str,
    /// What the browser on this computer will do with each setting that is not at its default.
    pub report: Vec<FieldReport>,
}

#[derive(Debug, Serialize)]
pub struct LanguageOption {
    pub tag: &'static str,
    pub name: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PrivacyOptions {
    pub platform: &'static str,
    pub languages: Vec<LanguageOption>,
    pub time_zones: &'static [&'static str],
    pub window_min: (u32, u32),
    pub window_max: (u32, u32),
    pub presets: Vec<Preset>,
}

// ----------------------------------------------------------------------------- running state
/// What a running profile was started with.
#[derive(Clone, Debug, Default)]
pub(crate) struct Launched {
    pub proxy: Option<ProxyId>,
    pub fail_closed: bool,
    pub config_version: i64,
    /// `None` for a browser adopted after a manager restart (its settings at start are not known).
    pub privacy: Option<PrivacyConfig>,
}

pub(crate) struct RunningNetwork {
    pub gateway: Option<Gateway>,
    pub launched: Launched,
    /// The proxy was edited while the profile was open.
    pub proxy_changed: bool,
    /// The browser expects a gateway the manager could not restore.
    pub lost: bool,
    reported_failing: bool,
    reported_bypass: bool,
}

impl RunningNetwork {
    pub(crate) fn new(gateway: Option<Gateway>, launched: Launched) -> Self {
        Self {
            gateway,
            launched,
            proxy_changed: false,
            lost: false,
            reported_failing: false,
            reported_bypass: false,
        }
    }
}

/// A proxy route ready to be started for a launch.
pub(crate) struct Route {
    pub upstream: Upstream,
    pub fallback: Fallback,
    pub proxy_id: ProxyId,
    pub proxy_version: i64,
}

/// Network settings that tests replace (trusted roots, check service).
#[derive(Clone, Debug)]
pub struct NetworkSettings {
    pub trust: TlsTrust,
    /// A fixed check service (tests). `None`: the account server's `/v1/netcheck` when one is configured over
    /// https, otherwise [`CheckTarget::default_service`].
    pub check: Option<CheckTarget>,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            trust: TlsTrust::Platform,
            check: None,
        }
    }
}

/// `<server>/v1/netcheck` for an https account server with a host name (the check verifies its certificate).
pub fn server_check_target(server: &str) -> Option<CheckTarget> {
    let url = url::Url::parse(server).ok()?;
    if url.scheme() != "https" || url.query().is_some() {
        return None;
    }
    let host = match url.host()? {
        url::Host::Domain(d) => d.to_owned(),
        _ => return None,
    };
    Some(CheckTarget {
        host,
        port: url.port_or_known_default()?,
        path: format!("{}/v1/netcheck", url.path().trim_end_matches('/')),
    })
}

/// The location facts of a check answer, as stored.
fn geo_of(t: &TraceGeo) -> ProxyGeo {
    ProxyGeo {
        country: t.country.clone(),
        city: t.city.clone(),
        timezone: t.timezone.clone(),
        language: t.language.clone(),
        latitude: t.latitude,
        longitude: t.longitude,
    }
}

/// Seconds since 1970 for `YYYY-MM-DDTHH:MM:SS(.fff)Z` (the store's timestamps).
pub fn epoch_seconds(ts: &str) -> Option<i64> {
    let days = days_from_date(ts.get(0..10)?)?;
    if ts.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    let h: i64 = ts.get(11..13)?.parse().ok()?;
    let m: i64 = ts.get(14..16)?.parse().ok()?;
    let sec: i64 = ts.get(17..19)?.parse().ok()?;
    Some(days * 86_400 + h * 3600 + m * 60 + sec)
}

pub(crate) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether a proxy's last check can be used for matching without checking again: it worked, it is less than a day
/// old, and the proxy was not edited after it.
pub fn check_is_fresh(proxy: &ProxyConfig, now: i64) -> bool {
    check_is_fresh_within(proxy, now, MATCH_CHECK_MAX_AGE_SECS)
}

/// [`check_is_fresh`] with another age limit (the location lock, ADR-0029, wants a check at most 10 minutes old).
pub fn check_is_fresh_within(proxy: &ProxyConfig, now: i64, max_age_secs: i64) -> bool {
    proxy.last_check.as_ref().is_some_and(|c| {
        c.result == "ok"
            && c.checked_at >= proxy.updated_at
            && epoch_seconds(&c.checked_at)
                .is_some_and(|t| now - t < max_age_secs && t <= now + 300)
    })
}

/// The location a launch matches, and why there is none.
pub(crate) struct LaunchGeo {
    pub geo: Option<ProxyGeo>,
    /// A check error code, or `NO_LOCATION` (the service gave no time zone or language).
    pub problem: Option<String>,
}

#[derive(Deserialize)]
struct StoredLogin {
    u: String,
    p: String,
}

fn platform_name(p: Platform) -> &'static str {
    match p {
        Platform::Windows => "windows",
        Platform::MacOs => "macos",
        Platform::Linux => "linux",
    }
}

/// Days since 1970-01-01 for a `YYYY-MM-DD` date (Howard Hinnant's algorithm).
fn days_from_date(date: &str) -> Option<i64> {
    let y: i64 = date.get(0..4)?.parse().ok()?;
    let m: i64 = date.get(5..7)?.parse().ok()?;
    let d: i64 = date.get(8..10)?.parse().ok()?;
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn today() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

/// (`expired` | `expires_soon` | none, days left) for an expiry date.
pub fn expiry_state(expires_at: Option<&str>, today: i64) -> (Option<&'static str>, Option<i64>) {
    let Some(days) = expires_at.and_then(days_from_date) else {
        return (None, None);
    };
    let left = days - today;
    let state = if left < 0 {
        Some("expired")
    } else if left <= EXPIRY_WARNING_DAYS {
        Some("expires_soon")
    } else {
        None
    };
    (state, Some(left))
}

fn view_proxy(p: ProxyConfig) -> ProxyView {
    let (expiry, days_left) = expiry_state(p.expires_at.as_deref(), today());
    ProxyView {
        id: p.id.to_string(),
        workspace_id: p.workspace_id.to_string(),
        name: p.name,
        kind: p.kind,
        host: p.host,
        port: p.port,
        has_login: p.credential_ref.is_some(),
        expires_at: p.expires_at,
        expiry,
        days_left,
        notes: p.notes,
        version: p.version,
        created_at: p.created_at,
        updated_at: p.updated_at,
        profiles: p.profiles,
        last_check: p.last_check,
    }
}

fn clean_proxy_notes(notes: &str) -> Result<String, IpcError> {
    let cleaned = ipc::clean_notes(notes)?;
    if cleaned.chars().count() > PROXY_NOTES_CHARS {
        return Err(ipc::PROXY_NOTES_TOO_LONG);
    }
    Ok(cleaned)
}

fn check_date(d: &str) -> Result<(), IpcError> {
    if pb_storage::network::valid_date(d) && days_from_date(d).is_some() {
        Ok(())
    } else {
        Err(ipc::INVALID_DATE)
    }
}

impl AppState {
    // ------------------------------------------------------------------------- secrets
    /// Replaces the secret store (tests use an in-memory one) and marks it available.
    pub fn use_secret_store(&self, store: Arc<dyn SecretStore>) {
        if let Ok(mut s) = self.secrets.write() {
            *s = store;
        }
        if let Ok(mut k) = self.keychain.write() {
            *k = crate::secrets::KeychainStatus {
                available: true,
                reason: None,
            };
        }
        self.load_backup_key();
    }

    /// Replaces the trusted roots and the connectivity-check service (tests).
    pub fn set_network_settings(&self, settings: NetworkSettings) {
        if let Ok(mut s) = self.network_settings.write() {
            *s = settings;
        }
    }

    fn network_settings(&self) -> NetworkSettings {
        self.network_settings
            .read()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub(crate) fn secret_store(&self) -> Result<Arc<dyn SecretStore>, IpcError> {
        Ok(self.secrets.read().map_err(|_| ipc::INTERNAL)?.clone())
    }

    /// The secret store, only when the keychain works (secrets are never written anywhere else).
    pub(crate) fn writable_secret_store(&self) -> Result<Arc<dyn SecretStore>, IpcError> {
        let not_checked = self
            .keychain
            .read()
            .map(|k| k.reason == Some("not_checked_yet"))
            .unwrap_or(false);
        if not_checked {
            let status = crate::secrets::probe();
            if let Ok(mut k) = self.keychain.write() {
                *k = status;
            }
        }
        let available = self.keychain.read().map(|k| k.available).unwrap_or(false);
        if !available {
            return Err(ipc::KEYCHAIN_UNAVAILABLE);
        }
        self.secret_store()
    }

    fn save_login(&self, id: &ProxyId, login: &Credentials) -> Result<String, IpcError> {
        let secrets = self.writable_secret_store()?;
        let account = format!(
            "proxy:{id}#{}",
            pb_runtime::random_hex(4).map_err(|_| ipc::INTERNAL)?
        );
        let value = json!({ "u": login.username, "p": login.password }).to_string();
        secrets
            .set(&account, &value)
            .map_err(|_| ipc::KEYCHAIN_ERROR)?;
        Ok(account)
    }

    fn forget_login(&self, account: &str) {
        if let Ok(secrets) = self.secret_store() {
            let _ = secrets.delete(account);
        }
    }

    /// The saved login of a proxy (`None` when it has none).
    fn load_login(&self, proxy: &ProxyConfig) -> Result<Option<Credentials>, IpcError> {
        let Some(account) = &proxy.credential_ref else {
            return Ok(None);
        };
        match self.secret_store()?.get(account) {
            Ok(Some(value)) => serde_json::from_str::<StoredLogin>(&value)
                .map(|s| {
                    Some(Credentials {
                        username: s.u,
                        password: s.p,
                    })
                })
                .map_err(|_| ipc::PROXY_CREDENTIALS_MISSING),
            Ok(None) => Err(ipc::PROXY_CREDENTIALS_MISSING),
            Err(_) => Err(ipc::KEYCHAIN_ERROR),
        }
    }

    /// Settings → "Open the IP check page first in new profiles with a proxy" (ADR-0029; on by default).
    pub(crate) fn open_check_page_default(&self, store: &LocalStore) -> bool {
        store
            .get_setting(settings::OPEN_CHECK_PAGE)
            .ok()
            .and_then(|v| v.value.as_bool())
            .unwrap_or(true)
    }

    fn proxy_policy(&self, store: &LocalStore) -> AddressPolicy {
        AddressPolicy {
            allow_private: store
                .get_setting(settings::ALLOW_PRIVATE_PROXIES)
                .ok()
                .and_then(|v| v.value.as_bool())
                .unwrap_or(false),
        }
    }

    /// A proxy of the active workspace.
    fn own_proxy(&self, store: &LocalStore, id: &ProxyId) -> Result<ProxyConfig, IpcError> {
        let ws = self.workspace(store)?;
        store
            .get_proxy(id)?
            .filter(|p| p.workspace_id == ws)
            .ok_or(ipc::UNKNOWN_PROXY)
    }

    /// The upstream for a saved proxy, re-validated against the current local-address policy.
    pub(crate) fn upstream_for(
        &self,
        store: &LocalStore,
        proxy: &ProxyConfig,
    ) -> Result<Upstream, IpcError> {
        let kind = ProxyKind::parse(&proxy.kind).ok_or(ipc::INVALID_PROXY_TYPE)?;
        let credentials = self.load_login(proxy)?;
        let policy = self.proxy_policy(store);
        let (host, port) = pb_netproxy::validate(
            kind,
            &proxy.host,
            u32::from(proxy.port),
            credentials.as_ref(),
            policy,
        )?;
        Ok(Upstream {
            kind,
            host,
            port,
            credentials,
            policy,
        })
    }

    // ------------------------------------------------------------------------- proxies
    pub fn list_proxies(&self) -> Result<Vec<ProxyView>, IpcError> {
        let store = self.store()?;
        let Some(ws) = self.active_workspace(&store)? else {
            return Ok(vec![]);
        };
        Ok(store
            .list_proxies(&ws)?
            .into_iter()
            .map(view_proxy)
            .collect())
    }

    pub fn create_proxy(&self, input: ProxyInput) -> Result<ProxyView, IpcError> {
        let name = ipc::clean_text(&input.name, PROXY_NAME_CHARS, ipc::INVALID_PROXY_NAME)?;
        let notes = clean_proxy_notes(&input.notes)?;
        let kind = ProxyKind::parse(&input.kind).ok_or(ipc::INVALID_PROXY_TYPE)?;
        if let Some(d) = &input.expires_at {
            check_date(d)?;
        }
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let login: Option<Credentials> = input.login.map(Into::into);
        let (host, port) = pb_netproxy::validate(
            kind,
            &input.host,
            input.port,
            login.as_ref(),
            self.proxy_policy(&store),
        )?;
        let id = ProxyId::generate().map_err(|_| ipc::INTERNAL)?;
        let account = login
            .as_ref()
            .map(|l| self.save_login(&id, l))
            .transpose()?;
        let created = store.create_proxy(NewProxy {
            id: id.clone(),
            workspace_id: &ws,
            name: &name,
            kind: kind.as_str(),
            host: &host,
            port,
            credential_ref: account.as_deref(),
            expires_at: input.expires_at.as_deref(),
            notes: &notes,
        });
        match created {
            Ok(p) => {
                let _ = store.audit(None, "proxy", "created", None, Some(id.as_str()));
                Ok(view_proxy(p))
            }
            Err(e) => {
                if let Some(a) = &account {
                    self.forget_login(a);
                }
                Err(e.into())
            }
        }
    }

    pub fn update_proxy(
        &self,
        id: &ProxyId,
        expected_version: i64,
        edit: ProxyEdit,
    ) -> Result<ProxyView, IpcError> {
        let name = edit
            .name
            .as_deref()
            .map(|n| ipc::clean_text(n, PROXY_NAME_CHARS, ipc::INVALID_PROXY_NAME))
            .transpose()?;
        let notes = edit.notes.as_deref().map(clean_proxy_notes).transpose()?;
        if let Some(d) = &edit.expires_at {
            check_date(d)?;
        }
        if edit.login.is_some() && edit.remove_login {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let current = self.own_proxy(&store, id)?;
        if current.version != expected_version {
            return Err(pb_storage::StoreError::VersionConflict {
                current: current.version,
            }
            .into());
        }
        let kind = match &edit.kind {
            Some(k) => ProxyKind::parse(k).ok_or(ipc::INVALID_PROXY_TYPE)?,
            None => ProxyKind::parse(&current.kind).ok_or(ipc::INVALID_PROXY_TYPE)?,
        };
        let new_login: Option<Credentials> = edit.login.map(Into::into);
        // The resulting login (new, kept or none) must suit the resulting proxy type.
        let effective_login = match (&new_login, edit.remove_login) {
            (Some(l), _) => Some(l.clone()),
            (None, true) => None,
            (None, false) if edit.kind.is_some() => self.load_login(&current).ok().flatten(),
            (None, false) => None,
        };
        let (host, port) = pb_netproxy::validate(
            kind,
            edit.host.as_deref().unwrap_or(&current.host),
            edit.port.unwrap_or(u32::from(current.port)),
            effective_login.as_ref(),
            self.proxy_policy(&store),
        )?;
        let new_account = new_login
            .as_ref()
            .map(|l| self.save_login(id, l))
            .transpose()?;
        let credential_ref = match (&new_account, edit.remove_login) {
            (Some(a), _) => Some(Some(a.as_str())),
            (None, true) => Some(None),
            (None, false) => None,
        };
        let updated = store.update_proxy(
            id,
            expected_version,
            ProxyChanges {
                name: name.as_deref(),
                kind: edit.kind.as_ref().map(|_| kind.as_str()),
                host: Some(&host),
                port: Some(port),
                credential_ref,
                expires_at: if edit.clear_expiry {
                    Some(None)
                } else {
                    edit.expires_at.as_deref().map(Some)
                },
                notes: notes.as_deref(),
            },
        );
        match updated {
            Ok(p) => {
                if credential_ref.is_some()
                    && let Some(old) = &current.credential_ref
                {
                    self.forget_login(old);
                }
                // Open profiles keep their route until reopened.
                if p.version != current.version
                    && let Ok(mut nets) = self.networks.lock()
                {
                    for n in nets.values_mut() {
                        if n.launched.proxy.as_ref() == Some(id) {
                            n.proxy_changed = true;
                        }
                    }
                }
                let _ = store.audit(None, "proxy", "updated", None, Some(id.as_str()));
                self.notify_running_changed();
                Ok(view_proxy(p))
            }
            Err(e) => {
                if let Some(a) = &new_account {
                    self.forget_login(a);
                }
                Err(e.into())
            }
        }
    }

    /// Deletes a proxy no profile uses, with its saved login and check history.
    pub fn delete_proxy(&self, id: &ProxyId) -> Result<(), IpcError> {
        let store = self.store()?;
        let current = self.own_proxy(&store, id)?;
        store.delete_proxy(id)?;
        if let Some(account) = &current.credential_ref {
            self.forget_login(account);
        }
        let _ = store.audit(None, "proxy", "deleted", None, Some(id.as_str()));
        Ok(())
    }

    pub fn list_proxy_checks(&self, id: &ProxyId) -> Result<Vec<NetworkCheck>, IpcError> {
        let store = self.store()?;
        self.own_proxy(&store, id)?;
        Ok(store.list_checks(id, 50)?)
    }

    /// `proxies.test(id)`: one user-started check through the proxy against the check service. Records the
    /// latency, the exit address the service saw and the time; failures are recorded with their code.
    pub async fn test_proxy(self: Arc<Self>, id: ProxyId) -> Result<NetworkCheck, IpcError> {
        let store = self.store()?;
        let proxy = self.own_proxy(&store, &id)?;
        let upstream = match self.upstream_for(&store, &proxy) {
            Ok(u) => u,
            Err(e) if e.code == ipc::PROXY_CREDENTIALS_MISSING.code => {
                return Ok(store.record_check(&id, Some(e.code), None, None, None)?);
            }
            Err(e) => return Err(e),
        };
        let settings = self.network_settings();
        let target = self.check_target(&store, &settings);
        let outcome = self
            .net
            .handle()
            .spawn(async move { check::run(&upstream, &settings.trust, &target).await })
            .await
            .map_err(|_| ipc::INTERNAL)?;
        self.record_outcome(&store, &id, &outcome)
    }

    /// The service checks go to: a test override, the account server's `/v1/netcheck`, or Cloudflare's trace.
    fn check_target(&self, store: &LocalStore, settings: &NetworkSettings) -> CheckTarget {
        if let Some(t) = &settings.check {
            return t.clone();
        }
        store
            .cloud_state(pb_storage::cloud::SERVER_URL)
            .ok()
            .flatten()
            .and_then(|s| server_check_target(&s))
            .unwrap_or_else(CheckTarget::default_service)
    }

    fn record_outcome(
        &self,
        store: &LocalStore,
        id: &ProxyId,
        outcome: &Result<CheckOutcome, pb_netproxy::ProxyError>,
    ) -> Result<NetworkCheck, IpcError> {
        let record = match outcome {
            Ok(o) => store.record_check(
                id,
                None,
                Some(o.latency_ms),
                o.egress_ip.map(|ip| ip.to_string()).as_deref(),
                o.geo.as_ref().map(geo_of).as_ref(),
            )?,
            Err(e) => store.record_check(id, Some(e.code()), None, None, None)?,
        };
        let _ = store.audit(
            None,
            "network",
            if outcome.is_ok() {
                "check_ok"
            } else {
                "check_failed"
            },
            None,
            Some(record.error_code.as_deref().unwrap_or(id.as_str())),
        );
        Ok(record)
    }

    /// The proxy's last check when it worked and is younger than `max_age_secs` (and not older than the proxy's last
    /// edit); otherwise a new check through the proxy, at most [`MATCH_CHECK_TIMEOUT`], which is recorded like any
    /// other. `Err`: why there is no check at all (a code). Blocks: runs on a launch's worker thread, never inside the
    /// network runtime or on the UI thread.
    pub(crate) fn proxy_check_for_launch(
        &self,
        store: &LocalStore,
        proxy: &ProxyConfig,
        max_age_secs: i64,
    ) -> Result<NetworkCheck, String> {
        if check_is_fresh_within(proxy, now_seconds(), max_age_secs)
            && let Some(c) = &proxy.last_check
        {
            return Ok(c.clone());
        }
        let upstream = self
            .upstream_for(store, proxy)
            .map_err(|e| e.code.to_owned())?;
        let settings = self.network_settings();
        let target = self.check_target(store, &settings);
        let outcome = self.net.block_on(check::run_within(
            &upstream,
            &settings.trust,
            &target,
            MATCH_CHECK_TIMEOUT,
        ));
        self.record_outcome(store, &proxy.id, &outcome)
            .map_err(|e| e.code.to_owned())
    }

    /// The proxy location a matching profile's launch uses: the last check when it is fresh, otherwise a new check
    /// (at most [`MATCH_CHECK_TIMEOUT`]). Runs on the launch's worker thread, never inside the network runtime.
    pub(crate) fn launch_geo(&self, store: &LocalStore, profile: &LocalProfile) -> LaunchGeo {
        let none = |problem: &str| LaunchGeo {
            geo: None,
            problem: Some(problem.to_owned()),
        };
        let Some(proxy) = profile
            .proxy_id
            .as_ref()
            .and_then(|id| store.get_proxy(id).ok().flatten())
        else {
            return none(ipc::UNKNOWN_PROXY.code);
        };
        let check = match self.proxy_check_for_launch(store, &proxy, MATCH_CHECK_MAX_AGE_SECS) {
            Ok(c) => c,
            Err(code) => return none(&code),
        };
        if let Some(code) = check.error_code {
            return LaunchGeo {
                geo: None,
                problem: Some(code),
            };
        }
        match check.geo {
            Some(g) if g.timezone.is_some() || g.language.is_some() => LaunchGeo {
                geo: Some(g),
                problem: None,
            },
            _ => none("NO_LOCATION"),
        }
    }

    // ------------------------------------------------------------------------- profiles
    /// `profiles.assign_proxy(id, proxy_id, expected_version)`; `proxy_id: None` removes the proxy. Takes effect
    /// the next time the profile opens.
    pub fn assign_proxy(
        &self,
        profile_id: &ProfileId,
        proxy_id: Option<&ProxyId>,
        fail_closed: bool,
        expected_version: i64,
    ) -> Result<ProfileView, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if profile.trashed_at.is_some() {
            return Err(ipc::PROFILE_IN_TRASH);
        }
        if let Some(p) = proxy_id {
            let proxy = store.get_proxy(p)?.ok_or(ipc::UNKNOWN_PROXY)?;
            if Some(&proxy.workspace_id) != profile.workspace_id.as_ref() {
                return Err(ipc::UNKNOWN_PROXY);
            }
        }
        // ADR-0029: a new profile (never opened) that gets its first proxy opens the IP check page first, when that
        // is the default in Settings. Existing profiles keep what they had.
        let privacy = (proxy_id.is_some()
            && profile.proxy_id.is_none()
            && profile.last_started_at.is_none()
            && !profile.privacy.open_check_page
            && self.open_check_page_default(&store))
        .then(|| PrivacyConfig {
            open_check_page: true,
            ..profile.privacy.clone()
        });
        let updated = store.update_profile(
            profile_id,
            ProfileUpdate {
                network: Some((proxy_id, fail_closed)),
                privacy: privacy.as_ref(),
                ..ProfileUpdate::default()
            },
            expected_version,
        )?;
        let _ = store.audit(
            Some(profile_id),
            "network",
            if proxy_id.is_some() {
                "proxy_assigned"
            } else {
                "proxy_removed"
            },
            None,
            proxy_id.map(ProxyId::as_str),
        );
        self.notify_running_changed();
        Ok(self.view(updated))
    }

    /// `privacy.validate(config)`: whether the settings can be saved, and what this OS's browser will do with them.
    /// `proxied`: whether the profile has a proxy (`None`: not said; matching is then reported as for a proxy).
    pub fn validate_privacy(
        &self,
        config: &PrivacyConfig,
        fail_closed_proxy: bool,
        proxied: Option<bool>,
    ) -> PrivacyValidation {
        let platform = Platform::current();
        let mut report = environment::report(config, platform);
        let matching = config.match_proxy && proxied != Some(false);
        if fail_closed_proxy || matching {
            report.retain(|r| r.field != "webrtc");
            report.push(FieldReport {
                field: "webrtc",
                support: Support::Applied,
                message: if fail_closed_proxy {
                    "WebRTC can use only the proxy (set by fail-closed routing)."
                } else {
                    "WebRTC can use only the proxy (set by matching the proxy)."
                },
            });
        }
        if config.match_proxy && proxied == Some(false) {
            report.retain(|r| r.field != "match_proxy");
            report.push(FieldReport {
                field: "match_proxy",
                support: Support::Unavailable,
                message: "This profile has no proxy, so there is nothing to match. It uses this computer's settings.",
            });
        }
        let error = environment::validate(config).err().map(IpcError::from);
        PrivacyValidation {
            valid: error.is_none(),
            error,
            platform: platform_name(platform),
            report,
        }
    }

    pub fn privacy_options(&self) -> PrivacyOptions {
        PrivacyOptions {
            platform: platform_name(Platform::current()),
            languages: environment::LANGUAGES
                .iter()
                .map(|(tag, name)| LanguageOption { tag, name })
                .collect(),
            time_zones: environment::TIME_ZONES,
            window_min: pb_runtime::WindowSize::MIN,
            window_max: pb_runtime::WindowSize::MAX,
            presets: environment::presets(),
        }
    }

    // ------------------------------------------------------------------------- launch support
    /// The route a launch needs: `None` without a proxy. Fails before anything starts when the proxy's login is
    /// missing or its address is no longer allowed.
    pub(crate) fn route_for(
        &self,
        store: &LocalStore,
        profile: &LocalProfile,
    ) -> Result<Option<Route>, IpcError> {
        let Some(proxy_id) = &profile.proxy_id else {
            return Ok(None);
        };
        let proxy = store.get_proxy(proxy_id)?.ok_or(ipc::UNKNOWN_PROXY)?;
        let upstream = self.upstream_for(store, &proxy)?;
        if expiry_state(proxy.expires_at.as_deref(), today()).0 == Some("expired") {
            // The date is the user's reminder, not a hard stop: the provider may still accept the proxy.
            self.events.emit_json(
                WARNING,
                json!({ "code": "PROXY_EXPIRED", "proxy_id": proxy.id.as_str(), "profile_id": profile.id.as_str(),
                        "expires_at": proxy.expires_at }),
            );
        }
        Ok(Some(Route {
            upstream,
            fallback: if profile.fail_closed {
                Fallback::Block
            } else {
                Fallback::Direct
            },
            proxy_id: proxy.id,
            proxy_version: proxy.version,
        }))
    }

    pub(crate) fn start_gateway(&self, route: &Route, port: u16) -> Result<Gateway, IpcError> {
        Gateway::start_with(
            &self.net,
            port,
            route.upstream.clone(),
            self.network_settings().trust,
            route.fallback,
        )
        .map_err(|_| ipc::GATEWAY_FAILED)
    }

    /// Records a launched profile's routing (and its gateway, which then lives until the profile closes).
    pub(crate) fn track_network(
        &self,
        store: &LocalStore,
        profile: &LocalProfile,
        gateway: Option<Gateway>,
        route: Option<&Route>,
    ) {
        if let (Some(g), Some(r)) = (&gateway, route) {
            let _ = store.set_gateway_session(
                &profile.id,
                &GatewaySession {
                    port: g.port(),
                    proxy_id: r.proxy_id.clone(),
                    proxy_version: r.proxy_version,
                    fail_closed: r.fallback == Fallback::Block,
                },
            );
        } else {
            let _ = store.clear_gateway_session(&profile.id);
        }
        let launched = Launched {
            proxy: route.map(|r| r.proxy_id.clone()),
            fail_closed: profile.fail_closed,
            config_version: profile.network_config_version,
            privacy: Some(profile.privacy.clone()),
        };
        if let Ok(mut nets) = self.networks.lock() {
            nets.insert(profile.id.clone(), RunningNetwork::new(gateway, launched));
        }
    }

    /// Stops a profile's gateway (the profile closed or its start failed).
    pub(crate) fn untrack_network(&self, store: &LocalStore, id: &ProfileId) {
        let removed = self.networks.lock().ok().and_then(|mut n| n.remove(id));
        if let Some(n) = removed
            && let Some(g) = n.gateway
        {
            g.stop();
        }
        let _ = store.clear_gateway_session(id);
    }

    /// Re-creates the gateway of a browser that kept running while the manager was closed, on the port the browser
    /// was started with. Without a recorded session the browser had no proxy.
    pub(crate) fn restore_network(&self, store: &LocalStore, id: &ProfileId) {
        if self
            .networks
            .lock()
            .map(|n| n.contains_key(id))
            .unwrap_or(true)
        {
            return;
        }
        let profile = store.get_profile(id).ok().flatten();
        let session = store.gateway_session(id).ok().flatten();
        let mut entry = RunningNetwork::new(
            None,
            Launched {
                proxy: None,
                fail_closed: profile.as_ref().is_none_or(|p| p.fail_closed),
                config_version: profile.as_ref().map_or(0, |p| p.network_config_version),
                privacy: None,
            },
        );
        if let Some(s) = session {
            entry.launched.proxy = Some(s.proxy_id.clone());
            entry.launched.fail_closed = s.fail_closed;
            let gateway = store
                .get_proxy(&s.proxy_id)
                .ok()
                .flatten()
                .ok_or(ipc::UNKNOWN_PROXY)
                .and_then(|proxy| {
                    entry.proxy_changed = proxy.version != s.proxy_version;
                    let route = Route {
                        upstream: self.upstream_for(store, &proxy)?,
                        fallback: if s.fail_closed {
                            Fallback::Block
                        } else {
                            Fallback::Direct
                        },
                        proxy_id: proxy.id.clone(),
                        proxy_version: proxy.version,
                    };
                    self.start_gateway(&route, s.port)
                });
            match gateway {
                Ok(g) => {
                    entry.gateway = Some(g);
                    let _ = store.audit(Some(id), "network", "gateway_restored", None, None);
                }
                Err(e) => {
                    entry.lost = true;
                    let _ = store.audit(Some(id), "network", "gateway_lost", None, Some(e.code));
                    self.events.emit_json(
                        WARNING,
                        json!({ "code": "PROXY_CONNECTION_LOST", "profile_id": id.as_str(), "reason": e.code }),
                    );
                }
            }
        }
        if let Ok(mut nets) = self.networks.lock() {
            nets.entry(id.clone()).or_insert(entry);
        }
    }

    /// Stops every gateway (the manager is exiting; profiles left running lose their connection until it restarts).
    pub fn stop_all_gateways(&self) {
        if let Ok(mut nets) = self.networks.lock() {
            for (_, n) in nets.drain() {
                if let Some(g) = n.gateway {
                    g.stop();
                }
            }
        }
    }

    /// After start-up: restores gateways for adopted browsers and forgets sessions of profiles that are closed.
    pub fn restore_networks(&self) {
        let Ok(store) = self.store() else { return };
        let running = self.supervisor.running_ids();
        for id in &running {
            self.restore_network(&store, id);
        }
        for (id, _) in store.gateway_sessions().unwrap_or_default() {
            if !running.contains(&id) {
                let _ = store.clear_gateway_session(&id);
            }
        }
        self.notify_running_changed();
    }

    /// The routing state shown for a profile.
    pub(crate) fn network_view(&self, p: &LocalProfile) -> NetworkView {
        let off = NetworkView {
            status: if p.proxy_id.is_some() { "ready" } else { "off" },
            last_error: None,
            direct_connections: 0,
            restart_required: false,
        };
        let Ok(nets) = self.networks.lock() else {
            return off;
        };
        let Some(n) = nets.get(&p.id) else {
            return off;
        };
        let restart_required = n.proxy_changed
            || n.launched.proxy != p.proxy_id
            || (p.proxy_id.is_some() && n.launched.fail_closed != p.fail_closed)
            || n.launched.config_version != p.network_config_version
            || n.launched
                .privacy
                .as_ref()
                .is_some_and(|c| c.browser_settings() != p.privacy.browser_settings());
        let Some(g) = &n.gateway else {
            return NetworkView {
                status: if n.lost { "lost" } else { "off" },
                last_error: None,
                direct_connections: 0,
                restart_required,
            };
        };
        let st = g.status();
        let status = if st.consecutive_failures == 0 {
            "active"
        } else if !n.launched.fail_closed && st.direct_connections > 0 {
            "bypassing"
        } else {
            "failing"
        };
        NetworkView {
            status,
            last_error: st.last_error,
            direct_connections: st.direct_connections,
            restart_required,
        }
    }

    /// One monitoring pass: drops gateways of profiles that closed, and reports a proxy that starts failing, a
    /// fail-open profile that starts going direct, and recovery.
    pub(crate) fn poll_networks(&self, store: &LocalStore) {
        let mut changed = false;
        let mut events = vec![];
        let mut closed = vec![];
        if let Ok(mut nets) = self.networks.lock() {
            for (id, n) in nets.iter_mut() {
                if !self.supervisor.is_tracked(id) {
                    closed.push(id.clone());
                    continue;
                }
                let Some(g) = &n.gateway else { continue };
                let st = g.status();
                let failing = st.consecutive_failures > 0;
                if failing != n.reported_failing {
                    n.reported_failing = failing;
                    changed = true;
                    if failing {
                        let code = st.last_error.unwrap_or("PROXY_UNREACHABLE");
                        let _ = store.audit(Some(id), "network", "proxy_failing", None, Some(code));
                        events.push(json!({ "code": "PROXY_FAILING", "profile_id": id.as_str(), "error": code,
                                            "fail_closed": n.launched.fail_closed }));
                    } else {
                        n.reported_bypass = false;
                        let _ = store.audit(Some(id), "network", "proxy_recovered", None, None);
                    }
                }
                if st.direct_connections > 0 && failing && !n.reported_bypass {
                    n.reported_bypass = true;
                    changed = true;
                    let _ = store.audit(Some(id), "network", "direct_fallback", None, None);
                    events.push(json!({ "code": "PROXY_BYPASSED", "profile_id": id.as_str(),
                                        "direct_connections": st.direct_connections }));
                }
            }
        }
        for id in &closed {
            self.untrack_network(store, id);
        }
        for e in events {
            self.events.emit_json(WARNING, e);
        }
        if changed || !closed.is_empty() {
            self.events.emit_json(
                PROFILES_CHANGED,
                json!({ "running": self.supervisor.running_count() }),
            );
        }
    }

    /// About hourly: deletes old check records and reminds about proxies that expire soon or have expired (once
    /// per proxy and state per manager session).
    pub(crate) fn proxy_housekeeping(&self, store: &LocalStore) {
        let _ = store.purge_checks();
        let Ok(Some(ws)) = self.active_workspace(store) else {
            return;
        };
        let today = today();
        let Ok(mut warned) = self.expiry_warned.lock() else {
            return;
        };
        for p in store.list_proxies(&ws).unwrap_or_default() {
            let (state, days_left) = expiry_state(p.expires_at.as_deref(), today);
            let Some(state) = state else { continue };
            let key = (p.id.clone(), state);
            if warned.contains(&key) {
                continue;
            }
            warned.push(key);
            self.events.emit_json(
                WARNING,
                json!({
                    "code": if state == "expired" { "PROXY_EXPIRED" } else { "PROXY_EXPIRING" },
                    "proxy_id": p.id.as_str(),
                    "expires_at": p.expires_at,
                    "days_left": days_left,
                }),
            );
        }
    }
}

/// Running networks by profile.
pub(crate) type Networks = HashMap<ProfileId, RunningNetwork>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_expiry() {
        assert_eq!(days_from_date("1970-01-01"), Some(0));
        assert_eq!(days_from_date("2000-03-01"), Some(11_017));
        assert_eq!(days_from_date("2026-10-13"), Some(20_739));
        let today = days_from_date("2026-10-13").unwrap_or_default();
        assert_eq!(expiry_state(None, today), (None, None));
        assert_eq!(
            expiry_state(Some("2026-10-12"), today),
            (Some("expired"), Some(-1))
        );
        assert_eq!(
            expiry_state(Some("2026-10-13"), today),
            (Some("expires_soon"), Some(0))
        );
        assert_eq!(
            expiry_state(Some("2026-10-20"), today),
            (Some("expires_soon"), Some(7))
        );
        assert_eq!(expiry_state(Some("2026-10-21"), today), (None, Some(8)));
    }

    #[test]
    fn logins_never_print() {
        let l = Login {
            username: "alice".into(),
            password: "hunter2".into(),
        };
        let input = ProxyInput {
            name: "x".into(),
            kind: "http".into(),
            host: "h".into(),
            port: 1,
            login: Some(l),
            expires_at: None,
            notes: String::new(),
        };
        let text = format!("{input:?}");
        assert!(
            !text.contains("hunter2") && !text.contains("alice"),
            "{text}"
        );
    }
}
