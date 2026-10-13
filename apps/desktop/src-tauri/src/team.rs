//! Shared sessions of organization profiles (milestone 08, ADR-0015): one authorized writer per profile, and a
//! handoff people can follow.
//!
//! ```text
//! open    lease (server checks access, plan and browser) → restore the newest backup when this computer's copy is
//!         older (an unsynced local copy is kept aside, never merged) → launch → heartbeat every 15 s
//! close   the browser exits → the closing backup uploads under the session's lease → release with the handoff
//!         note. "Handoff ready" only after the commit.
//! lost    heartbeats fail for 40 s (the lease lasts 60 s past the last one) → the browser is closed before the lease
//!         runs out; once the connection is back, the heartbeat revives the lease and the closing backup uploads.
//! ended   taken over by an admin, or access removed → the browser is closed; this computer's copy is kept aside
//!         (after a takeover it is also uploaded as a recovery copy for admins). Nothing is merged.
//! ```
//!
//! Requests from teammates arrive with each heartbeat; they never close the session by themselves. Timing uses
//! monotonic clocks on this computer and the server's answers; the computer's wall clock is never trusted.

use crate::events::TEAM;
use crate::ipc::{self, IpcError};
use crate::operations::{OpKind, Started};
use crate::state::{AppState, platform};
use pb_runtime::{ProfileId, RunState};
use pb_storage::LocalStore;
use pb_storage::cloud as cs;
use pb_storage::runs::RunOutcome;
use pb_storage::team::TeamSession;
use pb_sync::{
    ApiError, HandoffNote, HandoffRequest, Holder, Job, JobStore, OpenRequest, SessionOutcome,
    UploadJob, UploadState,
};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Timings of the session protocol on this computer (the server's are SESSION_LEASE: 15 s / 60 s).
#[derive(Clone, Copy, Debug)]
pub struct TeamTiming {
    /// Heartbeat interval (the server's `heartbeat_seconds`).
    pub heartbeat: Duration,
    /// Without a successful heartbeat for this long, the browser is closed (well before the 60 s TTL).
    pub shutdown_after: Duration,
    /// After this long without one, a browser that is still open is forced to close (the lease has run out).
    pub force_after: Duration,
    /// A handoff whose upload has not finished after this long waits for the person's decision.
    pub handoff_window: Duration,
    /// How often the worker looks at sessions.
    pub tick: Duration,
}

impl Default for TeamTiming {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(15),
            shutdown_after: Duration::from_secs(40),
            force_after: Duration::from_secs(60),
            handoff_window: Duration::from_secs(2 * 3600),
            tick: Duration::from_secs(1),
        }
    }
}

/// What this computer knows about a session between heartbeats (memory only).
#[derive(Clone, Debug)]
struct Live {
    /// When the last heartbeat that succeeded was sent (the lease runs at least `ttl` past it).
    last_ok: Instant,
    last_try: Option<Instant>,
    requests: Vec<HandoffRequest>,
    /// When the closing upload started (for the handoff window).
    handing_off_since: Option<Instant>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Refusal {
    pub code: &'static str,
    pub holder_name: String,
    pub device_name: String,
    pub since: Option<String>,
}

/// An automation job's open (milestone 10): its idempotency key and what to do once the lease is held.
pub(crate) struct JobOpen<'a> {
    pub key: &'a str,
    pub after_lease: &'a dyn Fn(&str, &str) -> Result<(), String>,
}

pub struct TeamRuntime {
    live: Mutex<HashMap<ProfileId, Live>>,
    /// Operations of opens in progress (a repeated click joins the same one).
    opening: Mutex<HashMap<ProfileId, String>>,
    /// The last refusal to open a profile (who has it), for the window.
    refusals: Mutex<HashMap<ProfileId, Refusal>>,
    timing: RwLock<TeamTiming>,
    /// Tests move this computer's monotonic clock forward.
    skew: Mutex<Duration>,
    wake: Mutex<bool>,
    cv: Condvar,
    worker: AtomicBool,
    tick_lock: Mutex<()>,
}

impl TeamRuntime {
    pub fn new() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
            opening: Mutex::new(HashMap::new()),
            refusals: Mutex::new(HashMap::new()),
            timing: RwLock::new(TeamTiming::default()),
            skew: Mutex::new(Duration::ZERO),
            wake: Mutex::new(false),
            cv: Condvar::new(),
            worker: AtomicBool::new(false),
            tick_lock: Mutex::new(()),
        }
    }

    fn now(&self) -> Instant {
        Instant::now() + self.skew.lock().map(|s| *s).unwrap_or_default()
    }

    fn timing(&self) -> TeamTiming {
        self.timing.read().map(|t| *t).unwrap_or_default()
    }

    fn live(&self, id: &ProfileId) -> Option<Live> {
        self.live.lock().ok().and_then(|m| m.get(id).cloned())
    }

    fn update_live(&self, id: &ProfileId, f: impl FnOnce(&mut Live)) {
        let now = self.now();
        if let Ok(mut m) = self.live.lock() {
            f(m.entry(id.clone()).or_insert(Live {
                last_ok: now,
                last_try: None,
                requests: Vec::new(),
                handing_off_since: None,
            }));
        }
    }

    fn forget(&self, id: &ProfileId) {
        if let Ok(mut m) = self.live.lock() {
            m.remove(id);
        }
    }
}

impl Default for TeamRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// The session as the window sees it (`get_team_status`).
#[derive(Serialize, Debug)]
pub struct TeamStatus {
    pub profile_id: String,
    pub shared: bool,
    /// opening, running, closing, handing_off, pending, lost, taken_over, revoked; `None`: no session here.
    pub phase: Option<String>,
    pub error_code: Option<String>,
    /// Open requests from teammates (the holder's view).
    pub requests: Vec<HandoffRequest>,
    /// The note the previous holder left (shown when the profile opened here).
    pub received_note: Option<HandoffNote>,
    /// The note this person will leave.
    pub handoff_note: Option<String>,
    /// A copy kept aside on this computer (taken over, access removed, unsynced before a restore).
    pub kept_aside: Option<String>,
    /// Why the last open was refused (someone else has it).
    pub refusal: Option<Refusal>,
    /// What this person may do (`None`: not known yet).
    pub capabilities: Option<Vec<String>>,
    /// Seconds since the last successful heartbeat (while the session is live).
    pub heartbeat_age_seconds: Option<u64>,
}

const SHARED_OFFLINE: IpcError = IpcError::new(
    "SHARED_OFFLINE",
    "Organization profiles open only when this computer can reach your organization's server. Profiles on \
     this computer only work as usual.",
);

fn open_error(e: &ApiError) -> (&'static str, &'static str) {
    match e {
        ApiError::Offline => (SHARED_OFFLINE.code, SHARED_OFFLINE.message),
        ApiError::SignedOut => (
            "CLOUD_SIGNED_OUT",
            "Sign in to your organization to open its profiles.",
        ),
        ApiError::LeaseHeld(h) if h.uncertain => (
            "PROFILE_SESSION_UNCERTAIN",
            "The last session on another computer ended without closing; its browser may still be open. Ask \
             that person to open the app, or an admin to take the profile over.",
        ),
        ApiError::LeaseHeld(_) => (
            "PROFILE_IN_USE_ELSEWHERE",
            "Someone else has this profile open. You can ask them for it.",
        ),
        e if e.is_code("RUNTIME_TOO_OLD") => (
            "RUNTIME_TOO_OLD",
            "The newest backup of this profile needs a newer browser. Update the browser on this computer first.",
        ),
        e if e.is_code("ENTITLEMENT_REQUIRED") => (
            "ENTITLEMENT_REQUIRED",
            "Your organization's plan does not include shared profiles.",
        ),
        e if e.is_code("FORBIDDEN") || e.is_code("NOT_FOUND") => (
            "NO_ACCESS",
            "You do not have access to open this profile. Ask an admin.",
        ),
        _ => (
            "CLOUD_UNAVAILABLE",
            "The organization server could not open the profile. Try again in a moment.",
        ),
    }
}

/// Session phases that still hold the lease on the server (heartbeats continue).
pub(crate) fn leased(phase: &str) -> bool {
    matches!(
        phase,
        "opening" | "running" | "closing" | "handing_off" | "pending" | "lost"
    )
}

/// Turns a lease end state into the session's phase.
fn ended_phase(state: &str) -> &'static str {
    if state == "revoked" {
        "revoked"
    } else {
        "taken_over"
    }
}

impl AppState {
    // ------------------------------------------------------------------------------------------- plumbing
    pub fn set_team_timing(&self, timing: TeamTiming) {
        if let Ok(mut t) = self.team.timing.write() {
            *t = timing;
        }
    }

    /// Moves this computer's monotonic clock forward (tests).
    pub fn team_advance(&self, by: Duration) {
        if let Ok(mut s) = self.team.skew.lock() {
            *s += by;
        }
    }

    pub fn team_wake(&self) {
        if let Ok(mut w) = self.team.wake.lock() {
            *w = true;
            self.team.cv.notify_all();
        }
    }

    fn team_event(&self, id: &ProfileId, kind: &str, extra: serde_json::Value) {
        let mut payload = json!({ "profile_id": id.as_str(), "kind": kind });
        if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                p.insert(k.clone(), v.clone());
            }
        }
        self.events.emit_json(TEAM, payload);
    }

    fn set_phase(&self, store: &LocalStore, s: &mut TeamSession, phase: &str, code: Option<&str>) {
        s.phase = phase.to_owned();
        s.error_code = code.map(str::to_owned);
        let _ = store.put_team_session(s);
        self.team_event(
            &s.local_profile_id,
            "phase",
            json!({ "phase": phase, "error_code": code }),
        );
    }

    /// Starts the background worker (once): heartbeats, handoffs and lost sessions.
    pub fn start_team_worker(self: &Arc<Self>) {
        if self.team.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            loop {
                let tick = this.team.timing().tick;
                {
                    let Ok(mut woken) = this.team.wake.lock() else {
                        return;
                    };
                    if !*woken {
                        woken = match this.team.cv.wait_timeout(woken, tick) {
                            Ok((g, _)) => g,
                            Err(_) => return,
                        };
                    }
                    *woken = false;
                }
                this.run_team_tick();
            }
        });
    }

    // ------------------------------------------------------------------------------------------- open
    /// A linked (organization) profile opens through a session lease. Called by `launch_profile`.
    pub(crate) fn launch_shared(
        self: &Arc<Self>,
        store: &Arc<LocalStore>,
        id: &ProfileId,
        start_url: Option<&str>,
    ) -> Result<Started, IpcError> {
        if let Some(op) = self
            .team
            .opening
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
        {
            return Ok(Started { operation_id: op });
        }
        if self.sync_restoring(store, id) {
            return Err(ipc::PROFILE_RESTORING);
        }
        let link = store.sync_link(id)?.ok_or(ipc::SYNC_NOT_LINKED)?;
        if link.conflict_head.is_some() {
            return Err(ipc::SYNC_CONFLICT_OPEN);
        }
        let existing = store.team_session(id)?;
        if let Some(s) = &existing
            && matches!(s.phase.as_str(), "taken_over" | "revoked")
        {
            return Err(ipc::SESSION_ENDED);
        }
        let op = self.ops.start(OpKind::LaunchProfile, Some(id.to_string()));
        if let Ok(mut m) = self.team.opening.lock() {
            m.insert(id.clone(), op.clone());
        }
        let this = self.clone();
        let id = id.clone();
        let url = start_url.map(str::to_owned);
        let op_id = op.clone();
        let org_id = link.org_id.clone();
        std::thread::spawn(move || {
            // Milestone 09: the organization's extension policy as current as possible before the browser starts.
            this.refresh_policy_if_stale(&org_id);
            let result = match existing.filter(|s| leased(&s.phase) && s.lease_id.is_some()) {
                // Still ours (closing, pending, lost): reopen under the same lease.
                Some(s) => this.reopen_shared(s, url.as_deref(), &op_id, None),
                None => this.open_shared(&id, url.as_deref(), &op_id, None),
            };
            if let Ok(mut m) = this.team.opening.lock() {
                m.remove(&id);
            }
            if let Err((code, message)) = result {
                this.ops.fail(&op_id, code, message);
                this.notify_running_changed();
            }
        });
        Ok(Started { operation_id: op })
    }

    /// Opens an organization profile for an automation job (milestone 10, ADR-0017): the same lease, restore and
    /// launch as a person's open, but synchronous, with the job's idempotency key, and with a hook right after the
    /// lease is held (the job reports it; an error stops the open and gives the profile back).
    pub(crate) fn open_for_job(
        self: &Arc<Self>,
        id: &ProfileId,
        job: &JobOpen<'_>,
    ) -> Result<String, (&'static str, &'static str)> {
        let store = self
            .store()
            .map_err(|_| ("INTERNAL", "Something went wrong opening the profile."))?;
        if self.sync_restoring(&store, id) {
            return Err((ipc::PROFILE_RESTORING.code, ipc::PROFILE_RESTORING.message));
        }
        let link = store
            .sync_link(id)
            .ok()
            .flatten()
            .ok_or((ipc::SYNC_NOT_LINKED.code, ipc::SYNC_NOT_LINKED.message))?;
        if link.conflict_head.is_some() {
            return Err((
                ipc::SYNC_CONFLICT_OPEN.code,
                ipc::SYNC_CONFLICT_OPEN.message,
            ));
        }
        let existing = store.team_session(id).ok().flatten();
        if let Some(s) = &existing
            && matches!(s.phase.as_str(), "taken_over" | "revoked")
        {
            return Err((ipc::SESSION_ENDED.code, ipc::SESSION_ENDED.message));
        }
        let op = self.ops.start(OpKind::LaunchProfile, Some(id.to_string()));
        self.refresh_policy_if_stale(&link.org_id);
        let result = match existing.filter(|s| leased(&s.phase) && s.lease_id.is_some()) {
            Some(s) => self.reopen_shared(s, None, &op, Some(job)),
            None => self.open_shared(id, None, &op, Some(job)),
        };
        if let Err((code, message)) = result {
            self.ops.fail(&op, code, message);
            self.notify_running_changed();
            return Err((code, message));
        }
        Ok(op)
    }

    fn open_shared(
        self: &Arc<Self>,
        id: &ProfileId,
        start_url: Option<&str>,
        op: &str,
        job: Option<&JobOpen<'_>>,
    ) -> Result<(), (&'static str, &'static str)> {
        let internal = ("INTERNAL", "Something went wrong opening the profile.");
        let store = self.store().map_err(|_| internal)?;
        let link = store
            .sync_link(id)
            .ok()
            .flatten()
            .ok_or((ipc::SYNC_NOT_LINKED.code, ipc::SYNC_NOT_LINKED.message))?;
        let device = store.cloud_state(cs::DEVICE_ID).ok().flatten().ok_or((
            "CLOUD_SIGNED_OUT",
            "Sign in to your organization to open its profiles.",
        ))?;
        // An unfinished backup of this profile is replaced by the session's own closing backup.
        self.cancel_uploads_of(&store, id);
        // A job uses its own key: every retry of the job on this computer gets the same lease (milestone 10).
        let open_key = match job {
            Some(j) => j.key.to_owned(),
            None => store
                .team_session(id)
                .ok()
                .flatten()
                .map(|s| s.open_key)
                .unwrap_or_else(|| pb_sync::job::random_id("open-").unwrap_or_default()),
        };
        let mut session = TeamSession {
            local_profile_id: id.clone(),
            org_id: link.org_id.clone(),
            org_profile_id: link.org_profile_id.clone(),
            lease_id: None,
            fencing_token: None,
            open_key: open_key.clone(),
            phase: "opening".into(),
            operation_id: Some(op.to_owned()),
            upload_job_id: None,
            handoff_note: None,
            received_note: None,
            error_code: None,
            quarantine: None,
            started_at: String::new(),
            updated_at: String::new(),
        };
        // Saved before the request: an app killed while waiting replays the same key (same lease).
        store.put_team_session(&session).map_err(|_| internal)?;
        let browser = self
            .installed_browser(&store)
            .unwrap_or_else(|| "0.0.0.0".into());
        let sent = self.team.now();
        let opened = self
            .with_session(|api| {
                api.open_session(
                    &link.org_id,
                    &link.org_profile_id,
                    &open_key,
                    &OpenRequest {
                        device_id: device.clone(),
                        purpose: "session".into(),
                        platform: platform().into(),
                        browser_version: browser.clone(),
                    },
                )
            })
            .unwrap_or(Err(ApiError::SignedOut));
        let opened = match opened {
            Ok(o) => o,
            Err(e) => {
                let _ = store.delete_team_session(id);
                if let ApiError::LeaseHeld(h) = &e {
                    self.record_refusal(id, h);
                }
                let _ = store.audit(Some(id), "team", "open_refused", None, Some(e.code()));
                return Err(open_error(&e));
            }
        };
        if let Ok(mut r) = self.team.refusals.lock() {
            r.remove(id);
        }
        session.lease_id = Some(opened.lease.id.clone());
        session.fencing_token = Some(opened.lease.fencing_token.clone());
        session.received_note = opened
            .handoff_note
            .as_ref()
            .and_then(|n| serde_json::to_string(n).ok());
        store.put_team_session(&session).map_err(|_| internal)?;
        self.team.update_live(id, |l| {
            l.last_ok = sent;
            l.last_try = Some(sent);
            l.requests.clear();
        });
        let _ = store.audit(
            Some(id),
            "team",
            "opened",
            None,
            Some(&format!("lease {}", opened.lease.id)),
        );
        self.refresh_capabilities(&store, id, &link.org_id, &link.org_profile_id);
        // An automation job reports its lease before anything else happens (it may have been canceled meanwhile).
        if let Some(j) = job
            && let Err(code) = (j.after_lease)(&opened.lease.id, &opened.lease.fencing_token)
        {
            self.end_session(&store, &mut session, SessionOutcome::Failed);
            let _ = store.audit(Some(id), "team", "job_stopped", None, Some(&code));
            return Err((
                "JOB_STOPPED",
                "The automation job was stopped before the profile opened.",
            ));
        }

        // This computer's copy must be the newest backup before the browser opens.
        let user_data = self.root.dirs(id).user_data;
        let behind = opened.head_version > link.synced_version
            || (opened.head_version > 0 && !user_data.exists());
        if behind {
            if link.dirty && user_data.exists() {
                // Unsynced changes here and a newer backup elsewhere: never merged. This copy is kept aside.
                if let Ok(ev) = self.backups.preserve_evidence(
                    id.as_str(),
                    &user_data,
                    "unsynced-before-restore",
                ) {
                    session.quarantine = ev.file_name().map(|n| n.to_string_lossy().into_owned());
                    let _ = store.put_team_session(&session);
                    let _ = store.audit(Some(id), "team", "kept_aside", None, Some("unsynced"));
                }
            }
            self.ops.progress(op, 0.1);
            if let Err(code) = self.restore_for_session(&store, id, &link, &session) {
                self.end_session(&store, &mut session, SessionOutcome::Failed);
                let _ = store.audit(Some(id), "team", "restore_failed", None, Some(&code));
                return Err((
                    "SESSION_RESTORE_FAILED",
                    "The newest backup could not be put on this computer. The profile was not opened.",
                ));
            }
        }
        self.ops.progress(op, 0.6);
        self.launch_in_session(&store, &mut session, start_url, op)
    }

    /// Reopens a profile whose session this computer still holds (closing, pending, lost): the lease is confirmed
    /// (revived if it expired while nobody else could take it), the closing upload is dropped, the browser opens.
    fn reopen_shared(
        self: &Arc<Self>,
        mut session: TeamSession,
        start_url: Option<&str>,
        op: &str,
        job: Option<&JobOpen<'_>>,
    ) -> Result<(), (&'static str, &'static str)> {
        let internal = ("INTERNAL", "Something went wrong opening the profile.");
        let store = self.store().map_err(|_| internal)?;
        let id = session.local_profile_id.clone();
        match self.beat(&store, &mut session) {
            Beat::Ok => {}
            Beat::Ended => {
                return Err((ipc::SESSION_ENDED.code, ipc::SESSION_ENDED.message));
            }
            Beat::Failed(e) => return Err(open_error(&e)),
        }
        if let (Some(j), Some(lease), Some(token)) =
            (job, session.lease_id.clone(), session.fencing_token.clone())
            && let Err(code) = (j.after_lease)(&lease, &token)
        {
            let _ = store.audit(Some(&id), "team", "job_stopped", None, Some(&code));
            return Err((
                "JOB_STOPPED",
                "The automation job was stopped before the profile opened.",
            ));
        }
        self.cancel_uploads_of(&store, &id);
        session.upload_job_id = None;
        session.operation_id = Some(op.to_owned());
        self.set_phase(&store, &mut session, "opening", None);
        self.launch_in_session(&store, &mut session, start_url, op)
    }

    fn launch_in_session(
        self: &Arc<Self>,
        store: &LocalStore,
        session: &mut TeamSession,
        start_url: Option<&str>,
        op: &str,
    ) -> Result<(), (&'static str, &'static str)> {
        let id = session.local_profile_id.clone();
        match self.launch_local(&id, start_url, Some(op.to_owned())) {
            Ok(_) => {
                self.set_phase(store, session, "running", None);
                self.team_wake();
                Ok(())
            }
            Err(e) => {
                // A failed launch gives the profile back.
                self.end_session(store, session, SessionOutcome::Failed);
                let _ = store.audit(Some(&id), "team", "launch_failed", None, Some(e.code));
                Err((e.code, e.message))
            }
        }
    }

    fn record_refusal(&self, id: &ProfileId, h: &Holder) {
        if let Ok(mut r) = self.team.refusals.lock() {
            r.insert(
                id.clone(),
                Refusal {
                    code: if h.uncertain {
                        "PROFILE_SESSION_UNCERTAIN"
                    } else {
                        "PROFILE_IN_USE_ELSEWHERE"
                    },
                    holder_name: h.holder_name.clone(),
                    device_name: h.device_name.clone(),
                    since: h.since.clone(),
                },
            );
        }
    }

    fn refresh_capabilities(&self, store: &LocalStore, id: &ProfileId, org: &str, prf: &str) {
        if let Ok(Ok(caps)) = self.with_session(|api| api.capabilities(org, prf)) {
            let _ = store.set_link_capabilities(id, &caps);
        }
    }

    // ------------------------------------------------------------------------------------------- heartbeat
    /// One heartbeat for a session; handles what the answer means.
    fn beat(self: &Arc<Self>, store: &LocalStore, session: &mut TeamSession) -> Beat {
        let (Some(lease), Some(token)) = (session.lease_id.clone(), session.fencing_token.clone())
        else {
            return Beat::Failed(ApiError::LeaseLost);
        };
        let id = session.local_profile_id.clone();
        let run_state = match session.phase.as_str() {
            "opening" => Some("restoring"),
            "running" => Some("running"),
            "closing" | "lost" => Some("stopping"),
            "handing_off" | "pending" => Some("uploading"),
            _ => None,
        };
        let sent = self.team.now();
        self.team.update_live(&id, |l| l.last_try = Some(sent));
        let r = self
            .with_session(|api| {
                api.heartbeat(
                    &session.org_id,
                    &session.org_profile_id,
                    &lease,
                    &token,
                    run_state,
                )
            })
            .unwrap_or(Err(ApiError::SignedOut));
        match r {
            Ok(b) => {
                let previous: Vec<String> = self
                    .team
                    .live(&id)
                    .map(|l| l.requests.iter().map(|r| r.id.clone()).collect())
                    .unwrap_or_default();
                let fresh: Vec<&HandoffRequest> = b
                    .handoff_requests
                    .iter()
                    .filter(|r| !previous.contains(&r.id))
                    .collect();
                if !fresh.is_empty() {
                    self.team_event(&id, "requests", json!({ "requests": b.handoff_requests }));
                }
                self.team.update_live(&id, |l| {
                    l.last_ok = sent;
                    l.requests = b.handoff_requests.clone();
                });
                if b.revived {
                    let _ = store.audit(Some(&id), "team", "revived", None, None);
                }
                if session.phase == "lost" {
                    // Connected again: the browser is closing or closed; the handoff continues.
                    let _ = store.audit(Some(&id), "team", "reconnected", None, None);
                    self.team_event(&id, "reconnected", json!({}));
                }
                Beat::Ok
            }
            Err(ApiError::Fenced { state }) if state == "released" => {
                let _ = store.delete_team_session(&id);
                self.team.forget(&id);
                Beat::Ended
            }
            Err(ApiError::Fenced { state }) => {
                self.session_lost(store, session, ended_phase(&state));
                Beat::Ended
            }
            Err(e) if e.is_code("NOT_FOUND") || e.is_code("FORBIDDEN") => {
                self.session_lost(store, session, "revoked");
                Beat::Ended
            }
            Err(e) => Beat::Failed(e),
        }
    }

    /// The worker's step (tests call it directly): heartbeats that are due, lost connections, finished handoffs
    /// and sessions that ended.
    pub fn run_team_tick(self: &Arc<Self>) {
        let Ok(_one) = self.team.tick_lock.lock() else {
            return;
        };
        let Ok(store) = self.store() else { return };
        let timing = self.team.timing();
        for mut s in store.team_sessions().unwrap_or_default() {
            let id = s.local_profile_id.clone();
            if matches!(s.phase.as_str(), "taken_over" | "revoked") {
                self.settle_ended(&store, &mut s);
                continue;
            }
            if !leased(&s.phase) || s.lease_id.is_none() {
                continue;
            }
            if s.phase == "opening"
                && self
                    .team
                    .opening
                    .lock()
                    .map(|m| !m.contains_key(&id))
                    .unwrap_or(false)
                && !self.supervisor.is_tracked(&id)
            {
                // An open that never finished (the app was killed mid-open): give the profile back.
                self.end_session(&store, &mut s, SessionOutcome::Failed);
                continue;
            }
            let now = self.team.now();
            let live = self.team.live(&id).unwrap_or(Live {
                last_ok: now,
                last_try: None,
                requests: Vec::new(),
                handing_off_since: None,
            });
            let due = live
                .last_try
                .is_none_or(|t| now.saturating_duration_since(t) >= timing.heartbeat);
            if due {
                match self.beat(&store, &mut s) {
                    Beat::Ended => continue,
                    Beat::Ok | Beat::Failed(_) => {}
                }
            }
            let live = self.team.live(&id).unwrap_or(live);
            let silent = self.team.now().saturating_duration_since(live.last_ok);
            let running = self.supervisor.is_tracked(&id);
            if running && silent >= timing.shutdown_after && s.phase != "lost" {
                // The lease may run out: close the browser while it is still ours, keep everything local.
                self.set_phase(&store, &mut s, "lost", Some("CONNECTION_LOST"));
                let _ = store.audit(Some(&id), "team", "connection_lost", None, None);
                let _ = self.stop_profile(&id, false);
            } else if running && silent >= timing.force_after {
                // Still open after the lease ran out: fencing protects the organization's data, but the browser
                // must not keep going without a lease.
                let _ = self.stop_profile(&id, true);
            }
            if s.phase == "handing_off" {
                self.check_handoff(&store, &mut s, &live, timing);
            }
        }
    }

    // ------------------------------------------------------------------------------------------- close
    /// The browser of a linked profile exited (from the monitor).
    pub(crate) fn team_after_exit(self: &Arc<Self>, id: &ProfileId, outcome: RunOutcome) {
        let Ok(store) = self.store() else { return };
        let Ok(Some(mut s)) = store.team_session(id) else {
            return;
        };
        if !matches!(s.phase.as_str(), "opening" | "running" | "closing" | "lost") {
            return;
        }
        if outcome == RunOutcome::EarlyExit {
            // The browser never finished starting: the launch failed and the profile is given back (nothing was
            // worked on, nothing is uploaded).
            let _ = store.audit(
                Some(id),
                "team",
                "launch_failed",
                None,
                Some("EXITED_EARLY"),
            );
            self.end_session(&store, &mut s, SessionOutcome::Failed);
            return;
        }
        if outcome != RunOutcome::Clean {
            // Not a verified clean shutdown: nothing is uploaded until the person decides (reopen, or give it
            // back keeping this copy).
            self.set_phase(&store, &mut s, "pending", Some("PROFILE_CLOSED_UNCLEANLY"));
            let _ = store.audit(
                Some(id),
                "team",
                "closed_uncleanly",
                None,
                Some(outcome.as_str()),
            );
            return;
        }
        self.start_handoff(&store, &mut s);
    }

    fn start_handoff(self: &Arc<Self>, store: &LocalStore, s: &mut TeamSession) {
        let id = s.local_profile_id.clone();
        let (Some(lease), Some(token)) = (s.lease_id.clone(), s.fencing_token.clone()) else {
            return;
        };
        let Ok(Some(link)) = store.sync_link(&id) else {
            return;
        };
        self.cancel_uploads_of(store, &id);
        let Ok(job) = pb_sync::new_upload(
            id.as_str(),
            &link.org_id,
            &link.org_profile_id,
            link.synced_version,
        ) else {
            return;
        };
        let job = job.under_session(&lease, &token);
        let _ = store.set_sync_dirty(&id, true);
        if self.save_job(store, &Job::Upload(job.clone())).is_err() {
            return;
        }
        s.upload_job_id = Some(job.id.clone());
        let was_lost = s.phase == "lost";
        self.set_phase(
            store,
            s,
            "handing_off",
            was_lost.then_some("CONNECTION_LOST"),
        );
        let now = self.team.now();
        self.team
            .update_live(&id, |l| l.handing_off_since = Some(now));
        let _ = store.audit(Some(&id), "team", "closing_backup", None, None);
        self.sync_wake();
    }

    /// Called after an upload job ran (from the sync worker).
    pub(crate) fn team_after_upload(self: &Arc<Self>, store: &LocalStore, job: &UploadJob) {
        let Ok(id) = ProfileId::parse(&job.local_profile_id) else {
            return;
        };
        let Ok(Some(mut s)) = store.team_session(&id) else {
            return;
        };
        if job.is_recovery() {
            if job.state == UploadState::Committed {
                s.error_code = Some("RECOVERY_COPY_KEPT".into());
                s.upload_job_id = None;
                let _ = store.put_team_session(&s);
                self.team_event(&id, "recovery_kept", json!({}));
                let _ = store.audit(Some(&id), "team", "recovery_copy_kept", None, None);
            }
            return;
        }
        if job.session_lease().is_none() || s.upload_job_id.as_deref() != Some(job.id.as_str()) {
            return;
        }
        match job.state {
            UploadState::Committed => self.finish_handoff(store, &mut s),
            UploadState::Failed => match job.error_code.as_deref() {
                Some(code) if code.starts_with("LEASE_") => {
                    let state = code.trim_start_matches("LEASE_").to_lowercase();
                    self.session_lost(store, &mut s, ended_phase(&state));
                }
                code => self.set_phase(store, &mut s, "pending", code.or(Some("UPLOAD_FAILED"))),
            },
            UploadState::Conflict => {
                self.set_phase(store, &mut s, "pending", Some("VERSION_CONFLICT"));
            }
            UploadState::Canceled => {
                // Canceled by the person: still leased; they retry or give the handoff up.
                self.set_phase(store, &mut s, "pending", Some("UPLOAD_CANCELED"));
            }
            _ => {}
        }
    }

    fn check_handoff(
        self: &Arc<Self>,
        store: &LocalStore,
        s: &mut TeamSession,
        live: &Live,
        t: TeamTiming,
    ) {
        if s.error_code.as_deref() == Some("RELEASE_PENDING") {
            // The backup committed but the release answer never came: send it again.
            self.finish_handoff(store, s);
            return;
        }
        if let Some(since) = live.handing_off_since
            && self.team.now().saturating_duration_since(since) >= t.handoff_window
        {
            self.set_phase(store, s, "pending", Some("HANDOFF_STALLED"));
        }
    }

    /// The closing backup committed: release the lease with the note. "Handoff ready" only now.
    fn finish_handoff(self: &Arc<Self>, store: &LocalStore, s: &mut TeamSession) {
        let id = s.local_profile_id.clone();
        match self.release(s, SessionOutcome::Committed) {
            Ok(()) => {
                let _ = store.delete_team_session(&id);
                self.team.forget(&id);
                let _ = store.audit(Some(&id), "team", "handed_off", None, None);
                self.team_event(&id, "handoff_ready", json!({}));
            }
            Err(ApiError::Fenced { state }) => self.session_lost(store, s, ended_phase(&state)),
            Err(_) => {
                s.error_code = Some("RELEASE_PENDING".into());
                let _ = store.put_team_session(s);
            }
        }
    }

    fn release(&self, s: &TeamSession, outcome: SessionOutcome) -> Result<(), ApiError> {
        let (Some(lease), Some(token)) = (&s.lease_id, &s.fencing_token) else {
            return Ok(());
        };
        let note = s.handoff_note.clone();
        let r = self
            .with_session(|api| {
                api.release_session(
                    &s.org_id,
                    &s.org_profile_id,
                    lease,
                    token,
                    outcome,
                    note.as_deref(),
                )
            })
            .unwrap_or(Err(ApiError::SignedOut));
        match r {
            Err(ApiError::Fenced { state }) if state == "released" => Ok(()),
            other => other,
        }
    }

    /// Gives the profile back now (best effort) and forgets the session.
    fn end_session(&self, store: &LocalStore, s: &mut TeamSession, outcome: SessionOutcome) {
        if s.lease_id.is_none() && s.phase == "opening" {
            // Killed while the open was on its way: the same key returns the lease the server may have granted,
            // so it can be released instead of blocking others until an admin steps in.
            self.replay_open(store, s);
        }
        let _ = self.release(s, outcome);
        let id = s.local_profile_id.clone();
        let _ = store.delete_team_session(&id);
        self.team.forget(&id);
        self.team_event(&id, "phase", json!({ "phase": null }));
    }

    fn replay_open(&self, store: &LocalStore, s: &mut TeamSession) {
        let Some(device) = store.cloud_state(cs::DEVICE_ID).ok().flatten() else {
            return;
        };
        let browser = self
            .installed_browser(store)
            .unwrap_or_else(|| "0.0.0.0".into());
        let replayed = self.with_session(|api| {
            api.open_session(
                &s.org_id,
                &s.org_profile_id,
                &s.open_key,
                &OpenRequest {
                    device_id: device.clone(),
                    purpose: "session".into(),
                    platform: platform().into(),
                    browser_version: browser.clone(),
                },
            )
        });
        if let Ok(Ok(o)) = replayed {
            s.lease_id = Some(o.lease.id);
            s.fencing_token = Some(o.lease.fencing_token);
        }
    }

    // ------------------------------------------------------------------------------------------- lost leases
    /// The lease was taken over or access removed: the browser closes, this copy is kept aside (and, after a
    /// takeover, offered to admins as a recovery copy). Nothing is merged and nothing more is written.
    fn session_lost(
        self: &Arc<Self>,
        store: &LocalStore,
        s: &mut TeamSession,
        phase: &'static str,
    ) {
        let id = s.local_profile_id.clone();
        if let Some(job) = s.upload_job_id.take() {
            self.cancel_job_quietly(store, &id, &job);
        }
        self.set_phase(
            store,
            s,
            phase,
            Some(if phase == "revoked" {
                "ACCESS_REMOVED"
            } else {
                "TAKEN_OVER"
            }),
        );
        let _ = store.audit(Some(&id), "team", phase, None, None);
        self.team.forget(&id);
        if self.supervisor.is_tracked(&id) {
            let _ = self.stop_profile_quietly(&id);
        }
    }

    /// Once the browser is closed: keep this copy aside (once), and after a takeover upload it as a recovery copy.
    fn settle_ended(&self, store: &LocalStore, s: &mut TeamSession) {
        let id = s.local_profile_id.clone();
        if self.supervisor.is_tracked(&id) {
            return;
        }
        if s.quarantine.is_none() {
            let user_data = self.root.dirs(&id).user_data;
            let label = if s.phase == "revoked" {
                "access-removed"
            } else {
                "taken-over"
            };
            if !user_data.exists() {
                s.quarantine = Some(String::new());
            } else if let Ok(ev) = self
                .backups
                .preserve_evidence(id.as_str(), &user_data, label)
            {
                s.quarantine = ev.file_name().map(|n| n.to_string_lossy().into_owned());
                let _ = store.set_sync_dirty(&id, false);
                let _ = store.audit(Some(&id), "team", "kept_aside", None, Some(label));
            } else {
                return;
            }
            let _ = store.put_team_session(s);
            self.team_event(&id, "kept_aside", json!({ "phase": s.phase }));
            if s.phase == "taken_over"
                && s.quarantine.as_deref().is_some_and(|q| !q.is_empty())
                && let (Some(lease), Some(token)) = (s.lease_id.clone(), s.fencing_token.clone())
                && let Ok(Some(link)) = store.sync_link(&id)
                && let Ok(job) =
                    pb_sync::new_upload(id.as_str(), &link.org_id, &link.org_profile_id, 0)
            {
                let job = job.as_recovery(&lease, &token);
                if self.save_job(store, &Job::Upload(job.clone())).is_ok() {
                    s.upload_job_id = Some(job.id);
                    let _ = store.put_team_session(s);
                    self.sync_wake();
                }
            }
        }
    }

    /// The copy kept aside for a recovery upload (`<evidence>/<profile>/<name>/user-data`).
    pub(crate) fn team_quarantine_dir(
        &self,
        store: &LocalStore,
        id: &ProfileId,
    ) -> Option<std::path::PathBuf> {
        let s = store.team_session(id).ok().flatten()?;
        let q = s
            .quarantine
            .filter(|q| !q.is_empty() && !q.contains(['/', '\\']) && q != "..")?;
        Some(
            self.backups
                .evidence
                .join(id.as_str())
                .join(q)
                .join("user-data"),
        )
    }

    // ------------------------------------------------------------------------------------------- commands
    pub fn team_status(&self, id: &ProfileId) -> Result<TeamStatus, IpcError> {
        let store = self.store()?;
        store.get_profile(id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let link = store.sync_link(id)?;
        let s = store.team_session(id)?;
        let live = self.team.live(id);
        let now = self.team.now();
        Ok(TeamStatus {
            profile_id: id.to_string(),
            shared: link.is_some(),
            phase: s.as_ref().map(|s| s.phase.clone()),
            error_code: s.as_ref().and_then(|s| s.error_code.clone()),
            requests: live
                .as_ref()
                .map(|l| l.requests.clone())
                .unwrap_or_default(),
            received_note: s
                .as_ref()
                .and_then(|s| s.received_note.as_deref())
                .and_then(|n| serde_json::from_str(n).ok()),
            handoff_note: s.as_ref().and_then(|s| s.handoff_note.clone()),
            kept_aside: s
                .as_ref()
                .and_then(|s| s.quarantine.clone())
                .filter(|q| !q.is_empty()),
            refusal: self
                .team
                .refusals
                .lock()
                .ok()
                .and_then(|r| r.get(id).cloned()),
            capabilities: store.link_capabilities(id)?,
            heartbeat_age_seconds: live
                .filter(|_| s.as_ref().is_some_and(|s| leased(&s.phase)))
                .map(|l| now.saturating_duration_since(l.last_ok).as_secs()),
        })
    }

    /// Close and hand off: the note goes to the next person; the browser closes; the closing backup uploads; the
    /// lease is released after the commit.
    pub fn team_close(
        self: &Arc<Self>,
        id: &ProfileId,
        note: Option<&str>,
    ) -> Result<TeamStatus, IpcError> {
        let store = self.store()?;
        let mut s = store.team_session(id)?.ok_or(ipc::TEAM_NO_SESSION)?;
        if !leased(&s.phase) {
            return Err(ipc::SESSION_ENDED);
        }
        s.handoff_note = match note.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => Some(ipc::clean_handoff_note(n)?),
            None => None,
        };
        store.put_team_session(&s)?;
        if self.supervisor.is_tracked(id) {
            if s.phase == "running" {
                self.set_phase(&store, &mut s, "closing", None);
            }
            self.stop_profile(id, false)?;
        } else if matches!(s.phase.as_str(), "pending" | "lost") {
            // Closed already (or crashed): try the handoff now.
            self.start_handoff(&store, &mut s);
        }
        self.team_status(id)
    }

    /// Gives up the handoff: the newest backup stays as it was, this computer keeps its copy (unsynced), and the
    /// profile is released for others. Needs the server (the release must reach it).
    pub fn team_abort(self: &Arc<Self>, id: &ProfileId) -> Result<TeamStatus, IpcError> {
        let store = self.store()?;
        let mut s = store.team_session(id)?.ok_or(ipc::TEAM_NO_SESSION)?;
        if self.supervisor.is_tracked(id) {
            return Err(ipc::SYNC_PROFILE_NOT_CLOSED);
        }
        if !leased(&s.phase) {
            return Err(ipc::SESSION_ENDED);
        }
        if let Some(job) = s.upload_job_id.take() {
            self.cancel_job_quietly(&store, id, &job);
        }
        match self.release(&s, SessionOutcome::Aborted) {
            Ok(()) => {}
            Err(ApiError::Fenced { state }) => {
                self.session_lost(&store, &mut s, ended_phase(&state));
                return self.team_status(id);
            }
            Err(ApiError::Offline) => return Err(ipc::CLOUD_OFFLINE),
            Err(_) => return Err(ipc::CLOUD_UNAVAILABLE),
        }
        let _ = store.set_sync_dirty(id, true);
        let _ = store.delete_team_session(id);
        self.team.forget(id);
        let _ = store.audit(Some(id), "team", "handoff_aborted", None, None);
        self.team_event(id, "phase", json!({ "phase": null }));
        self.team_status(id)
    }

    /// Tries a stalled or failed handoff again.
    pub fn team_retry(self: &Arc<Self>, id: &ProfileId) -> Result<TeamStatus, IpcError> {
        let store = self.store()?;
        let mut s = store.team_session(id)?.ok_or(ipc::TEAM_NO_SESSION)?;
        if self.supervisor.is_tracked(id) {
            return Err(ipc::SYNC_PROFILE_NOT_CLOSED);
        }
        match s.phase.as_str() {
            "pending" if s.error_code.as_deref() == Some("PROFILE_CLOSED_UNCLEANLY") => {
                return Err(ipc::SESSION_NEEDS_REOPEN);
            }
            "pending" | "handing_off" | "lost" => self.start_handoff(&store, &mut s),
            _ => return Err(ipc::SESSION_ENDED),
        }
        self.team_status(id)
    }

    /// Clears a session that ended (taken over, access removed) once the person has seen it.
    pub fn team_dismiss(&self, id: &ProfileId) -> Result<TeamStatus, IpcError> {
        let store = self.store()?;
        let s = store.team_session(id)?.ok_or(ipc::TEAM_NO_SESSION)?;
        if leased(&s.phase) {
            return Err(ipc::TEAM_SESSION_ACTIVE);
        }
        // A recovery upload still running continues without the banner.
        let _ = store.delete_team_session(id);
        self.team.forget(id);
        self.team_event(id, "phase", json!({ "phase": null }));
        self.team_status(id)
    }

    /// Start-up: sessions this computer held when the app last stopped.
    pub fn resume_team_sessions(self: &Arc<Self>) {
        let Ok(store) = self.store() else { return };
        for mut s in store.team_sessions().unwrap_or_default() {
            let id = s.local_profile_id.clone();
            let running = self.supervisor.is_tracked(&id);
            match s.phase.as_str() {
                "opening" if !running => {
                    // Killed mid-open: give the profile back.
                    self.end_session(&store, &mut s, SessionOutcome::Failed);
                }
                "opening" | "running" | "closing" if running => {
                    if s.phase != "running" {
                        self.set_phase(&store, &mut s, "running", None);
                    }
                }
                "running" | "closing" | "lost" if !running => {
                    let clean = store
                        .get_profile(&id)
                        .ok()
                        .flatten()
                        .is_some_and(|p| p.state == RunState::Stopped);
                    if clean {
                        self.start_handoff(&store, &mut s);
                    } else {
                        self.set_phase(&store, &mut s, "pending", Some("PROFILE_CLOSED_UNCLEANLY"));
                    }
                }
                _ => {}
            }
        }
        self.team_wake();
    }

    /// Edits of an organization profile's settings (the ones its backups carry) need the `edit` capability, and
    /// any edit waits while the session's lease cannot be confirmed (connection lost) or after it ended.
    pub fn team_guard_edit(&self, id: &ProfileId, synced_settings: bool) -> Result<(), IpcError> {
        let store = self.store()?;
        if let Some(s) = store.team_session(id)?
            && matches!(s.phase.as_str(), "lost" | "taken_over" | "revoked")
        {
            return Err(ipc::SESSION_PAUSED);
        }
        if synced_settings
            && store
                .link_capabilities(id)?
                .is_some_and(|c| !c.iter().any(|c| c == "edit"))
        {
            return Err(ipc::NO_EDIT_CAPABILITY);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------------- helpers
    fn cancel_uploads_of(&self, store: &LocalStore, id: &ProfileId) {
        for j in store.open_sync_jobs().unwrap_or_default() {
            if &j.local_profile_id == id && j.kind == "upload" {
                self.cancel_job_quietly(store, id, &j.id);
            }
        }
    }

    fn stop_profile_quietly(self: &Arc<Self>, id: &ProfileId) -> Result<(), IpcError> {
        self.stop_profile(id, false).map(|_| ())
    }
}

/// The outcome of one heartbeat.
enum Beat {
    Ok,
    /// The lease ended (taken over, revoked, released): the session was settled.
    Ended,
    /// Not answered (offline, signed out, server error): try again later.
    Failed(ApiError),
}

/// Jobs are saved through the sync module's store (so the window sees `sync` events).
pub(crate) trait SaveJob {
    fn save_job(&self, store: &LocalStore, job: &Job) -> Result<(), String>;
}

impl SaveJob for AppState {
    fn save_job(&self, store: &LocalStore, job: &Job) -> Result<(), String> {
        crate::sync::jobs_for(store, &*self.events).save(job)
    }
}
