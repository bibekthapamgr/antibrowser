//! An in-memory control plane and object store with the real API's rules (leases and fencing, idempotent init,
//! version compare-and-swap, server-side verification of size, header and SHA-256) and fault injection: any call can
//! fail before it reaches the server or after the server applied it (the answer is lost), which is how the tests
//! "kill the network" at every step. Used by this crate's tests and by the desktop's tests (feature `testing`).
//!
//! Milestone 08: session leases on a controllable clock (TTL, heartbeat, uncertain sessions, revival), release with
//! handoff notes, access requests, forced takeover, revocation and recovery copies, with the same rules as the API.

use crate::api::{
    ApiError, Beat, CommitRequest, HandoffNote, HandoffRequest, Holder, InitRequest, InitResult,
    LeaseInfo, ObjectError, Objects, OpenRequest, Operation, PartUrl, RestorePlan, SessionApi,
    SessionOpened, SessionOutcome, SnapshotInfo, StoredPart, SyncApi,
};
use pb_seal::{Kind, SealKey};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// The request never reaches the server.
    Before,
    /// The server applies the request, then the answer is lost.
    After,
}

#[derive(Clone, Debug)]
struct Snap {
    org: String,
    profile: String,
    base: i64,
    state: &'static str,
    error: Option<String>,
    fencing: u64,
    device: String,
    key: [u8; 32],
    key_version: String,
    version: Option<i64>,
    digest: Option<String>,
    size: u64,
    plaintext: u64,
    platform: String,
    browser: String,
    op_id: String,
    init_key: String,
    init_digest: String,
    parts: BTreeMap<u32, Vec<u8>>,
    /// A recovery copy (milestone 08): verified, kept, never the head.
    recovery: bool,
}

/// The profile's current lease (one per profile, like the API's `profile_leases`).
#[derive(Clone, Debug)]
struct Lease {
    id: String,
    fencing: u64,
    device: String,
    purpose: &'static str,
    /// active, released, taken_over, revoked, superseded.
    state: &'static str,
    /// Clock time (ms) after which an active lease is expired (a session then is uncertain).
    expires: u64,
    ttl_ms: u64,
    run_state: Option<String>,
    acquired: u64,
    heartbeat: Option<u64>,
    note: Option<(String, String)>,
}

impl Lease {
    fn live(&self, now: u64) -> bool {
        self.state == "active" && self.expires > now
    }
}

#[derive(Clone, Debug)]
struct Hist {
    profile: String,
    fencing: u64,
    device: String,
    purpose: &'static str,
    end: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct Req {
    id: String,
    profile: String,
    from: String,
    note: String,
    status: &'static str,
}

/// A lease as tests see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseView {
    pub id: String,
    pub device: String,
    pub purpose: &'static str,
    /// active, uncertain, released, taken_over, revoked, superseded.
    pub state: &'static str,
    pub fencing: u64,
    pub run_state: Option<String>,
    pub note: Option<String>,
}

/// Lease timings (the API's SESSION_LEASE).
pub const SESSION_TTL_MS: u64 = 60_000;
pub const UPLOAD_TTL_MS: u64 = 600_000;

#[derive(Default)]
struct State {
    /// profile id → (org id, head version, head snapshot)
    profiles: HashMap<String, (String, i64, Option<String>)>,
    leases: HashMap<String, Lease>,
    lease_keys: HashMap<String, u64>,
    session_keys: HashMap<String, SessionOpened>,
    history: HashMap<String, Hist>,
    requests: Vec<Req>,
    /// Devices whose access was removed (membership, grant or the device itself): everything is "not found".
    revoked: HashSet<String>,
    /// Capabilities per device (default: all three).
    capabilities: HashMap<String, Vec<String>>,
    /// The server's clock (ms); tests move it with [`FakeServer::advance`].
    clock: u64,
    next_fencing: u64,
    snaps: HashMap<String, Snap>,
    objects: HashMap<String, Vec<u8>>,
    /// signed URL token → (snapshot, part number or 0 for the whole object)
    urls: HashMap<String, (String, u32)>,
    seq: u64,
    faults: Vec<(&'static str, When)>,
    calls: Vec<&'static str>,
    // Milestone 10: automation jobs, enrolled computers and screenshots.
    jobs: Vec<FakeJob>,
    agents: HashMap<String, (String, String, u32)>,
    artifacts: HashMap<String, (String, u32, Vec<u8>)>,
    reports: Vec<String>,
}

/// An automation job as the fake server keeps it (milestone 10).
#[derive(Clone, Debug, PartialEq)]
pub struct FakeJob {
    pub id: String,
    pub org: String,
    pub profile: String,
    /// QUEUED, CLAIMED, RUNNING, SUCCEEDED, FAILED, CANCELED
    pub state: &'static str,
    pub attempt: u32,
    pub agent: Option<String>,
    pub steps: Vec<FakeStep>,
    pub allowed: Vec<String>,
    pub cancel: bool,
    pub lease: Option<(String, String)>,
    pub debug_sha: Option<String>,
    pub keep_open: Option<u32>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FakeStep {
    pub seq: u32,
    pub action: String,
    pub input: serde_json::Value,
    pub state: String,
    pub attempt: u32,
    pub output: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub struct FakeServer {
    state: Mutex<State>,
    pub part_size: u64,
    pub key_version: String,
    /// When false, operations stay `verifying` until [`FakeServer::verify_all`] runs (a slow worker).
    pub auto_verify: AtomicBool,
    /// Calls that wait until [`FakeServer::release_held`] (a slow network; at most 10 s).
    held: Mutex<HashSet<&'static str>>,
    held_cv: Condvar,
}

fn ulid_like(prefix: &str, n: u64) -> String {
    format!(
        "{prefix}_{:0>26}",
        format!("{n:X}").replace(['I', 'L', 'O', 'U'], "0")
    )
}

impl FakeServer {
    pub fn new(part_size: u64) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                next_fencing: 100,
                clock: 1_000_000,
                ..State::default()
            }),
            part_size,
            key_version: ulid_like("okv", 1),
            auto_verify: AtomicBool::new(true),
            held: Mutex::new(HashSet::new()),
            held_cv: Condvar::new(),
        })
    }

    /// Calls named `call` wait (up to 10 s) until [`FakeServer::release_held`].
    pub fn hold(&self, call: &'static str) {
        if let Ok(mut h) = self.held.lock() {
            h.insert(call);
        }
    }

    pub fn release_held(&self) {
        if let Ok(mut h) = self.held.lock() {
            h.clear();
            self.held_cv.notify_all();
        }
    }

    fn wait_if_held(&self, call: &'static str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let Ok(mut h) = self.held.lock() else { return };
        while h.contains(call) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            h = match self.held_cv.wait_timeout(h, left) {
                Ok((g, _)) => g,
                Err(_) => return,
            };
        }
    }

    fn st(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn add_profile(&self, org: &str, profile: &str) {
        self.st()
            .profiles
            .insert(profile.to_owned(), (org.to_owned(), 0, None));
    }

    /// The next call named `call` fails `when`.
    pub fn fail(&self, call: &'static str, when: When) {
        self.st().faults.push((call, when));
    }

    pub fn calls(&self) -> Vec<&'static str> {
        self.st().calls.clone()
    }

    pub fn head(&self, profile: &str) -> (i64, Option<String>) {
        self.st()
            .profiles
            .get(profile)
            .map(|p| (p.1, p.2.clone()))
            .unwrap_or((0, None))
    }

    /// Committed snapshots of a profile (oldest first).
    pub fn committed(&self, profile: &str) -> Vec<(i64, String)> {
        let st = self.st();
        let mut v: Vec<(i64, String)> = st
            .snaps
            .iter()
            .filter(|(_, s)| s.profile == profile && s.state == "committed")
            .map(|(id, s)| (s.version.unwrap_or(0), id.clone()))
            .collect();
        v.sort();
        v
    }

    pub fn snapshot_state(&self, snapshot: &str) -> Option<(&'static str, Option<String>)> {
        self.st()
            .snaps
            .get(snapshot)
            .map(|s| (s.state, s.error.clone()))
    }

    /// Ends a lease's time as if its heartbeats stopped: an upload lease is free again, a session lease becomes
    /// uncertain (nobody else may open the profile until its device revives or releases it).
    pub fn expire_lease(&self, profile: &str) {
        let mut st = self.st();
        let now = st.clock;
        if let Some(l) = st.leases.get_mut(profile) {
            l.expires = now;
        }
    }

    /// Moves the server's clock forward.
    pub fn advance(&self, ms: u64) {
        self.st().clock += ms;
    }

    pub fn lease_holder(&self, profile: &str) -> Option<String> {
        let st = self.st();
        st.leases
            .get(profile)
            .filter(|l| l.live(st.clock))
            .map(|l| l.device.clone())
    }

    pub fn lease(&self, profile: &str) -> Option<LeaseView> {
        let st = self.st();
        let l = st.leases.get(profile)?;
        Some(LeaseView {
            id: l.id.clone(),
            device: l.device.clone(),
            purpose: l.purpose,
            state: if l.state == "active" && !l.live(st.clock) {
                "uncertain"
            } else {
                l.state
            },
            fencing: l.fencing,
            run_state: l.run_state.clone(),
            note: l.note.as_ref().map(|n| n.0.clone()),
        })
    }

    /// An administrator's forced takeover: the lease ends with a new token (the holder is fenced out).
    pub fn take_over(&self, profile: &str) -> bool {
        end_lease(&mut self.st(), profile, "taken_over")
    }

    /// Access removed for a device (membership, grant or the device signed out): its leases end, and every call it
    /// makes is "not found" from now on.
    pub fn revoke_access(&self, device: &str) {
        let mut st = self.st();
        st.revoked.insert(device.to_owned());
        let profiles: Vec<String> = st
            .leases
            .iter()
            .filter(|(_, l)| l.device == device && l.state == "active")
            .map(|(p, _)| p.clone())
            .collect();
        for p in profiles {
            end_lease(&mut st, &p, "revoked");
        }
    }

    /// What the person on `device` may do (launch, edit, backup_download); default: everything.
    pub fn set_capabilities(&self, device: &str, capabilities: &[&str]) {
        self.st().capabilities.insert(
            device.to_owned(),
            capabilities.iter().map(|c| (*c).to_owned()).collect(),
        );
    }

    /// A teammate on `from` asks the holder for the profile; returns the request id.
    pub fn request_handoff(&self, profile: &str, from: &str, note: &str) -> String {
        let mut st = self.st();
        st.seq += 1;
        let id = ulid_like("hrq", st.seq);
        st.requests.push(Req {
            id: id.clone(),
            profile: profile.to_owned(),
            from: from.to_owned(),
            note: note.to_owned(),
            status: "open",
        });
        id
    }

    /// (request id, status) of a profile's requests, oldest first.
    pub fn requests(&self, profile: &str) -> Vec<(String, &'static str)> {
        self.st()
            .requests
            .iter()
            .filter(|r| r.profile == profile)
            .map(|r| (r.id.clone(), r.status))
            .collect()
    }

    /// Recovery copies kept for a profile.
    pub fn recovery_copies(&self, profile: &str) -> Vec<String> {
        self.st()
            .snaps
            .iter()
            .filter(|(_, s)| s.profile == profile && s.state == "kept")
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Makes every signed URL issued so far expire.
    pub fn expire_urls(&self) {
        self.st().urls.clear();
    }

    pub fn object(&self, snapshot: &str) -> Option<Vec<u8>> {
        self.st().objects.get(snapshot).cloned()
    }

    /// Replaces a stored object (substitution attack or storage corruption).
    pub fn replace_object(&self, snapshot: &str, bytes: Vec<u8>) {
        self.st().objects.insert(snapshot.to_owned(), bytes);
    }

    /// Changes a manifest's recorded digest and size (manifest tampering).
    pub fn set_manifest(&self, snapshot: &str, digest: &str, size: u64) {
        if let Some(s) = self.st().snaps.get_mut(snapshot) {
            s.digest = Some(digest.to_owned());
            s.size = size;
        }
    }

    /// Runs the verification worker over every operation waiting for it.
    pub fn verify_all(&self) {
        let mut st = self.st();
        let ids: Vec<String> = st
            .snaps
            .iter()
            .filter(|(_, s)| s.state == "verifying")
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            verify(&mut st, &id);
        }
    }

    /// A client for one device of one user, with access to `orgs`.
    // ------------------------------------------------------------------------------------- automation (10)
    /// Queues a job: open the profile, `steps` (API step objects), optional debugging and holding, close.
    pub fn add_job(
        &self,
        org: &str,
        profile: &str,
        steps: Vec<serde_json::Value>,
        keep_open: Option<u32>,
        debug_sha: Option<&str>,
        allowed: &[&str],
    ) -> String {
        let mut st = self.st();
        st.seq += 1;
        let id = ulid_like("job", st.seq);
        let mut all = vec![("open_profile".to_owned(), serde_json::json!({}))];
        for s in steps {
            let action = s
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_owned();
            all.push((action, s));
        }
        if debug_sha.is_some() {
            all.push(("debug_bridge".into(), serde_json::json!({})));
        }
        if keep_open.is_some() {
            all.push(("hold_open".into(), serde_json::json!({})));
        }
        all.push(("close_profile".into(), serde_json::json!({})));
        let steps = all
            .into_iter()
            .enumerate()
            .map(|(i, (action, input))| FakeStep {
                seq: i as u32,
                action,
                input,
                state: "pending".into(),
                attempt: 0,
                output: None,
                error: None,
            })
            .collect();
        st.jobs.push(FakeJob {
            id: id.clone(),
            org: org.to_owned(),
            profile: profile.to_owned(),
            state: "QUEUED",
            attempt: 0,
            agent: None,
            steps,
            allowed: allowed.iter().map(|a| (*a).to_owned()).collect(),
            cancel: false,
            lease: None,
            debug_sha: debug_sha.map(str::to_owned),
            keep_open,
            error: None,
        });
        id
    }

    pub fn job(&self, id: &str) -> Option<FakeJob> {
        self.st().jobs.iter().find(|j| j.id == id).cloned()
    }

    /// Like the API's cancel: a queued or claimed job ends now, a running one is asked to stop.
    pub fn cancel_job(&self, id: &str) {
        let mut st = self.st();
        if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
            if matches!(j.state, "QUEUED" | "CLAIMED") {
                j.state = "CANCELED";
                j.error = Some("CANCELED".into());
            } else if j.state == "RUNNING" {
                j.cancel = true;
            }
        }
    }

    /// The claim was not started in time (the sweeper): back to the queue.
    pub fn requeue(&self, id: &str) {
        let mut st = self.st();
        if let Some(j) = st
            .jobs
            .iter_mut()
            .find(|j| j.id == id && j.state == "CLAIMED")
        {
            j.state = "QUEUED";
            j.agent = None;
        }
    }

    /// Enrolled computers (agent ids).
    pub fn agents(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.st().agents.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// An admin removed the computer in the organization (its claims return to the queue).
    pub fn drop_agent(&self, id: &str) {
        let mut st = self.st();
        st.agents.remove(id);
        for j in st.jobs.iter_mut() {
            if j.agent.as_deref() == Some(id) && matches!(j.state, "CLAIMED" | "RUNNING") {
                j.state = if j.state == "CLAIMED" {
                    "QUEUED"
                } else {
                    "FAILED"
                };
                j.agent = None;
            }
        }
    }

    pub fn artifact(&self, id: &str) -> Option<Vec<u8>> {
        self.st().artifacts.get(id).map(|a| a.2.clone())
    }

    /// Report types received, in order (`started`, `step_started:3`, …).
    pub fn reports(&self) -> Vec<String> {
        self.st().reports.clone()
    }

    pub fn client(self: &Arc<Self>, device: &str, orgs: &[&str]) -> FakeClient {
        FakeClient {
            server: self.clone(),
            device: device.to_owned(),
            orgs: orgs.iter().map(|o| (*o).to_owned()).collect(),
        }
    }
}

fn verify(st: &mut State, id: &str) {
    let Some(s) = st.snaps.get(id).cloned() else {
        return;
    };
    let fail = |st: &mut State, code: &str| {
        if let Some(s) = st.snaps.get_mut(id) {
            s.state = "failed";
            s.error = Some(code.to_owned());
        }
        st.objects.remove(id);
    };
    let Some(bytes) = st.objects.get(id).cloned() else {
        return fail(st, "OBJECT_MISSING");
    };
    if bytes.len() as u64 != s.size {
        return fail(st, "SIZE_MISMATCH");
    }
    let header = match pb_seal::format::read_header(&mut &bytes[..]) {
        Ok((h, _)) => h,
        Err(_) => return fail(st, "HEADER_INVALID"),
    };
    if header.kind != Kind::OrgSnapshot
        || header.org_id.as_deref() != Some(s.org.as_str())
        || header.profile_id != s.profile
        || header.object_id != id
        || header.key_version != s.key_version
        || header.schema_version != 1
    {
        return fail(st, "HEADER_MISMATCH");
    }
    let digest = pb_seal::format::digest_reader(&bytes[..])
        .map(|d| d.0)
        .unwrap_or_default();
    if Some(digest) != s.digest {
        return fail(st, "DIGEST_MISMATCH");
    }
    if s.recovery {
        if let Some(s) = st.snaps.get_mut(id) {
            s.state = "kept";
        }
        return;
    }
    let now = st.clock;
    let lease_ok = st
        .leases
        .get(&s.profile)
        .is_some_and(|l| l.state == "active" && l.fencing == s.fencing && l.expires > now);
    if !lease_ok {
        return fail(st, "FENCING_TOKEN_STALE");
    }
    let Some(p) = st.profiles.get_mut(&s.profile) else {
        return fail(st, "NOT_FOUND");
    };
    if p.1 != s.base {
        return fail(st, "VERSION_CONFLICT");
    }
    p.1 += 1;
    p.2 = Some(id.to_owned());
    let version = p.1;
    if let Some(s) = st.snaps.get_mut(id) {
        s.state = "committed";
        s.version = Some(version);
    }
}

/// Ends the profile's open lease by someone else (takeover, revocation): a new token fences the holder out.
fn end_lease(st: &mut State, profile: &str, state: &'static str) -> bool {
    st.next_fencing += 1;
    let next = st.next_fencing;
    let Some(l) = st.leases.get_mut(profile).filter(|l| l.state == "active") else {
        return false;
    };
    l.state = state;
    l.fencing = next;
    let id = l.id.clone();
    if let Some(h) = st.history.get_mut(&id) {
        h.end = Some(state);
    }
    for r in st.requests.iter_mut() {
        if r.profile == profile && r.status == "open" {
            r.status = "fulfilled";
        }
    }
    true
}

fn info_of_lease(profile: &str, l: &Lease, now: u64) -> LeaseInfo {
    LeaseInfo {
        id: l.id.clone(),
        profile_id: profile.to_owned(),
        purpose: l.purpose.to_owned(),
        state: if l.state == "active" && l.expires <= now {
            "uncertain".into()
        } else {
            l.state.into()
        },
        holder_user_id: format!("usr_{}", l.device.trim_start_matches("dev_")),
        holder_name: format!("Person on {}", l.device),
        device_id: l.device.clone(),
        device_name: l.device.clone(),
        fencing_token: l.fencing.to_string(),
        run_state: l.run_state.clone(),
        acquired_at: l.acquired.to_string(),
        expires_at: l.expires.to_string(),
        heartbeat_at: l.heartbeat.map(|h| h.to_string()),
        ttl_seconds: (l.ttl_ms / 1000) as u32,
        heartbeat_seconds: 15,
    }
}

fn code(status: u16, c: &str) -> ApiError {
    ApiError::Code {
        status,
        code: c.to_owned(),
    }
}

pub struct FakeClient {
    pub server: Arc<FakeServer>,
    pub device: String,
    orgs: Vec<String>,
}

impl FakeClient {
    fn enter(&self, call: &'static str) -> Result<MutexGuard<'_, State>, ApiError> {
        self.server.wait_if_held(call);
        let mut st = self.server.st();
        st.calls.push(call);
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == call && *w == When::Before)
        {
            st.faults.remove(i);
            return Err(ApiError::Offline);
        }
        Ok(st)
    }

    fn leave(st: &mut State, call: &'static str) -> Result<(), ApiError> {
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == call && *w == When::After)
        {
            st.faults.remove(i);
            return Err(ApiError::Offline);
        }
        Ok(())
    }

    /// Tenant check: a profile of another organization (or one this device lost access to) is "not found".
    fn profile(&self, st: &State, org: &str, profile: &str) -> Result<(), ApiError> {
        if st.revoked.contains(&self.device) {
            return Err(code(404, "NOT_FOUND"));
        }
        match st.profiles.get(profile) {
            Some((o, _, _)) if o == org && self.orgs.iter().any(|x| x == org) => Ok(()),
            _ => Err(code(404, "NOT_FOUND")),
        }
    }

    /// A fenced write: this device's live lease with this token. A newer token (takeover, revocation, another
    /// holder) is `Fenced`; an expired or missing lease is `LeaseLost`.
    fn require_lease(&self, st: &State, profile: &str, fencing: &str) -> Result<(), ApiError> {
        let Some(l) = st.leases.get(profile) else {
            return Err(ApiError::LeaseLost);
        };
        let token: u64 = fencing.parse().unwrap_or(0);
        if l.fencing != token {
            if l.fencing > token {
                return Err(ApiError::Fenced {
                    state: if l.state == "active" {
                        "superseded"
                    } else {
                        l.state
                    }
                    .into(),
                });
            }
            return Err(ApiError::LeaseLost);
        }
        if l.state != "active" {
            return Err(ApiError::Fenced {
                state: l.state.into(),
            });
        }
        if l.device != self.device || l.expires <= st.clock {
            return Err(ApiError::LeaseLost);
        }
        Ok(())
    }

    /// Takes the profile's lease for this device (the API's rules: LEASE_HELD while another device holds it,
    /// uncertain sessions block others, the same device replaces its own lease). Returns the lease and the note
    /// left by the previous holder.
    fn take(
        &self,
        st: &mut State,
        profile: &str,
        purpose: &'static str,
        ttl_ms: u64,
    ) -> Result<(Lease, Option<(String, String)>), ApiError> {
        let now = st.clock;
        let mut note = None;
        if let Some(cur) = st.leases.get(profile).cloned() {
            if cur.state == "active" {
                let holder = Holder {
                    holder_name: format!("Person on {}", cur.device),
                    device_name: cur.device.clone(),
                    since: Some(cur.acquired.to_string()),
                    uncertain: false,
                };
                if cur.device != self.device {
                    if cur.live(now) {
                        return Err(ApiError::LeaseHeld(holder));
                    }
                    if cur.purpose == "session" {
                        return Err(ApiError::LeaseHeld(Holder {
                            uncertain: true,
                            ..holder
                        }));
                    }
                } else if cur.purpose == "session" && purpose == "upload" {
                    return Err(ApiError::LeaseHeld(holder));
                }
                if let Some(h) = st.history.get_mut(&cur.id) {
                    h.end.get_or_insert("superseded");
                }
            } else if cur.state == "released" {
                note = cur.note.clone();
            }
        }
        st.next_fencing += 1;
        st.seq += 1;
        let lease = Lease {
            id: ulid_like("lse", st.seq),
            fencing: st.next_fencing,
            device: self.device.clone(),
            purpose,
            state: "active",
            expires: now + ttl_ms,
            ttl_ms,
            run_state: (purpose == "session").then(|| "starting".to_owned()),
            acquired: now,
            heartbeat: None,
            note: None,
        };
        st.history.insert(
            lease.id.clone(),
            Hist {
                profile: profile.to_owned(),
                fencing: lease.fencing,
                device: self.device.clone(),
                purpose,
                end: None,
            },
        );
        st.leases.insert(profile.to_owned(), lease.clone());
        Ok((lease, note))
    }

    /// This device's lease `lease` with `fencing`, or why it is not theirs any more.
    fn own_lease<'s>(
        &self,
        st: &'s mut State,
        profile: &str,
        lease: &str,
        fencing: &str,
    ) -> Result<&'s mut Lease, ApiError> {
        let current = st.leases.get(profile).map(|l| l.id.clone());
        if current.as_deref() != Some(lease) {
            return match st.history.get(lease) {
                Some(h) if h.device == self.device && h.profile == profile => {
                    Err(ApiError::Fenced {
                        state: h.end.unwrap_or("superseded").into(),
                    })
                }
                _ => Err(code(404, "NOT_FOUND")),
            };
        }
        let l = st
            .leases
            .get_mut(profile)
            .ok_or_else(|| code(404, "NOT_FOUND"))?;
        if l.device != self.device {
            return Err(ApiError::LeaseLost);
        }
        if l.fencing.to_string() != fencing {
            return Err(ApiError::Fenced {
                state: if l.state == "active" {
                    "superseded"
                } else {
                    l.state
                }
                .into(),
            });
        }
        Ok(l)
    }

    fn own_snap<'s>(
        &self,
        st: &'s mut State,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<&'s mut Snap, ApiError> {
        match st.snaps.get_mut(snapshot) {
            Some(s) if s.org == org && s.profile == profile && s.device == self.device => Ok(s),
            _ => Err(code(404, "NOT_FOUND")),
        }
    }

    fn token(st: &mut State, snapshot: &str, part: u32) -> String {
        st.seq += 1;
        let t = format!("t{}", st.seq);
        st.urls.insert(t.clone(), (snapshot.to_owned(), part));
        format!("fake://storage/{t}")
    }
}

impl SyncApi for FakeClient {
    fn acquire_lease(&self, org: &str, profile: &str, key: &str) -> Result<String, ApiError> {
        let mut st = self.enter("acquire_lease")?;
        self.profile(&st, org, profile)?;
        let replay_key = format!("{org}/{key}");
        if let Some(f) = st.lease_keys.get(&replay_key) {
            let f = *f;
            Self::leave(&mut st, "acquire_lease")?;
            return Ok(f.to_string());
        }
        let (lease, _) = self.take(&mut st, profile, "upload", UPLOAD_TTL_MS)?;
        let fencing = lease.fencing;
        st.lease_keys.insert(replay_key, fencing);
        Self::leave(&mut st, "acquire_lease")?;
        Ok(fencing.to_string())
    }

    fn renew_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        let mut st = self.enter("renew_lease")?;
        self.profile(&st, org, profile)?;
        self.require_lease(&st, profile, fencing)?;
        let now = st.clock;
        if let Some(l) = st.leases.get_mut(profile) {
            l.expires = now + l.ttl_ms;
        }
        Self::leave(&mut st, "renew_lease")
    }

    fn release_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        let mut st = self.enter("release_lease")?;
        self.profile(&st, org, profile)?;
        if let Some(l) = st.leases.get_mut(profile)
            && l.fencing.to_string() == fencing
            && l.device == self.device
            && l.state == "active"
        {
            l.state = "released";
            l.run_state = None;
            let id = l.id.clone();
            if let Some(h) = st.history.get_mut(&id) {
                h.end = Some("released");
            }
        }
        Self::leave(&mut st, "release_lease")
    }

    fn init(
        &self,
        org: &str,
        profile: &str,
        key: &str,
        req: &InitRequest,
    ) -> Result<InitResult, ApiError> {
        let mut st = self.enter("init")?;
        self.profile(&st, org, profile)?;
        let digest = format!(
            "{}|{}|{}|{}|{}|{}",
            profile,
            req.base_version,
            req.fencing_token,
            req.platform,
            req.browser_version,
            req.recovery
        );
        let replay = st
            .snaps
            .iter()
            .find(|(_, s)| s.org == org && s.init_key == key)
            .map(|(id, s)| (id.clone(), s.clone()));
        let (id, snap) = if let Some((id, s)) = replay {
            if s.init_digest != digest {
                return Err(code(409, "IDEMPOTENCY_KEY_REUSED"));
            }
            (id, s)
        } else {
            if req.recovery {
                // A session lease this device held and lost (not the current one).
                let token: u64 = req.fencing_token.parse().unwrap_or(0);
                let held = st.history.values().any(|h| {
                    h.profile == profile
                        && h.fencing == token
                        && h.device == self.device
                        && h.purpose == "session"
                });
                let current = st
                    .leases
                    .get(profile)
                    .is_some_and(|l| l.fencing == token && l.state == "active");
                if !held {
                    return Err(ApiError::LeaseLost);
                }
                if current {
                    return Err(code(400, "VALIDATION_FAILED"));
                }
            } else {
                self.require_lease(&st, profile, &req.fencing_token)?;
                let head = st.profiles.get(profile).map(|p| p.1).unwrap_or(0);
                if head != req.base_version {
                    return Err(ApiError::Conflict { head_version: head });
                }
            }
            st.seq += 1;
            let id = ulid_like("snp", st.seq);
            let op_id = ulid_like("syn", st.seq);
            let key_bytes = {
                let mut k = [0u8; 32];
                getrandom::fill(&mut k).map_err(|_| code(500, "INTERNAL"))?;
                k
            };
            let s = Snap {
                org: org.to_owned(),
                profile: profile.to_owned(),
                base: req.base_version,
                state: "uploading",
                error: None,
                fencing: req.fencing_token.parse().unwrap_or(0),
                device: self.device.clone(),
                key: key_bytes,
                key_version: self.server.key_version.clone(),
                version: None,
                digest: None,
                size: 0,
                plaintext: 0,
                platform: req.platform.clone(),
                browser: req.browser_version.clone(),
                op_id,
                init_key: key.to_owned(),
                init_digest: digest,
                parts: BTreeMap::new(),
                recovery: req.recovery,
            };
            st.snaps.insert(id.clone(), s.clone());
            (id, s)
        };
        Self::leave(&mut st, "init")?;
        Ok(InitResult {
            operation_id: snap.op_id.clone(),
            snapshot_id: id,
            org_id: org.to_owned(),
            profile_id: profile.to_owned(),
            key_version: snap.key_version.clone(),
            schema_version: 1,
            data_key: SealKey::from_bytes(snap.key),
            part_size: self.server.part_size,
            max_parts: 10_000,
            max_bytes: 4 << 30,
        })
    }

    fn part_urls(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        parts: &[u32],
    ) -> Result<Vec<PartUrl>, ApiError> {
        let mut st = self.enter("part_urls")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?.clone();
        if s.state != "uploading" {
            return Err(code(409, "SYNC_STATE_CONFLICT"));
        }
        if !s.recovery {
            self.require_lease(&st, profile, &s.fencing.to_string())?;
        }
        let urls = parts
            .iter()
            .map(|n| PartUrl {
                part_number: *n,
                url: Self::token(&mut st, snapshot, *n),
            })
            .collect();
        Self::leave(&mut st, "part_urls")?;
        Ok(urls)
    }

    fn stored_parts(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<Vec<StoredPart>, ApiError> {
        let mut st = self.enter("stored_parts")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?;
        let parts = if s.state == "uploading" {
            s.parts
                .iter()
                .map(|(n, b)| StoredPart {
                    part_number: *n,
                    size: b.len() as u64,
                    etag: etag(b),
                })
                .collect()
        } else {
            vec![]
        };
        Self::leave(&mut st, "stored_parts")?;
        Ok(parts)
    }

    fn commit(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        req: &CommitRequest,
    ) -> Result<Operation, ApiError> {
        let mut st = self.enter("commit")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?.clone();
        if s.state != "uploading" {
            if s.digest.as_deref().is_some_and(|d| d != req.digest) {
                return Err(code(409, "SYNC_STATE_CONFLICT"));
            }
            Self::leave(&mut st, "commit")?;
            return Ok(op_of(&s));
        }
        if req.fencing_token != s.fencing.to_string() {
            return Err(ApiError::Fenced {
                state: "superseded".into(),
            });
        }
        if !s.recovery {
            self.require_lease(&st, profile, &req.fencing_token)?;
        }
        let head = st.profiles.get(profile).map(|p| p.1).unwrap_or(0);
        if !s.recovery && head != s.base {
            if let Some(m) = st.snaps.get_mut(snapshot) {
                m.state = "failed";
                m.error = Some("VERSION_CONFLICT".into());
            }
            return Err(ApiError::Conflict { head_version: head });
        }
        let count = req.ciphertext_size.div_ceil(self.server.part_size).max(1) as usize;
        let mut declared: Vec<_> = req.parts.clone();
        declared.sort_by_key(|p| p.part_number);
        if declared.len() != count
            || declared
                .iter()
                .enumerate()
                .any(|(i, p)| p.part_number as usize != i + 1)
        {
            return Err(code(400, "UPLOAD_INCOMPLETE"));
        }
        let mut object = Vec::new();
        for (i, p) in declared.iter().enumerate() {
            let Some(b) = s.parts.get(&p.part_number) else {
                return Err(code(400, "UPLOAD_INCOMPLETE"));
            };
            if etag(b) != p.etag || (i + 1 < count && b.len() as u64 != self.server.part_size) {
                return Err(code(400, "UPLOAD_INCOMPLETE"));
            }
            object.extend_from_slice(b);
        }
        if object.len() as u64 != req.ciphertext_size {
            return Err(code(400, "UPLOAD_INCOMPLETE"));
        }
        st.objects.insert(snapshot.to_owned(), object);
        let m = st
            .snaps
            .get_mut(snapshot)
            .ok_or_else(|| code(404, "NOT_FOUND"))?;
        m.state = "verifying";
        m.digest = Some(req.digest.clone());
        m.size = req.ciphertext_size;
        m.plaintext = req.plaintext_size;
        m.parts.clear();
        let view = op_of(m);
        Self::leave(&mut st, "commit")?;
        Ok(view)
    }

    fn cancel(&self, org: &str, profile: &str, snapshot: &str) -> Result<(), ApiError> {
        let mut st = self.enter("cancel")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?;
        if s.state == "uploading" {
            s.state = "canceled";
            s.error = Some("CANCELED".into());
            s.parts.clear();
        }
        Self::leave(&mut st, "cancel")
    }

    fn operation(&self, org: &str, operation: &str) -> Result<Operation, ApiError> {
        let mut st = self.enter("operation")?;
        let Some(id) = st
            .snaps
            .iter()
            .find(|(_, s)| s.op_id == operation && s.org == org)
            .map(|(id, _)| id.clone())
        else {
            return Err(code(404, "NOT_FOUND"));
        };
        if !self.orgs.iter().any(|o| o == org) {
            return Err(code(404, "NOT_FOUND"));
        }
        if self.server.auto_verify.load(Ordering::Relaxed)
            && st.snaps.get(&id).is_some_and(|s| s.state == "verifying")
        {
            verify(&mut st, &id);
        }
        let view = st
            .snaps
            .get(&id)
            .map(op_of)
            .ok_or_else(|| code(404, "NOT_FOUND"))?;
        Self::leave(&mut st, "operation")?;
        Ok(view)
    }

    fn restore_plan(
        &self,
        org: &str,
        profile: &str,
        snapshot: Option<&str>,
    ) -> Result<RestorePlan, ApiError> {
        let mut st = self.enter("restore_plan")?;
        self.profile(&st, org, profile)?;
        let head = st.profiles.get(profile).cloned().unwrap_or_default();
        let Some(id) = snapshot.map(str::to_owned).or(head.2.clone()) else {
            return Err(code(404, "NOT_FOUND"));
        };
        let s = match st.snaps.get(&id) {
            Some(s) if s.profile == profile && s.org == org && s.state == "committed" => s.clone(),
            _ => return Err(code(404, "NOT_FOUND")),
        };
        let url = Self::token(&mut st, &id, 0);
        Self::leave(&mut st, "restore_plan")?;
        Ok(RestorePlan {
            snapshot: info_of(&id, &s),
            head_version: head.1,
            download_url: url,
            org_id: org.to_owned(),
            profile_id: profile.to_owned(),
            key_version: s.key_version.clone(),
            data_key: SealKey::from_bytes(s.key),
        })
    }

    fn latest(&self, org: &str, profile: &str) -> Result<Option<SnapshotInfo>, ApiError> {
        self.latest_inner(org, profile)
    }
}

impl SessionApi for FakeClient {
    fn open_session(
        &self,
        org: &str,
        profile: &str,
        key: &str,
        req: &OpenRequest,
    ) -> Result<SessionOpened, ApiError> {
        let mut st = self.enter("open_session")?;
        self.profile(&st, org, profile)?;
        let replay_key = format!("{org}/{key}");
        if let Some(o) = st.session_keys.get(&replay_key).cloned() {
            Self::leave(&mut st, "open_session")?;
            return Ok(o);
        }
        if req.device_id != self.device {
            return Err(code(403, "FORBIDDEN"));
        }
        // Viewers (and operators whose grant lacks `launch`) cannot open a profile.
        if st
            .capabilities
            .get(&self.device)
            .is_some_and(|c| !c.iter().any(|c| c == "launch"))
        {
            return Err(code(403, "FORBIDDEN"));
        }
        let purpose = if req.purpose == "upload" {
            "upload"
        } else {
            "session"
        };
        let ttl = if purpose == "session" {
            SESSION_TTL_MS
        } else {
            UPLOAD_TTL_MS
        };
        let (lease, note) = self.take(&mut st, profile, purpose, ttl)?;
        let now = st.clock;
        let head = st.profiles.get(profile).map(|p| p.1).unwrap_or(0);
        let opened = SessionOpened {
            lease: info_of_lease(profile, &lease, now),
            handoff_note: note.map(|(text, by)| HandoffNote {
                text,
                by_user_id: format!("usr_{}", by.trim_start_matches("dev_")),
                by_name: format!("Person on {by}"),
                at: now.to_string(),
            }),
            head_version: head,
            server_time: now.to_string(),
        };
        st.session_keys.insert(replay_key, opened.clone());
        Self::leave(&mut st, "open_session")?;
        Ok(opened)
    }

    fn heartbeat(
        &self,
        org: &str,
        profile: &str,
        lease: &str,
        fencing: &str,
        run_state: Option<&str>,
    ) -> Result<Beat, ApiError> {
        let mut st = self.enter("heartbeat")?;
        self.profile(&st, org, profile)?;
        let now = st.clock;
        let l = self.own_lease(&mut st, profile, lease, fencing)?;
        if l.state != "active" {
            return Err(ApiError::Fenced {
                state: l.state.into(),
            });
        }
        let revived = l.expires <= now;
        l.expires = now + l.ttl_ms;
        l.heartbeat = Some(now);
        if let Some(r) = run_state {
            l.run_state = Some(r.to_owned());
        }
        let info = info_of_lease(profile, l, now);
        let requests = st
            .requests
            .iter()
            .filter(|r| r.profile == profile && r.status == "open")
            .map(|r| request_view(r, &self.device, now))
            .collect();
        Self::leave(&mut st, "heartbeat")?;
        Ok(Beat {
            lease: info,
            revived,
            handoff_requests: requests,
            server_time: now.to_string(),
        })
    }

    fn release_session(
        &self,
        org: &str,
        profile: &str,
        lease: &str,
        fencing: &str,
        outcome: SessionOutcome,
        handoff_note: Option<&str>,
    ) -> Result<(), ApiError> {
        let mut st = self.enter("release_session")?;
        self.profile(&st, org, profile)?;
        let device = self.device.clone();
        let l = match self.own_lease(&mut st, profile, lease, fencing) {
            Err(ApiError::Fenced { state }) if state == "released" => {
                Self::leave(&mut st, "release_session")?;
                return Ok(());
            }
            other => other?,
        };
        if l.state == "released" {
            Self::leave(&mut st, "release_session")?;
            return Ok(());
        }
        if l.state != "active" {
            return Err(ApiError::Fenced {
                state: l.state.into(),
            });
        }
        l.state = "released";
        l.run_state = Some("closed".into());
        l.note = handoff_note
            .filter(|n| !n.trim().is_empty())
            .map(|n| (n.to_owned(), device));
        let _ = outcome;
        let id = l.id.clone();
        if let Some(h) = st.history.get_mut(&id) {
            h.end = Some("released");
        }
        for r in st.requests.iter_mut() {
            if r.profile == profile && r.status == "open" {
                r.status = "fulfilled";
            }
        }
        Self::leave(&mut st, "release_session")
    }

    fn capabilities(&self, org: &str, profile: &str) -> Result<Vec<String>, ApiError> {
        let mut st = self.enter("capabilities")?;
        self.profile(&st, org, profile)?;
        let caps = st
            .capabilities
            .get(&self.device)
            .cloned()
            .unwrap_or_else(|| vec!["launch".into(), "edit".into(), "backup_download".into()]);
        Self::leave(&mut st, "capabilities")?;
        Ok(caps)
    }

    fn current_lease(&self, org: &str, profile: &str) -> Result<Option<LeaseInfo>, ApiError> {
        let mut st = self.enter("current_lease")?;
        self.profile(&st, org, profile)?;
        let now = st.clock;
        let l = st
            .leases
            .get(profile)
            .filter(|l| l.state == "active" && (l.expires > now || l.purpose == "session"))
            .map(|l| info_of_lease(profile, l, now));
        Self::leave(&mut st, "current_lease")?;
        Ok(l)
    }
}

fn request_view(r: &Req, me: &str, now: u64) -> HandoffRequest {
    HandoffRequest {
        id: r.id.clone(),
        profile_id: r.profile.clone(),
        requested_by: format!("usr_{}", r.from.trim_start_matches("dev_")),
        requested_by_name: format!("Person on {}", r.from),
        holder_user_id: None,
        note: r.note.clone(),
        status: r.status.to_owned(),
        created_at: now.to_string(),
        responded_at: None,
        expires_at: (now + 3_600_000).to_string(),
        mine: r.from == me,
    }
}

fn info_of(id: &str, s: &Snap) -> SnapshotInfo {
    SnapshotInfo {
        id: id.to_owned(),
        version: s.version.unwrap_or(0),
        digest: s.digest.clone().unwrap_or_default(),
        ciphertext_size: s.size,
        plaintext_size: s.plaintext,
        platform: s.platform.clone(),
        browser_version: s.browser.clone(),
        schema_version: 1,
        device_id: Some(s.device.clone()),
        committed_at: None,
    }
}

fn op_of(s: &Snap) -> Operation {
    Operation {
        id: s.op_id.clone(),
        state: s.state.to_owned(),
        version: s.version,
        error_code: s.error.clone(),
    }
}

fn etag(bytes: &[u8]) -> String {
    pb_seal::format::digest_reader(bytes)
        .map(|d| d.0[..32].to_owned())
        .unwrap_or_default()
}

impl FakeClient {
    fn latest_inner(&self, org: &str, profile: &str) -> Result<Option<SnapshotInfo>, ApiError> {
        let mut st = self.enter("latest")?;
        self.profile(&st, org, profile)?;
        let head = st.profiles.get(profile).and_then(|p| p.2.clone());
        let info = head.and_then(|id| st.snaps.get(&id).map(|s| info_of(&id, s)));
        Self::leave(&mut st, "latest")?;
        Ok(info)
    }
}

impl Objects for FakeClient {
    fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, ObjectError> {
        let mut st = self.server.st();
        st.calls.push("put_part");
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == "put_part" && *w == When::Before)
        {
            st.faults.remove(i);
            return Err(ObjectError::Offline);
        }
        let token = url.strip_prefix("fake://storage/").unwrap_or_default();
        let Some((snapshot, part)) = st.urls.get(token).cloned() else {
            return Err(ObjectError::Expired);
        };
        if part == 0 {
            return Err(ObjectError::Refused("403".into()));
        }
        match st.snaps.get_mut(&snapshot) {
            Some(s) if s.state == "uploading" => {
                s.parts.insert(part, bytes.to_vec());
            }
            _ => return Err(ObjectError::Refused("404".into())),
        }
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == "put_part" && *w == When::After)
        {
            st.faults.remove(i);
            return Err(ObjectError::Offline);
        }
        Ok(etag(bytes))
    }

    fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        _restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, ObjectError> {
        let (bytes, cut) = {
            let mut st = self.server.st();
            st.calls.push("download");
            let token = url.strip_prefix("fake://storage/").unwrap_or_default();
            let Some((snapshot, 0)) = st.urls.get(token).cloned() else {
                return Err(ObjectError::Expired);
            };
            let Some(bytes) = st.objects.get(&snapshot).cloned() else {
                return Err(ObjectError::Refused("404".into()));
            };
            // "download" Before: the connection drops halfway through.
            let cut = st
                .faults
                .iter()
                .position(|(c, _)| *c == "download")
                .map(|i| st.faults.remove(i));
            (bytes, cut.is_some())
        };
        let start = start.min(bytes.len() as u64) as usize;
        let end = if cut {
            start + (bytes.len() - start) / 2
        } else {
            bytes.len()
        };
        let mut offset = start;
        for chunk in bytes[start..end].chunks(4096) {
            if cancel.load(Ordering::Relaxed) {
                return Err(ObjectError::Cancelled);
            }
            out.write_all(chunk).map_err(|_| ObjectError::Local)?;
            offset += chunk.len();
            progress(offset as u64);
        }
        if cut {
            return Err(ObjectError::Offline);
        }
        Ok(offset as u64)
    }
}

// ================================================================================================ automation (10)

fn claimed_of(j: &FakeJob) -> crate::automation::ClaimedJob {
    use crate::automation::{ClaimedJob, JobInfo, JobStepInfo};
    let mut resume = None;
    for s in &j.steps {
        if s.state == "succeeded" || s.state == "skipped" {
            continue;
        }
        if s.state == "running" || s.state == "pending" {
            resume = Some(s.seq);
        }
        break;
    }
    ClaimedJob {
        job: JobInfo {
            id: j.id.clone(),
            org_id: j.org.clone(),
            profile_id: j.profile.clone(),
            profile_name: "Profile".into(),
            client_name: None,
            label: None,
            state: j.state.into(),
            attempt: j.attempt,
            keep_open_minutes: j.keep_open,
            debug: j.debug_sha.is_some(),
            requested_by_name: "Someone".into(),
            cancel_requested_at: j.cancel.then(|| "now".into()),
        },
        steps: j
            .steps
            .iter()
            .map(|s| JobStepInfo {
                seq: s.seq,
                action: s.action.clone(),
                effect: String::new(),
                input: s.input.clone(),
                state: s.state.clone(),
                attempt: s.attempt,
                error_code: s.error.clone(),
            })
            .collect(),
        allowed_origins: j.allowed.clone(),
        lease_key: format!("{}-{}", j.id, j.agent.clone().unwrap_or_default()),
        debug_capability_sha256: j.debug_sha.clone(),
        resume_from: resume,
    }
}

impl crate::automation::AutomationApi for FakeClient {
    fn enroll_agent(
        &self,
        org: &str,
        req: &crate::automation::EnrollRequest,
    ) -> Result<crate::automation::AgentInfo, ApiError> {
        let mut st = self.enter("enroll_agent")?;
        if !self.orgs.iter().any(|o| o == org) || req.device_id != self.device {
            return Err(code(404, "NOT_FOUND"));
        }
        let existing = st
            .agents
            .iter()
            .find(|(_, (o, d, _))| o == org && *d == self.device)
            .map(|(id, _)| id.clone());
        let id = match existing {
            Some(id) => id,
            None => {
                st.seq += 1;
                let id = ulid_like("agt", st.seq);
                st.agents.insert(
                    id.clone(),
                    (org.to_owned(), self.device.clone(), req.max_jobs),
                );
                id
            }
        };
        Self::leave(&mut st, "enroll_agent")?;
        Ok(crate::automation::AgentInfo {
            id,
            org_id: org.to_owned(),
            device_id: self.device.clone(),
            name: req.name.clone().unwrap_or_default(),
            enabled: true,
            accepts: req.accepts.clone(),
            debug_allowed: false,
            max_jobs: req.max_jobs,
            online: true,
            running_jobs: 0,
            version: 1,
        })
    }

    fn remove_agent(&self, org: &str, agent: &str) -> Result<(), ApiError> {
        let mut st = self.enter("remove_agent")?;
        match st.agents.get(agent) {
            Some((o, d, _)) if o == org && *d == self.device => {}
            _ => return Err(code(404, "NOT_FOUND")),
        }
        st.agents.remove(agent);
        for j in st.jobs.iter_mut() {
            if j.agent.as_deref() == Some(agent) && j.state == "CLAIMED" {
                j.state = "QUEUED";
                j.agent = None;
            } else if j.agent.as_deref() == Some(agent) && j.state == "RUNNING" {
                j.state = "FAILED";
                j.error = Some("ACCESS_REMOVED".into());
            }
        }
        Ok(())
    }

    fn poll_agent(
        &self,
        org: &str,
        agent: &str,
        req: &crate::automation::PollRequest,
    ) -> Result<crate::automation::PollAnswer, ApiError> {
        let mut st = self.enter("poll_agent")?;
        let Some((o, d, max_jobs)) = st.agents.get(agent).cloned() else {
            return Err(code(404, "NOT_FOUND"));
        };
        if o != org || d != self.device {
            return Err(code(404, "NOT_FOUND"));
        }
        let mut cancel = vec![];
        let mut abandon = vec![];
        let mut assigned = vec![];
        let reported: Vec<String> = req.running.iter().map(|r| r.job_id.clone()).collect();
        for r in &req.running {
            match st.jobs.iter().find(|j| j.id == r.job_id) {
                Some(j)
                    if j.agent.as_deref() == Some(agent)
                        && j.attempt == r.attempt
                        && matches!(j.state, "CLAIMED" | "RUNNING") =>
                {
                    if j.cancel {
                        cancel.push(j.id.clone());
                    }
                }
                _ => abandon.push(r.job_id.clone()),
            }
        }
        let held: Vec<FakeJob> = st
            .jobs
            .iter()
            .filter(|j| {
                j.agent.as_deref() == Some(agent) && matches!(j.state, "CLAIMED" | "RUNNING")
            })
            .cloned()
            .collect();
        for j in &held {
            if !reported.contains(&j.id) {
                assigned.push(claimed_of(j));
                if j.cancel {
                    cancel.push(j.id.clone());
                }
            }
        }
        let now = st.clock;
        let mut slots = req.capacity.min(max_jobs.saturating_sub(held.len() as u32));
        let busy: Vec<String> = st
            .jobs
            .iter()
            .filter(|j| matches!(j.state, "CLAIMED" | "RUNNING"))
            .map(|j| j.profile.clone())
            .collect();
        let leased: Vec<String> = st
            .leases
            .iter()
            .filter(|(_, l)| l.state == "active" && (l.live(now) || l.purpose == "session"))
            .map(|(p, _)| p.clone())
            .collect();
        let mut taken = vec![];
        for j in st.jobs.iter_mut() {
            if slots == 0 {
                break;
            }
            if j.org != org
                || j.state != "QUEUED"
                || busy.contains(&j.profile)
                || leased.contains(&j.profile)
                || taken.contains(&j.profile)
                || (j.debug_sha.is_some() && !req.debug_allowed)
            {
                continue;
            }
            j.state = "CLAIMED";
            j.attempt += 1;
            j.agent = Some(agent.to_owned());
            taken.push(j.profile.clone());
            assigned.push(claimed_of(j));
            slots -= 1;
        }
        st.reports.push("poll".into());
        Self::leave(&mut st, "poll_agent")?;
        Ok(crate::automation::PollAnswer {
            agent: crate::automation::AgentInfo {
                id: agent.to_owned(),
                org_id: org.to_owned(),
                device_id: self.device.clone(),
                name: String::new(),
                enabled: true,
                accepts: "mine".into(),
                debug_allowed: req.debug_allowed,
                max_jobs,
                online: true,
                running_jobs: held.len() as u32,
                version: 1,
            },
            assigned,
            cancel,
            abandon,
            poll_after_seconds: 5,
        })
    }

    fn report_job(
        &self,
        org: &str,
        job: &str,
        report: &crate::automation::JobReport,
    ) -> Result<crate::automation::ReportAnswer, ApiError> {
        use crate::automation::JobReport as R;
        let mut st = self.enter("report_job")?;
        let leases = st.leases.clone();
        let device = self.device.clone();
        let agents = st.agents.clone();
        let Some(j) = st.jobs.iter_mut().find(|j| j.id == job && j.org == org) else {
            return Err(code(404, "NOT_FOUND"));
        };
        let mine = j
            .agent
            .as_ref()
            .and_then(|a| agents.get(a))
            .is_some_and(|(_, d, _)| *d == device);
        if !mine {
            return Err(code(409, "JOB_CLAIM_STALE"));
        }
        if matches!(j.state, "SUCCEEDED" | "FAILED" | "CANCELED") {
            return Err(code(409, "JOB_FINISHED"));
        }
        let attempt = match report {
            R::Started { attempt, .. }
            | R::StepStarted { attempt, .. }
            | R::StepFinished { attempt, .. }
            | R::Released { attempt, .. }
            | R::Finished { attempt, .. } => *attempt,
        };
        if attempt != j.attempt {
            return Err(code(409, "JOB_CLAIM_STALE"));
        }
        let current = leases.get(&j.profile).cloned();
        let check = |lease_id: &str, token: &str| -> Result<(), ApiError> {
            let Some(l) = &current else {
                return Err(ApiError::Fenced {
                    state: "superseded".into(),
                });
            };
            if l.id != lease_id || l.state != "active" || l.purpose != "session" {
                return Err(ApiError::Fenced {
                    state: if l.id == lease_id {
                        l.state.into()
                    } else {
                        "superseded".into()
                    },
                });
            }
            if l.device != device || l.fencing.to_string() != token {
                return Err(ApiError::Fenced {
                    state: "superseded".into(),
                });
            }
            Ok(())
        };
        let label;
        match report {
            R::Started {
                lease_id,
                fencing_token,
                ..
            } => {
                check(lease_id, fencing_token)?;
                j.state = "RUNNING";
                j.lease = Some((lease_id.clone(), fencing_token.clone()));
                label = "started".to_owned();
            }
            R::StepStarted { seq, .. } => {
                let Some((l, t)) = j.lease.clone() else {
                    return Err(code(409, "JOB_CLAIM_STALE"));
                };
                // Like the API: closing is recorded without the lease (it may have ended already).
                let closing = j
                    .steps
                    .iter()
                    .any(|s| s.seq == *seq && s.action == "close_profile");
                if !closing {
                    check(&l, &t)?;
                }
                let cancel = j.cancel;
                let Some(step) = j.steps.iter_mut().find(|s| s.seq == *seq) else {
                    return Err(code(404, "NOT_FOUND"));
                };
                if !(cancel && step.action != "close_profile" && step.action != "hold_open") {
                    step.state = "running".into();
                    step.attempt += 1;
                }
                if step.action == "close_profile" {
                    for s in j.steps.iter_mut() {
                        if s.seq < *seq && s.state == "pending" {
                            s.state = "skipped".into();
                        }
                    }
                }
                label = format!("step_started:{seq}");
            }
            R::StepFinished {
                seq,
                state,
                error_code,
                output,
                ..
            } => {
                let Some(step) = j.steps.iter_mut().find(|s| s.seq == *seq) else {
                    return Err(code(404, "NOT_FOUND"));
                };
                if step.state != "running" {
                    return Err(code(400, "VALIDATION_FAILED"));
                }
                step.state = state.clone();
                step.error = error_code.clone();
                step.output = output.clone();
                label = format!("step_finished:{seq}:{state}");
            }
            R::Released { error_code, .. } => {
                if j.state != "CLAIMED" {
                    return Err(code(409, "JOB_CLAIM_STALE"));
                }
                j.state = "QUEUED";
                j.agent = None;
                label = format!("released:{error_code}");
            }
            R::Finished {
                state, error_code, ..
            } => {
                j.state = match state.as_str() {
                    "SUCCEEDED" => "SUCCEEDED",
                    "CANCELED" => "CANCELED",
                    _ => "FAILED",
                };
                j.error = error_code.clone();
                for s in j.steps.iter_mut() {
                    if s.state == "pending" {
                        s.state = "skipped".into();
                    }
                }
                label = format!("finished:{state}");
            }
        }
        let answer = crate::automation::ReportAnswer {
            state: j.state.into(),
            cancel_requested: j.cancel,
        };
        st.reports.push(label);
        Self::leave(&mut st, "report_job")?;
        Ok(answer)
    }

    fn upload_artifact(
        &self,
        org: &str,
        job: &str,
        seq: u32,
        _attempt: u32,
        _width: u32,
        _height: u32,
        jpeg: &[u8],
    ) -> Result<String, ApiError> {
        let mut st = self.enter("upload_artifact")?;
        if !st.jobs.iter().any(|j| j.id == job && j.org == org) {
            return Err(code(404, "NOT_FOUND"));
        }
        st.seq += 1;
        let id = ulid_like("art", st.seq);
        st.artifacts
            .insert(id.clone(), (job.to_owned(), seq, jpeg.to_vec()));
        Ok(id)
    }
}
