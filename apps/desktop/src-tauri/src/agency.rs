//! Agency workspace on this computer (milestone 09, ADR-0016): extension inventory and policy, health cards,
//! resource usage and the low-memory check, per-client downloads, local client overviews, selection summaries for
//! bulk confirmations, open-profile reminders and diagnostics previews.
//!
//! Nothing here reads browsing history, page content or site data. "Last activity" is what the app did (opened,
//! closed, backed up). Health never claims anything about website accounts: it describes this computer, the server
//! connection, proxies, the browser, backups, sessions and extensions, each with the time it was checked.

use crate::diagnostics::{self, Preview, Previews, Redactions, Redactor};
use crate::events::WARNING;
use crate::ipc::{self, IpcError};
use crate::lifecycle::MIN_FREE_BYTES;
use crate::state::{AppState, platform};
use pb_runtime::extensions::{self as ext, ExtensionRule, PolicyMode, Verdict};
use pb_runtime::{ClientId, ProfileId};
use pb_storage::LocalStore;
use pb_storage::agency::{CachedPolicy, StoredExtension};
use pb_storage::settings;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// A proxy check older than this is shown as "unknown", not as its last result.
pub const PROXY_CHECK_VALID: Duration = Duration::from_secs(24 * 3600);
/// The server connection check counts for this long.
pub const SERVER_CHECK_VALID_SECONDS: u32 = 15 * 60;
/// A cached organization extension policy is refreshed before an open when older than this.
pub const POLICY_REFRESH_AFTER: Duration = Duration::from_secs(5 * 60);
/// Memory kept free for the system and the manager when estimating how many more profiles fit.
pub const MEMORY_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
/// Estimate per browser before anything was measured on this computer (a blank page in recent Chromium).
pub const DEFAULT_PROFILE_BYTES: u64 = 450 * 1024 * 1024;
const MEMORY_SAMPLE_KIND: &str = "profile_memory_mb";
const SELECTION_MAX: usize = 10_000;

#[derive(Default)]
pub struct AgencyRuntime {
    pub(crate) previews: Previews,
    server_check_running: AtomicBool,
    /// Reminders already shown, by run id.
    reminded: Mutex<HashSet<String>>,
    policy_refreshing: Mutex<HashSet<String>>,
}

// ----------------------------------------------------------------------------- downloads

const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A folder name made from a client label: no path separators, no characters Windows or macOS refuse, no leading or
/// trailing dots or spaces (so never `.` or `..`), not a reserved device name, at most 64 characters.
pub fn folder_name(label: &str) -> String {
    let mapped: String = label
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .filter(|c| !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut name: String = collapsed
        .trim_matches(|c: char| c == '.' || c == ' ')
        .chars()
        .take(64)
        .collect();
    name = name.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() || name.chars().all(|c| c == '_') {
        return "Client".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED_WINDOWS_NAMES.contains(&stem.as_str()) {
        name.push('_');
    }
    name
}

/// The platform's usual downloads folder (`~/Downloads`).
pub fn default_downloads_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .filter(|_| cfg!(windows))
        .or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join("Downloads"))
}

/// Creates `base/<folder name>` when needed and checks it stays inside `base` and is a real folder.
fn client_subfolder(base: &Path, client: &str) -> Option<PathBuf> {
    let dir = base.join(folder_name(client));
    if dir.parent() != Some(base) {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    meta.is_dir().then_some(dir)
}

// ----------------------------------------------------------------------------- views

#[derive(Clone, Debug, Serialize)]
pub struct ExtensionView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub previous_version: Option<String>,
    pub source: String,
    pub enabled: bool,
    pub permissions: Vec<String>,
    pub sensitive: Vec<String>,
    pub added_sensitive: Vec<String>,
    pub changed_at: String,
    /// How the organization's policy judges it (`None`: a local profile, or no policy yet).
    pub verdict: Option<Verdict>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfileExtensions {
    pub profile_id: String,
    pub name: String,
    pub client_name: Option<String>,
    pub org_id: Option<String>,
    /// `local` (no organization), or the organization's mode.
    pub mode: String,
    pub scan_status: Option<String>,
    pub scanned_at: Option<String>,
    pub reported_at: Option<String>,
    /// Extensions turn off at the next open (enforce mode, something not approved).
    pub will_disable: bool,
    pub needs_attention: u32,
    pub extensions: Vec<ExtensionView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PolicyView {
    pub org_id: String,
    pub mode: String,
    pub version: i64,
    pub rules: usize,
    pub fetched_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExtensionsView {
    pub profiles: Vec<ProfileExtensions>,
    pub policies: Vec<PolicyView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HealthItem {
    pub label: String,
    pub status: &'static str,
    pub detail: String,
    pub checked_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HealthCard {
    pub id: &'static str,
    pub title: &'static str,
    /// ok | warning | problem | unknown | off
    pub status: &'static str,
    pub summary: String,
    /// When this was checked (`None`: never). Cards computed from this computer's state are checked now.
    pub checked_at: Option<String>,
    /// After this the result no longer describes the present.
    pub valid_until: Option<String>,
    /// What the card's button does: retry_server | check_proxies | rescan_extensions | open_extensions |
    /// open_backups | open_runtime | open_sessions | open_resources.
    pub action: Option<&'static str>,
    pub items: Vec<HealthItem>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HealthView {
    pub generated_at: String,
    pub cards: Vec<HealthCard>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfileResources {
    pub profile_id: String,
    pub name: String,
    pub client_name: Option<String>,
    pub processes: usize,
    pub memory_bytes: u64,
    pub open_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemoryEstimate {
    pub per_profile_bytes: u64,
    /// measured: the median of this computer's own measurements; default: nothing measured yet.
    pub source: &'static str,
    pub samples: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResourcesView {
    pub measured_at: String,
    pub manager: Value,
    pub profiles: Vec<ProfileResources>,
    pub browsers_memory_bytes: u64,
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub estimate: MemoryEstimate,
}

#[derive(Clone, Debug, Serialize)]
pub struct LaunchExtensions {
    pub profile_id: String,
    pub name: String,
    pub mode: String,
    /// Opens with extensions turned off.
    pub disable: bool,
    pub items: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LaunchCheck {
    pub to_open: usize,
    pub already_open: usize,
    pub memory: Value,
    pub extensions: Vec<LaunchExtensions>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SelectionClient {
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub count: usize,
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SelectionSummary {
    pub total: usize,
    pub running: usize,
    pub shared: usize,
    pub missing: usize,
    pub clients: Vec<SelectionClient>,
}

/// Whether extensions are turned off for this open, and why.
#[derive(Clone, Debug, Default)]
pub(crate) struct ExtensionGate {
    pub disable: bool,
    pub not_approved: Vec<(String, String, Verdict)>,
}

// Civil dates (proleptic Gregorian, UTC), after Howard Hinnant's algorithms.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff](Z|+00:00)` (the store's and the server's UTC timestamps) to Unix seconds.
pub(crate) fn unix_from_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b' ')
        || b[13] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let days = days_from_civil(num(0..4)?, num(5..7)?, num(8..10)?);
    let secs = days * 86_400 + num(11..13)? * 3600 + num(14..16)? * 60 + num(17..19)?;
    u64::try_from(secs).ok()
}

pub(crate) fn iso_from_unix(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix(d.as_secs(), d.subsec_millis())
}

fn rules_of(policy: &CachedPolicy) -> Vec<ExtensionRule> {
    serde_json::from_str(&policy.rules).unwrap_or_default()
}

fn verdict_for(rules: &[ExtensionRule], e: &StoredExtension) -> Verdict {
    let source = ext::ExtensionSource::parse(&e.source).unwrap_or(ext::ExtensionSource::Other);
    ext::judge(rules, &e.id, &e.version, source, &e.permissions)
}

/// Seconds since an ISO timestamp from the store (`None` if unparsable).
fn age_seconds(iso: &str) -> Option<u64> {
    let then = unix_from_iso(iso)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(then))
}

fn worst(statuses: impl Iterator<Item = &'static str>) -> &'static str {
    let rank = |s: &str| match s {
        "problem" => 4,
        "warning" => 3,
        "unknown" => 2,
        "ok" => 1,
        _ => 0,
    };
    statuses.max_by_key(|s| rank(s)).unwrap_or("ok")
}

impl AppState {
    // ------------------------------------------------------------------------- extensions
    /// Reads the profile's installed extensions and stores what changed. Updates that add sensitive permissions are
    /// announced (a warning the window shows until reviewed).
    pub(crate) fn scan_extensions(&self, store: &LocalStore, id: &ProfileId) -> bool {
        let dirs = self.root.dirs(id);
        match ext::read_installed(&dirs.user_data) {
            Ok(found) => match store.record_extension_scan(id, &found) {
                Ok(changes) => {
                    for (ext_id, old, new) in &changes.updated {
                        let detail = format!("updated {ext_id} {old} -> {new}");
                        let _ = store.audit(Some(id), "extension", "updated", None, Some(&detail));
                    }
                    for (ext_id, added) in &changes.expanded {
                        let _ = store.audit(
                            Some(id),
                            "extension",
                            "permissions_added",
                            None,
                            Some(
                                &format!("{ext_id} {}", added.join(" "))
                                    .chars()
                                    .take(200)
                                    .collect::<String>(),
                            ),
                        );
                        self.events.emit_json(
                            WARNING,
                            json!({ "code": "EXTENSION_PERMISSIONS_ADDED", "profile_id": id.as_str(),
                                    "extension_id": ext_id, "permissions": added }),
                        );
                    }
                    for ext_id in &changes.added {
                        let _ = store.audit(Some(id), "extension", "installed", None, Some(ext_id));
                    }
                    for ext_id in &changes.removed {
                        let _ = store.audit(Some(id), "extension", "removed", None, Some(ext_id));
                    }
                    true
                }
                Err(_) => false,
            },
            Err(_) => {
                let _ = store.record_extension_scan_failed(id);
                false
            }
        }
    }

    /// The organization policy for a linked profile (cached copy; `None` for local profiles or before the first
    /// download).
    fn policy_for(&self, store: &LocalStore, id: &ProfileId) -> Option<CachedPolicy> {
        let link = store.sync_link(id).ok()??;
        store.extension_policy(&link.org_id).ok()?
    }

    /// Downloads an organization's extension policy into the cache (shell request; never from the window).
    pub(crate) fn refresh_extension_policy(&self, org_id: &str) -> Result<CachedPolicy, IpcError> {
        if org_id.len() != 30 || !org_id.starts_with("org_") {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let body = self
            .shell_api(
                pb_cloud::Method::Get,
                &format!("/v1/orgs/{org_id}/extension-policy"),
                None,
                None,
            )
            .map_err(|e| match e {
                pb_sync::ApiError::Offline => ipc::CLOUD_OFFLINE,
                pb_sync::ApiError::SignedOut => ipc::CLOUD_SIGNED_OUT,
                _ => ipc::CLOUD_UNAVAILABLE,
            })?;
        let mode = body
            .get("mode")
            .and_then(Value::as_str)
            .and_then(PolicyMode::parse)
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let version = body
            .get("version")
            .and_then(Value::as_i64)
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let rules: Vec<ExtensionRule> = body
            .get("extensions")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .ok_or(ipc::CLOUD_BAD_RESPONSE)?;
        let rules: Vec<ExtensionRule> = rules
            .into_iter()
            .filter(|r| ext::valid_extension_id(&r.extension_id))
            .take(500)
            .collect();
        let text = serde_json::to_string(&rules).map_err(|_| ipc::INTERNAL)?;
        let store = self.store()?;
        store.save_extension_policy(org_id, mode.as_str(), version.max(1), &text)?;
        store.extension_policy(org_id)?.ok_or(ipc::INTERNAL)
    }

    /// Before opening a linked profile: refresh the cached policy if it is older than [`POLICY_REFRESH_AFTER`] (best
    /// effort: offline, the cached copy applies).
    pub(crate) fn refresh_policy_if_stale(&self, org_id: &str) {
        let Ok(store) = self.store() else { return };
        let fresh = store
            .extension_policy(org_id)
            .ok()
            .flatten()
            .and_then(|p| age_seconds(&p.fetched_at))
            .is_some_and(|age| age < POLICY_REFRESH_AFTER.as_secs());
        if fresh {
            return;
        }
        let busy = self
            .agency
            .policy_refreshing
            .lock()
            .map(|mut s| !s.insert(org_id.to_owned()))
            .unwrap_or(true);
        if busy {
            return;
        }
        let _ = self.refresh_extension_policy(org_id);
        if let Ok(mut s) = self.agency.policy_refreshing.lock() {
            s.remove(org_id);
        }
    }

    /// Scans the profile and decides whether this open runs with extensions turned off: only an organization policy
    /// in enforce mode does that, when an installed extension (enabled or not: it could be turned on in the browser)
    /// is not approved.
    pub(crate) fn extension_gate(&self, store: &LocalStore, id: &ProfileId) -> ExtensionGate {
        self.scan_extensions(store, id);
        let Some(policy) = self.policy_for(store, id) else {
            return ExtensionGate::default();
        };
        let mode = PolicyMode::parse(&policy.mode).unwrap_or(PolicyMode::Off);
        if mode == PolicyMode::Off {
            return ExtensionGate::default();
        }
        let rules = rules_of(&policy);
        let not_approved: Vec<(String, String, Verdict)> = store
            .list_extensions(Some(id))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| {
                let v = verdict_for(&rules, &e);
                (!v.is_approved()).then_some((e.id, e.name, v))
            })
            .collect();
        ExtensionGate {
            disable: mode == PolicyMode::Enforce && !not_approved.is_empty(),
            not_approved,
        }
    }

    /// Records and announces the gate's decision for an open that is going ahead.
    pub(crate) fn announce_gate(&self, store: &LocalStore, id: &ProfileId, gate: &ExtensionGate) {
        if gate.not_approved.is_empty() {
            return;
        }
        let names: Vec<Value> = gate
            .not_approved
            .iter()
            .map(|(eid, name, v)| json!({ "id": eid, "name": name, "verdict": v }))
            .collect();
        let detail: String = gate
            .not_approved
            .iter()
            .map(|(eid, _, v)| format!("{eid}:{}", v.code()))
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(200)
            .collect();
        let outcome = if gate.disable { "disabled" } else { "warned" };
        let _ = store.audit(Some(id), "extension", outcome, None, Some(&detail));
        self.events.emit_json(
            WARNING,
            json!({
                "code": if gate.disable { "EXTENSIONS_DISABLED" } else { "EXTENSIONS_NOT_APPROVED" },
                "profile_id": id.as_str(),
                "extensions": names,
            }),
        );
    }

    /// Sends the profile's inventory to its organization (best effort, in the background).
    pub(crate) fn report_extensions_later(self: &Arc<Self>, id: &ProfileId) {
        let this = self.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let _ = this.report_extensions(&id);
        });
    }

    fn report_extensions(&self, id: &ProfileId) -> Result<(), IpcError> {
        let store = self.store()?;
        let Some(link) = store.sync_link(id)? else {
            return Ok(());
        };
        let device = store
            .cloud_state(pb_storage::cloud::DEVICE_ID)?
            .ok_or(ipc::CLOUD_SIGNED_OUT)?;
        let items: Vec<Value> = store
            .list_extensions(Some(id))?
            .into_iter()
            .take(ext::MAX_EXTENSIONS)
            .map(|e| {
                json!({ "id": e.id, "name": e.name, "version": e.version, "source": e.source,
                        "enabled": e.enabled, "permissions": e.permissions })
            })
            .collect();
        let body = json!({ "device_id": device, "extensions": items });
        self.shell_api(
            pb_cloud::Method::Put,
            &format!(
                "/v1/orgs/{}/profiles/{}/extension-report",
                link.org_id, link.org_profile_id
            ),
            None,
            Some(&body),
        )
        .map_err(|_| ipc::CLOUD_UNAVAILABLE)?;
        store.mark_extensions_reported(id)?;
        Ok(())
    }

    /// After a session ends: Chromium may have installed or updated extensions while it ran.
    pub(crate) fn extensions_after_exit(self: &Arc<Self>, id: &ProfileId) {
        let this = self.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let Ok(store) = this.store() else { return };
            this.scan_extensions(&store, &id);
            if store.sync_link(&id).ok().flatten().is_some() {
                let _ = this.report_extensions(&id);
            }
        });
    }

    pub fn extensions_view(&self, profile: Option<&ProfileId>) -> Result<ExtensionsView, IpcError> {
        let store = self.store()?;
        let installed = store.list_extensions(profile)?;
        let scans: HashMap<String, pb_storage::agency::ExtensionScan> = store
            .extension_scans()?
            .into_iter()
            .map(|s| (s.profile_id.clone(), s))
            .collect();
        let mut by_profile: BTreeMap<String, Vec<StoredExtension>> = BTreeMap::new();
        for e in installed {
            by_profile.entry(e.profile_id.clone()).or_default().push(e);
        }
        if let Some(p) = profile {
            by_profile.entry(p.to_string()).or_default();
        } else {
            for id in scans.keys() {
                by_profile.entry(id.clone()).or_default();
            }
        }
        let mut policies: HashMap<String, Option<CachedPolicy>> = HashMap::new();
        let mut profiles = vec![];
        for (pid, list) in by_profile {
            let Ok(id) = ProfileId::parse(&pid) else {
                continue;
            };
            let Some(p) = store.get_profile(&id)? else {
                continue;
            };
            let link = store.sync_link(&id)?;
            let policy = match &link {
                Some(l) => policies
                    .entry(l.org_id.clone())
                    .or_insert_with(|| store.extension_policy(&l.org_id).ok().flatten())
                    .clone(),
                None => None,
            };
            let rules = policy.as_ref().map(rules_of);
            let mode = match (&link, &policy) {
                (None, _) => "local".to_owned(),
                (Some(_), None) => "unknown".to_owned(),
                (Some(_), Some(p)) => p.mode.clone(),
            };
            let judging = policy.as_ref().is_some_and(|p| p.mode != "off");
            let extensions: Vec<ExtensionView> = list
                .into_iter()
                .map(|e| ExtensionView {
                    verdict: rules.as_ref().map(|r| verdict_for(r, &e)),
                    sensitive: e
                        .permissions
                        .iter()
                        .filter(|p| ext::is_sensitive_permission(p))
                        .cloned()
                        .collect(),
                    id: e.id,
                    name: e.name,
                    version: e.version,
                    previous_version: e.previous_version,
                    source: e.source,
                    enabled: e.enabled,
                    permissions: e.permissions,
                    added_sensitive: e.added_sensitive,
                    changed_at: e.changed_at,
                })
                .collect();
            let needs_attention = extensions
                .iter()
                .filter(|e| {
                    (judging && e.verdict.as_ref().is_some_and(|v| !v.is_approved()))
                        || (link.is_none() && !e.added_sensitive.is_empty())
                })
                .count() as u32;
            let scan = scans.get(&pid);
            profiles.push(ProfileExtensions {
                will_disable: mode == "enforce" && needs_attention > 0,
                profile_id: pid,
                name: p.name,
                client_name: p.client_name,
                org_id: link.map(|l| l.org_id),
                mode,
                scan_status: scan.map(|s| s.status.clone()),
                scanned_at: scan.map(|s| s.scanned_at.clone()),
                reported_at: scan.and_then(|s| s.reported_at.clone()),
                needs_attention,
                extensions,
            });
        }
        let mut orgs: Vec<String> = store
            .sync_links(None)?
            .into_iter()
            .map(|l| l.org_id)
            .collect();
        orgs.sort();
        orgs.dedup();
        let policies = orgs
            .iter()
            .filter_map(|o| store.extension_policy(o).ok().flatten())
            .map(|p| PolicyView {
                rules: rules_of(&p).len(),
                org_id: p.org_id,
                mode: p.mode,
                version: p.version,
                fetched_at: p.fetched_at,
            })
            .collect();
        Ok(ExtensionsView { profiles, policies })
    }

    /// Rescans one stopped profile (or every stopped profile), then refreshes the organizations' policies.
    pub fn rescan_extensions(
        &self,
        profile: Option<&ProfileId>,
    ) -> Result<ExtensionsView, IpcError> {
        let store = self.store()?;
        let ids: Vec<ProfileId> = match profile {
            Some(p) => {
                store.get_profile(p)?.ok_or(ipc::UNKNOWN_PROFILE)?;
                vec![p.clone()]
            }
            None => store
                .extension_scans()?
                .into_iter()
                .filter_map(|s| ProfileId::parse(&s.profile_id).ok())
                .collect(),
        };
        let running: HashSet<ProfileId> = self.supervisor.running_ids().into_iter().collect();
        for id in ids.iter().filter(|i| !running.contains(*i)).take(500) {
            self.scan_extensions(&store, id);
        }
        let mut orgs: Vec<String> = store
            .sync_links(None)?
            .into_iter()
            .map(|l| l.org_id)
            .collect();
        orgs.sort();
        orgs.dedup();
        for org in orgs {
            let _ = self.refresh_extension_policy(&org);
        }
        self.extensions_view(profile)
    }

    /// The person reviewed what an update added (local profiles).
    pub fn review_extension(
        &self,
        id: &ProfileId,
        extension_id: &str,
    ) -> Result<ExtensionsView, IpcError> {
        if !ext::valid_extension_id(extension_id) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        store
            .acknowledge_extension(id, extension_id)
            .map_err(|e| match e {
                pb_storage::StoreError::NotFound => ipc::INVALID_ARGUMENT,
                other => other.into(),
            })?;
        let _ = store.audit(Some(id), "extension", "reviewed", None, Some(extension_id));
        self.extensions_view(Some(id))
    }

    // ------------------------------------------------------------------------- downloads
    /// The folder a profile downloads into: its own folder, else its client's, else (with per-client folders on) a
    /// subfolder named after the client inside the usual folder, else the usual folder (the setting, or the
    /// browser's default). Chromium reads it when the profile opens; nothing is ever moved.
    pub(crate) fn download_dir_for(
        &self,
        store: &LocalStore,
        profile: &pb_storage::LocalProfile,
    ) -> Option<String> {
        if let Some(own) = &profile.download_dir {
            return Some(own.clone());
        }
        if let Some(client) = &profile.client_download_dir {
            return Some(client.clone());
        }
        let base_setting = store
            .get_setting(settings::DOWNLOAD_DIR)
            .ok()
            .and_then(|v| v.value.as_str().map(str::to_owned));
        let per_client = store
            .get_setting(settings::PER_CLIENT_DOWNLOADS)
            .ok()
            .is_some_and(|v| v.value == Value::Bool(true));
        if per_client && let Some(client) = &profile.client_name {
            let base = base_setting
                .clone()
                .map(PathBuf::from)
                .or_else(default_downloads_dir)?;
            if let Some(dir) = client_subfolder(&base, client) {
                return Some(dir.to_string_lossy().into_owned());
            }
        }
        base_setting
    }

    pub fn set_client_download_directory(
        &self,
        client: &ClientId,
        chosen: Option<&Path>,
    ) -> Result<Option<String>, IpcError> {
        let store = self.store()?;
        store.get_client(client)?.ok_or(ipc::UNKNOWN_CLIENT)?;
        let text = match chosen {
            Some(p) => Some(self.validate_download_dir(p)?),
            None => None,
        };
        store.set_client_download_dir(client, text.as_deref())?;
        Ok(text)
    }

    // ------------------------------------------------------------------------- client overview and selections
    pub fn client_overview(&self, client: &ClientId) -> Result<Value, IpcError> {
        let store = self.store()?;
        let c = store.get_client(client)?.ok_or(ipc::UNKNOWN_CLIENT)?;
        let overview = store.client_overview(client, 50)?;
        let activity: Vec<Value> = store
            .client_activity(client, 20)?
            .into_iter()
            .map(|(a, name)| {
                json!({ "at": a.at, "profile_id": a.profile_id, "profile_name": name, "action": a.action,
                        "outcome": a.outcome })
            })
            .collect();
        let per_client = store
            .get_setting(settings::PER_CLIENT_DOWNLOADS)
            .ok()
            .is_some_and(|v| v.value == Value::Bool(true));
        let base = store
            .get_setting(settings::DOWNLOAD_DIR)
            .ok()
            .and_then(|v| v.value.as_str().map(str::to_owned));
        let effective = c.download_dir.clone().or_else(|| {
            if per_client {
                base.clone()
                    .map(PathBuf::from)
                    .or_else(default_downloads_dir)
                    .map(|b| b.join(folder_name(&c.name)).to_string_lossy().into_owned())
            } else {
                base.clone()
            }
        });
        Ok(json!({
            "client": c,
            "profiles": overview,
            "activity": activity,
            "downloads": {
                "client_folder": c.download_dir,
                "per_client_folders": per_client,
                "effective": effective,
                "folder_name": folder_name(&c.name),
            },
        }))
    }

    /// Who and what a bulk action would touch, grouped by client, for the confirmation dialog.
    pub fn selection_summary(
        &self,
        selection: crate::manage::Selection,
    ) -> Result<SelectionSummary, IpcError> {
        let store = self.store()?;
        let requested = match &selection {
            crate::manage::Selection::Ids { ids } => ids.len(),
            crate::manage::Selection::Filter { expected_total, .. } => *expected_total as usize,
        };
        if requested > SELECTION_MAX {
            return Err(ipc::SELECTION_TOO_LARGE);
        }
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        let ids = self.resolve_selection(&store, &ws, selection)?;
        let ids = &ids;
        let rows = store.selection_rows(ids)?;
        let mut groups: BTreeMap<(Option<String>, Option<String>), Vec<String>> = BTreeMap::new();
        for r in &rows {
            groups
                .entry((r.client_name.clone(), r.client_id.clone()))
                .or_default()
                .push(r.name.clone());
        }
        let mut clients: Vec<SelectionClient> = groups
            .into_iter()
            .map(|((client_name, client_id), mut names)| {
                names.sort_by_key(|n| n.to_lowercase());
                SelectionClient {
                    client_id,
                    client_name,
                    count: names.len(),
                    names: names.into_iter().take(5).collect(),
                }
            })
            .collect();
        // Profiles without a client last.
        clients.sort_by_key(|c| c.client_name.is_none());
        Ok(SelectionSummary {
            total: rows.len(),
            running: rows.iter().filter(|r| r.running).count(),
            shared: rows.iter().filter(|r| r.shared).count(),
            missing: ids.len() - rows.len(),
            clients,
        })
    }

    // ------------------------------------------------------------------------- resources
    fn memory_estimate(&self, store: &LocalStore) -> MemoryEstimate {
        match store.timing_summary(MEMORY_SAMPLE_KIND) {
            Ok(s) if s.count >= 1 && s.p50_ms.is_some() => MemoryEstimate {
                per_profile_bytes: (s.p50_ms.unwrap_or(0.0) * 1024.0 * 1024.0) as u64,
                source: "measured",
                samples: s.count,
            },
            _ => MemoryEstimate {
                per_profile_bytes: DEFAULT_PROFILE_BYTES,
                source: "default",
                samples: 0,
            },
        }
    }

    fn system_memory() -> (u64, u64) {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        (sys.total_memory(), sys.available_memory())
    }

    pub fn resources(&self) -> Result<ResourcesView, IpcError> {
        let store = self.store()?;
        let usage = self.supervisor.resource_usage();
        let mut profiles = vec![];
        for u in &usage.profiles {
            let p = store.get_profile(&u.profile_id)?;
            // Trees that are up and have a window count as a measurement for the estimate.
            if u.memory_bytes > 0 && u.processes > 2 {
                let _ = store.record_timing(
                    MEMORY_SAMPLE_KIND,
                    u.memory_bytes as f64 / (1024.0 * 1024.0),
                );
            }
            profiles.push(ProfileResources {
                profile_id: u.profile_id.to_string(),
                name: p.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
                client_name: p.and_then(|p| p.client_name),
                processes: u.processes,
                memory_bytes: u.memory_bytes,
                open_seconds: u.open_seconds,
            });
        }
        profiles.sort_by_key(|p| std::cmp::Reverse(p.memory_bytes));
        let (total, available) = Self::system_memory();
        Ok(ResourcesView {
            measured_at: now_iso(),
            manager: json!({ "processes": usage.manager_processes, "memory_bytes": usage.manager_memory_bytes }),
            browsers_memory_bytes: profiles.iter().map(|p| p.memory_bytes).sum(),
            profiles,
            total_memory_bytes: total,
            available_memory_bytes: available,
            estimate: self.memory_estimate(&store),
        })
    }

    /// What opening these profiles would mean: memory (from this computer's own measurements, not a promise about
    /// any website) and extensions that will be turned off or are not approved.
    pub fn launch_check(&self, ids: &[ProfileId]) -> Result<LaunchCheck, IpcError> {
        if ids.len() > 500 {
            return Err(ipc::SELECTION_TOO_LARGE);
        }
        let store = self.store()?;
        let running: HashSet<ProfileId> = self.supervisor.running_ids().into_iter().collect();
        let to_open: Vec<&ProfileId> = ids.iter().filter(|i| !running.contains(*i)).collect();
        let estimate = self.memory_estimate(&store);
        let (_, available) = Self::system_memory();
        let needed = estimate
            .per_profile_bytes
            .saturating_mul(to_open.len() as u64);
        let enabled = store
            .get_setting(settings::MEMORY_WARNING)
            .ok()
            .is_none_or(|v| v.value != Value::Bool(false));
        let warn = enabled
            && !to_open.is_empty()
            && available < needed.saturating_add(MEMORY_RESERVE_BYTES);
        let fits =
            available.saturating_sub(MEMORY_RESERVE_BYTES) / estimate.per_profile_bytes.max(1);
        let mut extensions = vec![];
        for id in to_open.iter().take(50) {
            let Some(p) = store.get_profile(id)? else {
                continue;
            };
            let Some(policy) = self.policy_for(&store, id) else {
                continue;
            };
            let mode = PolicyMode::parse(&policy.mode).unwrap_or(PolicyMode::Off);
            if mode == PolicyMode::Off {
                continue;
            }
            // The profile is closed: read what is installed now (the browser may have changed it last time).
            self.scan_extensions(&store, id);
            let rules = rules_of(&policy);
            let items: Vec<Value> = store
                .list_extensions(Some(id))?
                .into_iter()
                .filter_map(|e| {
                    let v = verdict_for(&rules, &e);
                    (!v.is_approved()).then(|| json!({ "id": e.id, "name": e.name, "verdict": v }))
                })
                .collect();
            if !items.is_empty() {
                extensions.push(LaunchExtensions {
                    profile_id: id.to_string(),
                    name: p.name,
                    mode: mode.as_str().into(),
                    disable: mode == PolicyMode::Enforce,
                    items,
                });
            }
        }
        Ok(LaunchCheck {
            to_open: to_open.len(),
            already_open: ids.len() - to_open.len(),
            memory: json!({
                "warn": warn,
                "available_bytes": available,
                "needed_bytes": needed,
                "reserve_bytes": MEMORY_RESERVE_BYTES,
                "fits_about": fits,
                "estimate": estimate,
            }),
            extensions,
        })
    }

    // ------------------------------------------------------------------------- open reminders
    /// Called by the monitor about once a minute: profiles open longer than the chosen number of hours get one
    /// reminder per session. The app never closes them on its own (it cannot see unsaved work in a page).
    pub(crate) fn open_reminders(&self, store: &LocalStore) {
        let hours = match store.get_setting(settings::OPEN_REMINDER).map(|v| v.value) {
            Ok(Value::String(h)) => h.parse::<u64>().ok(),
            _ => None,
        };
        let Some(hours) = hours else { return };
        for (id, run_id, open_for) in self.supervisor.open_durations() {
            let Some(run) = run_id else { continue };
            if open_for.as_secs() < hours * 3600 {
                continue;
            }
            let first = self
                .agency
                .reminded
                .lock()
                .map(|mut r| r.insert(run))
                .unwrap_or(false);
            if first {
                self.events.emit_json(
                    WARNING,
                    json!({ "code": "OPEN_REMINDER", "profile_id": id.as_str(), "hours": hours }),
                );
            }
        }
    }

    // ------------------------------------------------------------------------- health
    /// Checks the organization server with the signed-in session (`GET /v1/me`) and records the result.
    pub(crate) fn check_server(&self) {
        let Ok(store) = self.store() else { return };
        if store
            .cloud_state(pb_storage::cloud::SERVER_URL)
            .ok()
            .flatten()
            .is_none()
        {
            let _ = store.clear_health("server", "");
            return;
        }
        if self
            .agency
            .server_check_running
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        let (result, code) = match self.shell_api(pb_cloud::Method::Get, "/v1/me", None, None) {
            Ok(_) => ("ok", None),
            Err(pb_sync::ApiError::Offline) => ("problem", Some("CLOUD_OFFLINE")),
            Err(pb_sync::ApiError::SignedOut) => ("warning", Some("CLOUD_SIGNED_OUT")),
            Err(_) => ("problem", Some("CLOUD_UNAVAILABLE")),
        };
        let _ = store.record_health(
            "server",
            "",
            None,
            result,
            code,
            None,
            SERVER_CHECK_VALID_SECONDS,
        );
        self.agency
            .server_check_running
            .store(false, Ordering::SeqCst);
    }

    pub(crate) fn check_server_later(self: &Arc<Self>) {
        let this = self.clone();
        std::thread::spawn(move || this.check_server());
    }

    pub fn health(&self) -> Result<HealthView, IpcError> {
        let store = self.store()?;
        let now = now_iso();
        let mut cards = vec![];
        let computed = |status, title, id, summary: String, action, items| HealthCard {
            id,
            title,
            status,
            summary,
            checked_at: Some(now.clone()),
            valid_until: None,
            action,
            items,
        };

        // Server connection.
        let server_configured = store.cloud_state(pb_storage::cloud::SERVER_URL)?.is_some();
        let observation = store
            .list_health()?
            .into_iter()
            .find(|h| h.check_type == "server" && h.subject.is_empty());
        cards.push(match (server_configured, observation) {
            (false, _) => computed(
                "off",
                "Server connection",
                "connectivity",
                "No organization server is set up; this computer works on its own.".into(),
                None,
                vec![],
            ),
            (true, None) => HealthCard {
                id: "connectivity",
                title: "Server connection",
                status: "unknown",
                summary: "Not checked yet.".into(),
                checked_at: None,
                valid_until: None,
                action: Some("retry_server"),
                items: vec![],
            },
            (true, Some(h)) => {
                let status: &'static str = if h.expired {
                    "unknown"
                } else {
                    match h.result.as_str() {
                        "ok" => "ok",
                        "warning" => "warning",
                        "problem" => "problem",
                        _ => "unknown",
                    }
                };
                let summary = match (h.expired, h.result.as_str(), h.code.as_deref()) {
                    (true, _, _) => {
                        "The last check is too old to say whether the server can be reached now."
                            .into()
                    }
                    (false, "ok", _) => "The server answered and your sign-in works.".into(),
                    (false, _, Some("CLOUD_SIGNED_OUT")) => {
                        "Signed out: sign in again to use organization profiles.".into()
                    }
                    (false, _, Some("CLOUD_OFFLINE")) => {
                        "The server could not be reached from this computer.".into()
                    }
                    _ => "The server did not answer as expected.".into(),
                };
                HealthCard {
                    id: "connectivity",
                    title: "Server connection",
                    status,
                    summary,
                    checked_at: Some(h.checked_at),
                    valid_until: Some(h.expires_at),
                    action: Some("retry_server"),
                    items: vec![],
                }
            }
        });

        // Proxies: a check counts for 24 hours.
        let workspace = self.active_workspace(&store)?;
        let proxies = match &workspace {
            Some(ws) => store.list_proxies(ws)?,
            None => vec![],
        };
        let mut proxy_items = vec![];
        let mut newest: Option<String> = None;
        for px in &proxies {
            let (status, detail, at) = match &px.last_check {
                None => ("unknown", "Never checked.".to_owned(), None),
                Some(c) => {
                    let stale =
                        age_seconds(&c.checked_at).is_none_or(|a| a > PROXY_CHECK_VALID.as_secs());
                    if newest.as_deref().is_none_or(|n| n < c.checked_at.as_str()) {
                        newest = Some(c.checked_at.clone());
                    }
                    if stale {
                        (
                            "unknown",
                            "The last check is more than a day old; it says nothing about now."
                                .to_owned(),
                            Some(c.checked_at.clone()),
                        )
                    } else if c.result == "ok" {
                        (
                            "ok",
                            "Reachable when checked.".to_owned(),
                            Some(c.checked_at.clone()),
                        )
                    } else {
                        (
                            "problem",
                            format!(
                                "Failed when checked ({}).",
                                c.error_code.as_deref().unwrap_or("error")
                            ),
                            Some(c.checked_at.clone()),
                        )
                    }
                }
            };
            proxy_items.push(HealthItem {
                label: px.name.clone(),
                status,
                detail,
                checked_at: at,
            });
        }
        cards.push(if proxies.is_empty() {
            computed(
                "off",
                "Proxies",
                "proxies",
                "No proxies in this workspace.".into(),
                None,
                vec![],
            )
        } else {
            let status = worst(proxy_items.iter().map(|i| i.status));
            let failing = proxy_items.iter().filter(|i| i.status == "problem").count();
            let unknown = proxy_items.iter().filter(|i| i.status == "unknown").count();
            HealthCard {
                id: "proxies",
                title: "Proxies",
                status,
                summary: match (failing, unknown) {
                    (0, 0) => format!(
                        "{} checked in the last 24 hours and reachable.",
                        proxy_items.len()
                    ),
                    (0, u) => format!("{u} not checked in the last 24 hours."),
                    (f, _) => format!("{f} failed their last check."),
                },
                checked_at: newest,
                valid_until: None,
                action: Some("check_proxies"),
                items: proxy_items,
            }
        });

        // Browser.
        let runtime = self.resolve_runtime(&store);
        let manifest_version = self.manifest.as_ref().map(|m| m.runtime.version.clone());
        cards.push(match runtime {
            Ok(r) if r.source == "development_override" => computed(
                "ok",
                "Browser",
                "browser",
                "A development browser is configured.".into(),
                None,
                vec![],
            ),
            Ok(r) => computed(
                "ok",
                "Browser",
                "browser",
                format!(
                    "Browser {} is installed and verified (the version this app is built for).",
                    r.version.unwrap_or_default()
                ),
                None,
                vec![],
            ),
            Err(e) if e.code == ipc::RUNTIME_NOT_INSTALLED.code => computed(
                "problem",
                "Browser",
                "browser",
                format!(
                    "Browser {} needs to be installed before profiles can open.",
                    manifest_version.unwrap_or_default()
                ),
                Some("open_runtime"),
                vec![],
            ),
            Err(e) => computed(
                "problem",
                "Browser",
                "browser",
                e.message.to_owned(),
                Some("open_runtime"),
                vec![],
            ),
        });

        // Organization backups and conflicts.
        let links = store.sync_links(None)?;
        let mut backup_items = vec![];
        let mut conflict_items = vec![];
        for l in &links {
            let name = store
                .get_profile(&l.local_profile_id)?
                .map(|p| p.name)
                .unwrap_or_default();
            if l.conflict_head.is_some() {
                conflict_items.push(HealthItem {
                    label: name.clone(),
                    status: "problem",
                    detail: "A newer backup was made elsewhere: choose which copy to keep.".into(),
                    checked_at: None,
                });
            }
            match &l.synced_at {
                None => backup_items.push(HealthItem {
                    label: name,
                    status: "warning",
                    detail: "Never backed up from this computer.".into(),
                    checked_at: None,
                }),
                Some(at) if l.dirty && age_seconds(at).is_some_and(|a| a > 7 * 24 * 3600) => {
                    backup_items.push(HealthItem {
                        label: name,
                        status: "warning",
                        detail: "Changed here since its last backup, more than 7 days ago.".into(),
                        checked_at: Some(at.clone()),
                    })
                }
                _ => {}
            }
        }
        cards.push(if links.is_empty() {
            computed(
                "off",
                "Backups",
                "backups",
                "No organization profiles on this computer.".into(),
                None,
                vec![],
            )
        } else {
            let status = if backup_items.is_empty() {
                "ok"
            } else {
                "warning"
            };
            let summary = if backup_items.is_empty() {
                format!(
                    "{} organization profiles: backups are current.",
                    links.len()
                )
            } else {
                format!(
                    "{} of {} organization profiles need a backup.",
                    backup_items.len(),
                    links.len()
                )
            };
            computed(
                status,
                "Backups",
                "backups",
                summary,
                Some("open_backups"),
                backup_items,
            )
        });
        let team = store.team_sessions()?;
        for s in team
            .iter()
            .filter(|s| matches!(s.phase.as_str(), "pending" | "lost"))
        {
            let name = store
                .get_profile(&s.local_profile_id)?
                .map(|p| p.name)
                .unwrap_or_default();
            conflict_items.push(HealthItem {
                label: name,
                status: "warning",
                detail: if s.phase == "lost" {
                    "The session's connection was lost; it reconnects by itself.".into()
                } else {
                    "The handoff is waiting for a decision.".into()
                },
                checked_at: Some(s.updated_at.clone()),
            });
        }
        cards.push({
            let status = worst(conflict_items.iter().map(|i| i.status));
            let summary = if conflict_items.is_empty() {
                "No conflicts or sessions waiting for a decision.".into()
            } else {
                format!("{} need a decision.", conflict_items.len())
            };
            computed(
                if conflict_items.is_empty() {
                    "ok"
                } else {
                    status
                },
                "Sync conflicts",
                "conflicts",
                summary,
                (!conflict_items.is_empty()).then_some("open_sessions"),
                conflict_items,
            )
        });

        // Disk.
        let free = fs4::available_space(&self.paths.data).ok();
        cards.push(match free {
            None => computed(
                "unknown",
                "Disk space",
                "disk",
                "Free space could not be read.".into(),
                None,
                vec![],
            ),
            Some(f) => {
                let gib = f as f64 / (1024.0 * 1024.0 * 1024.0);
                let (status, summary) = if f < MIN_FREE_BYTES {
                    (
                        "problem",
                        format!("{gib:.1} GB free: profiles cannot open until more space is free."),
                    )
                } else if f < 5 * MIN_FREE_BYTES {
                    (
                        "warning",
                        format!("{gib:.1} GB free: backups may be skipped soon."),
                    )
                } else {
                    ("ok", format!("{gib:.0} GB free."))
                };
                computed(status, "Disk space", "disk", summary, None, vec![])
            }
        });

        // Active locks: profiles open here and shared sessions this computer holds.
        let running = self.supervisor.running_count();
        let held = team
            .iter()
            .filter(|s| {
                matches!(
                    s.phase.as_str(),
                    "opening" | "running" | "closing" | "handing_off"
                )
            })
            .count();
        cards.push(computed(
            "ok",
            "Open profiles and sessions",
            "locks",
            format!(
                "{running} open on this computer; {held} shared sessions held by this computer."
            ),
            (running > 0).then_some("open_resources"),
            vec![],
        ));

        // Extensions.
        let view = self.extensions_view(None)?;
        let mut ext_items = vec![];
        for p in &view.profiles {
            if p.scan_status.as_deref() == Some("unreadable") {
                ext_items.push(HealthItem {
                    label: p.name.clone(),
                    status: "warning",
                    detail: "The browser's settings file could not be read; the list may be out of date.".into(),
                    checked_at: p.scanned_at.clone(),
                });
            }
            if p.needs_attention > 0 {
                ext_items.push(HealthItem {
                    label: p.name.clone(),
                    status: if p.will_disable { "problem" } else { "warning" },
                    detail: if p.will_disable {
                        format!(
                            "{} not approved: extensions will be off at the next open.",
                            p.needs_attention
                        )
                    } else if p.mode == "local" {
                        format!(
                            "{} updated and asks for more access: review.",
                            p.needs_attention
                        )
                    } else {
                        format!("{} not approved by your organization.", p.needs_attention)
                    },
                    checked_at: p.scanned_at.clone(),
                });
            }
        }
        cards.push(computed(
            if ext_items.is_empty() {
                "ok"
            } else {
                worst(ext_items.iter().map(|i| i.status))
            },
            "Extensions",
            "extensions",
            if ext_items.is_empty() {
                format!(
                    "{} extensions in {} profiles; nothing waiting for review.",
                    view.profiles
                        .iter()
                        .map(|p| p.extensions.len())
                        .sum::<usize>(),
                    view.profiles.len()
                )
            } else {
                format!("{} profiles need attention.", ext_items.len())
            },
            Some("open_extensions"),
            ext_items,
        ));

        // Memory.
        let (total, available) = Self::system_memory();
        let estimate = self.memory_estimate(&store);
        let fits =
            available.saturating_sub(MEMORY_RESERVE_BYTES) / estimate.per_profile_bytes.max(1);
        let gib = |b: u64| b as f64 / (1024.0 * 1024.0 * 1024.0);
        cards.push(computed(
            if available < MEMORY_RESERVE_BYTES + estimate.per_profile_bytes { "warning" } else { "ok" },
            "Memory",
            "memory",
            format!(
                "{:.1} of {:.1} GB available: room for about {fits} more profiles ({} estimate; real use depends on the sites).",
                gib(available),
                gib(total),
                if estimate.source == "measured" { "measured" } else { "default" }
            ),
            Some("open_resources"),
            vec![],
        ));

        Ok(HealthView {
            generated_at: now,
            cards,
        })
    }

    // ------------------------------------------------------------------------- diagnostics
    /// The diagnostics report before redaction (sections chosen to leave out personal and secret data).
    fn diagnostics_report(&self) -> Value {
        let mut report = self.diagnostics();
        let store = self.store().ok();
        let ops: Vec<Value> = self
            .ops
            .list()
            .into_iter()
            .rev()
            .take(100)
            .map(|o| serde_json::to_value(o).unwrap_or(Value::Null))
            .collect();
        let runs: Vec<Value> = store
            .as_ref()
            .and_then(|s| s.list_audit(None, 200).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|a| json!({ "at": a.at, "profile_id": a.profile_id, "action": a.action, "outcome": a.outcome,
                             "detail": a.detail }))
            .collect();
        let failures = store
            .as_ref()
            .and_then(|s| s.list_audit(None, 1000).ok())
            .unwrap_or_default();
        let error_codes = diagnostics::summarize_codes(
            failures
                .iter()
                .filter(|a| {
                    !matches!(
                        a.outcome.as_str(),
                        "ok" | "clean" | "success" | "started" | "stopped"
                    )
                })
                .map(|a| a.outcome.as_str()),
        );
        let health = self.health().ok().map(|h| {
            h.cards
                .into_iter()
                .map(|c| {
                    json!({ "id": c.id, "status": c.status, "checked_at": c.checked_at,
                                 "valid_until": c.valid_until })
                })
                .collect::<Vec<_>>()
        });
        let extensions = store
            .as_ref()
            .and_then(|s| s.list_extensions(None).ok())
            .map(|list| {
                list.into_iter()
                    .map(|e| {
                        json!({ "profile_id": e.profile_id, "id": e.id, "version": e.version,
                                 "source": e.source, "enabled": e.enabled,
                                 "pending_review": !e.added_sensitive.is_empty() })
                    })
                    .collect::<Vec<_>>()
            });
        let resources = self.supervisor.resource_usage();
        let settings: Vec<Value> = store
            .as_ref()
            .and_then(|s| s.get_settings().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|v| json!({ "key": v.key, "value": v.value }))
            .collect();
        if let Value::Object(map) = &mut report {
            map.insert("generated_at".into(), json!(now_iso()));
            map.insert("operations".into(), json!(ops));
            map.insert("recent_activity".into(), json!(runs));
            map.insert("error_summary".into(), json!(error_codes));
            map.insert("health".into(), json!(health));
            map.insert("extensions".into(), json!(extensions));
            map.insert(
                "resources".into(),
                json!({ "manager_memory_bytes": resources.manager_memory_bytes,
                        "manager_processes": resources.manager_processes,
                        "profiles": resources.profiles.iter().map(|p| json!({
                            "profile_id": p.profile_id.as_str(), "processes": p.processes,
                            "memory_bytes": p.memory_bytes, "open_seconds": p.open_seconds })).collect::<Vec<_>>() }),
            );
            map.insert("settings".into(), json!(settings));
            map.insert("platform".into(), json!(platform()));
        }
        report
    }

    /// Builds, redacts and size-limits the report, and keeps it for [`diagnostics::PREVIEW_TTL`] so exactly this text
    /// can be saved.
    pub fn preview_diagnostics(&self) -> Result<Preview, IpcError> {
        let mut report = self.diagnostics_report();
        let mut counts = Redactions::default();
        Redactor::for_this_computer().scrub_value(&mut report, &mut counts);
        let (text, truncated) = diagnostics::fit(report, diagnostics::MAX_REPORT_BYTES);
        let preview = Preview {
            preview_id: format!(
                "diag_{}",
                pb_runtime::random_hex(8).map_err(|_| ipc::INTERNAL)?
            ),
            bytes: text.len(),
            text,
            limit_bytes: diagnostics::MAX_REPORT_BYTES,
            truncated,
            redactions: counts,
            expires_in_seconds: diagnostics::PREVIEW_TTL.as_secs(),
        };
        self.agency.previews.put(preview.clone());
        Ok(preview)
    }

    /// Writes a previewed report to the chosen file (the preview is then forgotten).
    pub fn save_diagnostics(&self, preview_id: &str, path: &Path) -> Result<(), IpcError> {
        let preview = self
            .agency
            .previews
            .get(preview_id)
            .ok_or(ipc::PREVIEW_EXPIRED)?;
        std::fs::write(path, preview.text.as_bytes()).map_err(|_| ipc::INVALID_DIRECTORY)?;
        self.agency.previews.remove(preview_id);
        if let Ok(store) = self.store() {
            let _ = store.audit(
                None,
                "diagnostics",
                "exported",
                None,
                Some(&format!("{} bytes", preview.bytes)),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_timestamps_round_trip() {
        for (iso, unix) in [
            ("1970-01-01T00:00:00.000Z", 0),
            ("2026-10-14T00:39:26.000Z", 1_791_938_366),
            ("2000-02-29T12:00:00.000Z", 951_825_600),
        ] {
            assert_eq!(unix_from_iso(iso), Some(unix), "{iso}");
            assert_eq!(iso_from_unix(unix, 0), iso);
        }
        assert_eq!(unix_from_iso("2026-10-14 00:39:26+00"), Some(1_791_938_366));
        assert_eq!(unix_from_iso("yesterday"), None);
    }

    #[test]
    fn client_folder_names_cannot_leave_the_downloads_folder() {
        for (label, expected) in [
            ("Client North", "Client North"),
            ("../../etc", "_.._etc"),
            ("..", "Client"),
            (".", "Client"),
            ("a/b\\c", "a_b_c"),
            ("C:\\Windows", "C__Windows"),
            ("  Acme\u{202e} Shop.  ", "Acme Shop"),
            ("con", "con_"),
            ("LPT1.txt", "LPT1.txt_"),
            ("what?*<>|\"", "what______"),
            ("", "Client"),
            ("///", "Client"),
        ] {
            assert_eq!(folder_name(label), expected, "{label:?}");
        }
        assert_eq!(folder_name(&"x".repeat(200)).chars().count(), 64);
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        for label in ["../escape", "..", "/abs", "nested/dir"] {
            let dir = client_subfolder(tmp.path(), label).unwrap_or_else(|| panic!("{label}"));
            assert_eq!(dir.parent(), Some(tmp.path()), "{label}");
        }
    }
}
