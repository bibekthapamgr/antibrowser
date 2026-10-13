//! Automation on this computer (milestone 10, ADR-0017): runs the jobs an organization sends to it.
//!
//! - Outbound only. While this computer is enrolled for an organization, the app asks its server every few seconds
//!   for work (the poll is also the heartbeat of the jobs it runs). Nothing listens on this computer, except the
//!   loopback broker of a debugging session that the job asked for and this computer allows ("Allow Playwright
//!   connections", off by default): authenticated, Origin-checked, one client, short connect window.
//! - A job opens its profile exactly like a person would: the same session lease (with the job's idempotency key,
//!   so a retried open gets the same lease back), the same restore of the newest backup, the same closing backup and
//!   handoff. Two jobs never write the same profile: the lease allows one holder.
//! - The browser is launched with `--enable-automation` (websites can tell) and the DevTools protocol over a
//!   protected pipe that only this app holds. Only the allowlisted steps run (open an approved address, wait for a
//!   condition, take a screenshot, keep the profile open, hand it to Playwright). Page content is data: yes/no
//!   answers, the HTTP status, the page's origin and requested screenshots are all that leave the page, and nothing
//!   on a page changes what a job may do.
//! - Every step is reported before it runs and after it finished. A step whose result was never reported is repeated
//!   only when it is safe to repeat (the server decides: `resume_from`); a step with an external effect would never
//!   be repeated (there are none in this version). A cancel stops before the next step; the profile is then closed
//!   and its closing backup uploads as usual.

use crate::events::AUTOMATION;
use crate::ipc::{self, IpcError};
use crate::operations::OpStatus;
use crate::state::{AppState, platform};
use crate::team::{JobOpen, leased};
use pb_devtools::broker::{Broker, BrokerConfig};
use pb_devtools::{Condition, Hub, Page, PipeEnds, Shot};
use pb_runtime::ProfileId;
use pb_storage::LocalStore;
use pb_storage::automation::{AutomationRun, Enrollment};
use pb_storage::cloud as cs;
use pb_storage::settings;
use pb_storage::team::TeamSession;
use pb_sync::ApiError;
use pb_sync::automation::{
    AgentInfo, ClaimedJob, EnrollRequest, JobReport, JobStepInfo, PollRequest, ReportAnswer,
    RunningJob,
};
use pb_sync::rest::id_ok;
use serde::Serialize;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Largest screenshot sent (the API's limit).
const MAX_ARTIFACT_BYTES: usize = 1_572_864;
/// Runs listed in the status view.
const STATUS_RUNS: u32 = 50;

#[derive(Clone, Copy, Debug)]
pub struct AutomationTiming {
    /// How often an enrolled computer asks for work (and reports that its jobs are alive).
    pub poll: Duration,
    /// The browser must be open and ready within this time.
    pub open_wait: Duration,
    /// A graceful close must finish within this time (then the browser is closed forcibly).
    pub stop_wait: Duration,
    /// The closing backup is waited for this long (it continues afterwards; the step says so).
    pub close_wait: Duration,
    /// A profile restored onto this computer for a job must be ready within this time.
    pub restore_wait: Duration,
    /// A debugging session's first connection must come within this time.
    pub debug_connect: Duration,
    /// Reports that could not be delivered are retried this often, this many times.
    pub report_retry: Duration,
    pub report_tries: u32,
    /// One minute of `keep_open_minutes` (tests shorten it).
    pub minute: Duration,
}

impl Default for AutomationTiming {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(5),
            open_wait: Duration::from_secs(90),
            stop_wait: Duration::from_secs(30),
            close_wait: Duration::from_secs(600),
            restore_wait: Duration::from_secs(1800),
            debug_connect: Duration::from_secs(300),
            report_retry: Duration::from_secs(2),
            report_tries: 5,
            minute: Duration::from_secs(60),
        }
    }
}

/// What may stop a running job.
#[derive(Clone, Default)]
struct Flags {
    /// Asked by the organization (the poll's `cancel`, or a report's answer).
    cancel: Arc<AtomicBool>,
    /// Stopped by the person at this computer.
    by_person: Arc<AtomicBool>,
    /// The server no longer has this computer run it (another claim, or it ended): stop without reporting.
    abandon: Arc<AtomicBool>,
}

struct Running {
    org: String,
    attempt: u32,
    flags: Flags,
}

#[derive(Clone, Debug, Default)]
struct PollState {
    last_ok: Option<Instant>,
    error_code: Option<String>,
    agent: Option<AgentInfo>,
}

pub struct AutomationRuntime {
    /// This app's ends of DevTools pipes of job launches, until the job takes them.
    pipes: Mutex<HashMap<ProfileId, PipeEnds>>,
    pipe_cv: Condvar,
    /// Profiles being opened for a job right now (their launch asks for the pipe).
    wanted: Mutex<HashSet<ProfileId>>,
    /// Jobs running on this computer, by id.
    jobs: Mutex<HashMap<String, Running>>,
    polls: Mutex<HashMap<String, PollState>>,
    timing: RwLock<AutomationTiming>,
    wake: Mutex<bool>,
    cv: Condvar,
    worker: AtomicBool,
    tick_lock: Mutex<()>,
}

impl AutomationRuntime {
    pub fn new() -> Self {
        Self {
            pipes: Mutex::new(HashMap::new()),
            pipe_cv: Condvar::new(),
            wanted: Mutex::new(HashSet::new()),
            jobs: Mutex::new(HashMap::new()),
            polls: Mutex::new(HashMap::new()),
            timing: RwLock::new(AutomationTiming::default()),
            wake: Mutex::new(false),
            cv: Condvar::new(),
            worker: AtomicBool::new(false),
            tick_lock: Mutex::new(()),
        }
    }

    fn timing(&self) -> AutomationTiming {
        self.timing.read().map(|t| *t).unwrap_or_default()
    }
}

impl Default for AutomationRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ================================================================================================ views
#[derive(Serialize, Debug, Clone)]
pub struct EnrollmentView {
    pub org_id: String,
    pub agent_id: String,
    /// `mine` (jobs of the person signed in here) or `org` (anyone's jobs in the organization).
    pub accepts: String,
    pub max_jobs: u32,
    pub created_at: String,
    /// Seconds since the organization's server last answered (none yet in this session: null).
    pub last_poll_seconds: Option<u64>,
    pub poll_error: Option<String>,
    /// Turned off by an admin in the organization (no new jobs), when known.
    pub enabled: Option<bool>,
    pub running: u32,
}

#[derive(Serialize, Debug)]
pub struct AutomationStatus {
    pub enrollments: Vec<EnrollmentView>,
    /// "Allow Playwright connections" on this computer.
    pub allow_debugging: bool,
    /// Jobs running here now.
    pub running: Vec<String>,
    /// Recent jobs this computer worked on, newest first.
    pub runs: Vec<AutomationRun>,
}

fn debugging_allowed(store: &LocalStore) -> bool {
    store
        .get_setting(settings::AUTOMATION_DEBUGGING)
        .is_ok_and(|v| v.value == Value::Bool(true))
}

fn transient(e: &ApiError) -> bool {
    matches!(e, ApiError::Offline)
        || matches!(e, ApiError::Code { status, .. } if *status == 429 || *status >= 500)
}

fn version_ok(v: &str) -> bool {
    !v.is_empty() && v.len() <= 64 && v.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

fn elapsed_ms(t0: Instant) -> u64 {
    u64::try_from(t0.elapsed().as_millis())
        .unwrap_or(u64::MAX)
        .min(86_400_000)
}

/// The idempotency key of the job's `n`th session lease on this computer: retries of one open repeat the same key
/// (and get the same lease back); a reopen after that lease ended needs a new one.
fn lease_key(base: &str, n: u32) -> String {
    if n == 0 {
        base.to_owned()
    } else {
        format!("{base}-r{n}")
    }
}

// ================================================================================================ app state
impl AppState {
    // ------------------------------------------------------------------------------------- DevTools pipes
    /// Whether this profile is being opened for an automation job: its launch adds `--enable-automation` and the
    /// protected DevTools pipe (called by the launch).
    pub(crate) fn wants_devtools(&self, id: &ProfileId) -> bool {
        self.automation.wanted.lock().is_ok_and(|w| w.contains(id))
    }

    /// This app's ends of a job launch's DevTools pipe, kept until the job takes them (called by the launch).
    pub(crate) fn keep_devtools(&self, id: &ProfileId, ends: PipeEnds) {
        if let Ok(mut p) = self.automation.pipes.lock() {
            p.insert(id.clone(), ends);
            self.automation.pipe_cv.notify_all();
        }
    }

    fn take_devtools(&self, id: &ProfileId, wait: Duration) -> Option<PipeEnds> {
        let deadline = Instant::now() + wait;
        let mut p = self.automation.pipes.lock().ok()?;
        loop {
            if let Some(ends) = p.remove(id) {
                return Some(ends);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            p = self.automation.pipe_cv.wait_timeout(p, left).ok()?.0;
        }
    }

    fn not_wanted(&self, id: &ProfileId) {
        if let Ok(mut w) = self.automation.wanted.lock() {
            w.remove(id);
        }
        // An unclaimed pipe closes (Chromium closes a browser whose DevTools pipe closed).
        if let Ok(mut p) = self.automation.pipes.lock() {
            p.remove(id);
        }
    }

    // ------------------------------------------------------------------------------------- worker
    pub fn set_automation_timing(&self, timing: AutomationTiming) {
        if let Ok(mut t) = self.automation.timing.write() {
            *t = timing;
        }
    }

    pub fn automation_wake(&self) {
        if let Ok(mut w) = self.automation.wake.lock() {
            *w = true;
            self.automation.cv.notify_all();
        }
    }

    /// Starts the background poll (once). It does nothing until this computer is enrolled.
    pub fn start_automation_worker(self: &Arc<Self>) {
        if self.automation.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            loop {
                let tick = this.automation.timing().poll;
                {
                    let Ok(mut woken) = this.automation.wake.lock() else {
                        return;
                    };
                    if !*woken {
                        woken = match this.automation.cv.wait_timeout(woken, tick) {
                            Ok((g, _)) => g,
                            Err(_) => return,
                        };
                    }
                    *woken = false;
                }
                this.run_automation_tick();
            }
        });
    }

    /// One poll per enrolled organization (the worker's step; tests call it directly).
    pub fn run_automation_tick(self: &Arc<Self>) {
        let Ok(_one) = self.automation.tick_lock.lock() else {
            return;
        };
        let Ok(store) = self.store() else { return };
        for e in store.automation_enrollments().unwrap_or_default() {
            self.poll_for(&store, &e);
        }
    }

    /// Jobs running on this computer now (ids).
    pub fn automation_running(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .automation
            .jobs
            .lock()
            .map(|j| j.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    fn set_poll(&self, org: &str, f: impl FnOnce(&mut PollState)) {
        if let Ok(mut p) = self.automation.polls.lock() {
            f(p.entry(org.to_owned()).or_default());
        }
    }

    fn poll_for(self: &Arc<Self>, store: &LocalStore, e: &Enrollment) {
        let running: Vec<RunningJob> = self
            .automation
            .jobs
            .lock()
            .map(|j| {
                j.iter()
                    .filter(|(_, r)| r.org == e.org_id)
                    .map(|(id, r)| RunningJob {
                        job_id: id.clone(),
                        attempt: r.attempt,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let req = PollRequest {
            capacity: e.max_jobs.saturating_sub(running.len() as u32),
            running,
            debug_allowed: debugging_allowed(store),
            browser_version: self.installed_browser(store).filter(|v| version_ok(v)),
            platform: Some(platform().into()),
        };
        let answer = self
            .with_automation(|api| api.poll_agent(&e.org_id, &e.agent_id, &req))
            .unwrap_or(Err(ApiError::SignedOut));
        let answer = match answer {
            Ok(a) => a,
            Err(err) => {
                let code = err.code().to_owned();
                let changed = self
                    .automation
                    .polls
                    .lock()
                    .map(|p| {
                        p.get(&e.org_id).and_then(|s| s.error_code.clone()) != Some(code.clone())
                    })
                    .unwrap_or(true);
                self.set_poll(&e.org_id, |p| p.error_code = Some(code.clone()));
                if err.is_code("NOT_FOUND") {
                    // The computer was removed in the organization (or this person left it): its jobs ended there.
                    self.forget_enrollment(store, &e.org_id, "removed_in_organization");
                } else if changed {
                    self.events.emit_json(
                        AUTOMATION,
                        json!({ "kind": "poll", "org_id": e.org_id, "error_code": code }),
                    );
                }
                return;
            }
        };
        let was_failing = self
            .automation
            .polls
            .lock()
            .map(|p| p.get(&e.org_id).is_none_or(|s| s.error_code.is_some()))
            .unwrap_or(true);
        self.set_poll(&e.org_id, |p| {
            p.last_ok = Some(Instant::now());
            p.error_code = None;
            p.agent = Some(answer.agent.clone());
        });
        let mut changed = was_failing;
        if let Ok(jobs) = self.automation.jobs.lock() {
            for id in &answer.cancel {
                if let Some(r) = jobs.get(id) {
                    r.flags.cancel.store(true, Ordering::SeqCst);
                    changed = true;
                }
            }
            for id in &answer.abandon {
                if let Some(r) = jobs.get(id) {
                    r.flags.abandon.store(true, Ordering::SeqCst);
                    changed = true;
                }
            }
        }
        for c in answer.assigned {
            changed |= self.start_job(e, c);
        }
        if changed {
            self.events.emit_json(
                AUTOMATION,
                json!({ "kind": "poll", "org_id": e.org_id, "error_code": null }),
            );
        }
    }

    fn forget_enrollment(&self, store: &LocalStore, org: &str, why: &str) {
        let _ = store.remove_automation_enrollment(org);
        if let Ok(jobs) = self.automation.jobs.lock() {
            for r in jobs.values().filter(|r| r.org == org) {
                r.flags.abandon.store(true, Ordering::SeqCst);
            }
        }
        if let Ok(mut p) = self.automation.polls.lock() {
            p.remove(org);
        }
        let _ = store.audit(None, "automation", "unenrolled", None, Some(why));
        self.events.emit_json(
            AUTOMATION,
            json!({ "kind": "poll", "org_id": org, "enrolled": false }),
        );
    }

    /// Runs a job the server gave this computer (on its own thread). False when it is already running here.
    fn start_job(self: &Arc<Self>, e: &Enrollment, c: ClaimedJob) -> bool {
        if c.job.org_id != e.org_id
            || !id_ok("job", &c.job.id)
            || !id_ok("prf", &c.job.profile_id)
            || c.lease_key.is_empty()
            || c.lease_key.len() > 100
        {
            return false;
        }
        let flags = Flags::default();
        {
            let Ok(mut jobs) = self.automation.jobs.lock() else {
                return false;
            };
            if jobs.contains_key(&c.job.id) {
                return false;
            }
            jobs.insert(
                c.job.id.clone(),
                Running {
                    org: e.org_id.clone(),
                    attempt: c.job.attempt,
                    flags: flags.clone(),
                },
            );
        }
        if c.job.cancel_requested_at.is_some() {
            flags.cancel.store(true, Ordering::SeqCst);
        }
        let this = self.clone();
        std::thread::spawn(move || {
            let id = c.job.id.clone();
            let org = c.job.org_id.clone();
            Exec::new(this.clone(), c, flags).run_to_end();
            if let Ok(mut jobs) = this.automation.jobs.lock() {
                jobs.remove(&id);
            }
            this.events.emit_json(
                AUTOMATION,
                json!({ "kind": "job", "org_id": org, "job_id": id, "state": "done" }),
            );
            // Room for the next job.
            this.automation_wake();
        });
        true
    }

    // ------------------------------------------------------------------------------------- commands
    pub fn automation_status(&self) -> Result<AutomationStatus, IpcError> {
        let store = self.store()?;
        let polls = self
            .automation
            .polls
            .lock()
            .map(|p| p.clone())
            .unwrap_or_default();
        let counts: HashMap<String, u32> = self
            .automation
            .jobs
            .lock()
            .map(|j| {
                let mut m = HashMap::new();
                for r in j.values() {
                    *m.entry(r.org.clone()).or_insert(0) += 1;
                }
                m
            })
            .unwrap_or_default();
        let enrollments = store
            .automation_enrollments()?
            .into_iter()
            .map(|e| {
                let p = polls.get(&e.org_id);
                EnrollmentView {
                    last_poll_seconds: p.and_then(|p| p.last_ok).map(|t| t.elapsed().as_secs()),
                    poll_error: p.and_then(|p| p.error_code.clone()),
                    enabled: p.and_then(|p| p.agent.as_ref()).map(|a| a.enabled),
                    running: counts.get(&e.org_id).copied().unwrap_or(0),
                    org_id: e.org_id,
                    agent_id: e.agent_id,
                    accepts: e.accepts,
                    max_jobs: e.max_jobs,
                    created_at: e.created_at,
                }
            })
            .collect();
        Ok(AutomationStatus {
            enrollments,
            allow_debugging: debugging_allowed(&store),
            running: self.automation_running(),
            runs: store.automation_runs(STATUS_RUNS)?,
        })
    }

    /// Lets this computer run the organization's jobs (as the person signed in here: only profiles they may open).
    pub fn automation_enroll(
        &self,
        org: &str,
        accepts: &str,
        max_jobs: u32,
    ) -> Result<AutomationStatus, IpcError> {
        if !id_ok("org", org) || !matches!(accepts, "mine" | "org") || !(1..=10).contains(&max_jobs)
        {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let device = store
            .cloud_state(cs::DEVICE_ID)?
            .filter(|d| id_ok("dev", d))
            .ok_or(ipc::CLOUD_SIGNED_OUT)?;
        let req = EnrollRequest {
            device_id: device,
            name: None,
            accepts: accepts.to_owned(),
            max_jobs,
        };
        let agent = self
            .with_automation(|api| api.enroll_agent(org, &req))
            .unwrap_or(Err(ApiError::SignedOut))
            .map_err(|e| match e {
                ApiError::Offline => ipc::CLOUD_OFFLINE,
                ApiError::SignedOut => ipc::CLOUD_SIGNED_OUT,
                e if e.is_code("FORBIDDEN") || e.is_code("NOT_FOUND") => ipc::AUTOMATION_FORBIDDEN,
                _ => ipc::CLOUD_UNAVAILABLE,
            })?;
        if agent.org_id != org || !id_ok("agt", &agent.id) {
            return Err(ipc::CLOUD_BAD_RESPONSE);
        }
        store.set_automation_enrollment(org, &agent.id, accepts, max_jobs)?;
        self.set_poll(org, |p| p.agent = Some(agent.clone()));
        let _ = store.audit(
            None,
            "automation",
            "enrolled",
            None,
            Some(&format!("{org} {accepts} {max_jobs}")),
        );
        self.automation_wake();
        self.automation_status()
    }

    /// Stops taking the organization's jobs here. Refused while its jobs run here (stop them first).
    pub fn automation_unenroll(&self, org: &str) -> Result<AutomationStatus, IpcError> {
        if !id_ok("org", org) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let e = store
            .automation_enrollment(org)?
            .ok_or(ipc::AUTOMATION_NOT_ENROLLED)?;
        if self
            .automation
            .jobs
            .lock()
            .is_ok_and(|j| j.values().any(|r| r.org == org))
        {
            return Err(ipc::AUTOMATION_BUSY);
        }
        // Removed in the organization too when it can be reached; otherwise it shows there as offline (a computer
        // that does not ask for work is never given any) until an admin removes it.
        let removed = self
            .with_automation(|api| api.remove_agent(org, &e.agent_id))
            .unwrap_or(Err(ApiError::SignedOut));
        let why = match removed {
            Ok(()) => "removed",
            Err(e) if e.is_code("NOT_FOUND") => "removed",
            Err(_) => "removed_here_only",
        };
        self.forget_enrollment(&store, org, why);
        self.automation_status()
    }

    /// Stops a job running here (it is reported as canceled; the profile closes and its closing backup uploads).
    pub fn automation_stop_job(&self, job: &str) -> Result<AutomationStatus, IpcError> {
        if !id_ok("job", job) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        {
            let jobs = self.automation.jobs.lock().map_err(|_| ipc::INTERNAL)?;
            let r = jobs.get(job).ok_or(ipc::UNKNOWN_JOB)?;
            r.flags.by_person.store(true, Ordering::SeqCst);
        }
        let store = self.store()?;
        let _ = store.audit(None, "automation", "stopped_here", None, Some(job));
        self.automation_status()
    }

    /// "Allow Playwright connections" on this computer (off by default; audited). Turning it off ends debugging
    /// sessions that are open.
    pub fn automation_set_debugging(&self, allow: bool) -> Result<AutomationStatus, IpcError> {
        let store = self.store()?;
        store.set_setting(settings::AUTOMATION_DEBUGGING, &json!(allow), false, None)?;
        let _ = store.audit(
            None,
            "automation",
            if allow {
                "debugging_allowed"
            } else {
                "debugging_turned_off"
            },
            None,
            None,
        );
        self.automation_wake();
        self.automation_status()
    }
}

// ================================================================================================ one job
/// How the open went.
enum Opened {
    /// The browser is open and its first tab attached.
    Ready,
    /// Nothing more runs; the profile is closed (if open) and the job reported finished.
    Stop,
    /// The claim was given back (or the job ended on the server): nothing else to do.
    GaveBack,
}

/// How the profile was given back.
enum Closed {
    Committed,
    NotNeeded,
    /// The closing backup is still uploading (it continues; the lease is released when it commits).
    Uploading,
    /// The closing backup waits for the person here (closed uncleanly, or the upload failed).
    NeedsAttention,
    LeaseLost,
}

struct Exec {
    app: Arc<AppState>,
    c: ClaimedJob,
    flags: Flags,
    t: AutomationTiming,
    run: AutomationRun,
    /// Step states as this computer knows them (the claim's, then what it reported).
    states: HashMap<u32, String>,
    local: Option<ProfileId>,
    hub: Option<Hub>,
    page: Option<Page>,
    broker: Option<Broker>,
    /// `started` was reported in this execution: the job runs under this computer's session lease.
    started: Cell<bool>,
    /// The first error (a job error code).
    failure: Option<String>,
    canceled: bool,
    /// Reports stopped: `ABANDONED` (another claim, or the computer was removed), `ENDED` (finished on the server),
    /// `DISCONNECTED` (the server could not be reached; it resumes the safe steps or ends the job).
    silent: Option<&'static str>,
}

impl Exec {
    fn new(app: Arc<AppState>, c: ClaimedJob, flags: Flags) -> Self {
        let t = app.automation.timing();
        let previous = app
            .store()
            .ok()
            .and_then(|s| s.automation_run(&c.job.id).ok().flatten());
        let states: HashMap<u32, String> =
            c.steps.iter().map(|s| (s.seq, s.state.clone())).collect();
        let done = c
            .steps
            .iter()
            .filter(|s| matches!(s.state.as_str(), "succeeded" | "skipped"))
            .count() as u32;
        let label = c
            .job
            .label
            .clone()
            .filter(|l| !l.trim().is_empty())
            .or_else(|| Some(c.job.profile_name.clone()).filter(|n| !n.trim().is_empty()));
        let run = AutomationRun {
            job_id: c.job.id.clone(),
            org_id: c.job.org_id.clone(),
            org_profile_id: c.job.profile_id.clone(),
            profile_id: previous.as_ref().and_then(|p| p.profile_id.clone()),
            label,
            attempt: c.job.attempt.max(1),
            opens: previous.as_ref().map(|p| p.opens).unwrap_or(0),
            state: "opening".into(),
            outcome: None,
            error_code: None,
            steps_total: c.steps.len() as u32,
            steps_done: done,
            debug_endpoint: None,
            started_at: String::new(),
            updated_at: String::new(),
        };
        Self {
            app,
            c,
            flags,
            t,
            run,
            states,
            local: None,
            hub: None,
            page: None,
            broker: None,
            started: Cell::new(false),
            failure: None,
            canceled: false,
            silent: None,
        }
    }

    fn store(&self) -> Option<Arc<LocalStore>> {
        self.app.store().ok()
    }

    fn save(&mut self) {
        if let Some(store) = self.store() {
            let _ = store.save_automation_run(&self.run);
        }
        self.app.events.emit_json(
            AUTOMATION,
            json!({
                "kind": "job",
                "org_id": self.run.org_id,
                "job_id": self.run.job_id,
                "state": self.run.state,
                "outcome": self.run.outcome,
            }),
        );
    }

    fn audit(&self, outcome: &str, detail: &str) {
        if let Some(store) = self.store() {
            let _ = store.audit(
                self.local.as_ref(),
                "automation",
                outcome,
                None,
                Some(detail),
            );
        }
    }

    fn step(&self, action: &str) -> Option<JobStepInfo> {
        self.c.steps.iter().find(|s| s.action == action).cloned()
    }

    fn state_of(&self, seq: u32) -> &str {
        self.states
            .get(&seq)
            .map(String::as_str)
            .unwrap_or("pending")
    }

    fn cancel_wanted(&self) -> bool {
        self.flags.cancel.load(Ordering::SeqCst) || self.flags.by_person.load(Ordering::SeqCst)
    }

    fn abandoned(&mut self) -> bool {
        if self.flags.abandon.load(Ordering::SeqCst) {
            self.silent.get_or_insert("ABANDONED");
        }
        self.silent.is_some()
    }

    fn fail(&mut self, code: &str) {
        if self.failure.is_none() {
            self.failure = Some(code.to_owned());
        }
    }

    // ------------------------------------------------------------------------------------- reports
    /// Sends a report, retrying while the server cannot be reached.
    fn report(&self, r: &JobReport) -> Result<ReportAnswer, ApiError> {
        let mut tries = 0;
        loop {
            let res = self
                .app
                .with_automation(|api| api.report_job(&self.c.job.org_id, &self.c.job.id, r))
                .unwrap_or(Err(ApiError::SignedOut));
            match res {
                Ok(a) => {
                    if a.cancel_requested {
                        self.flags.cancel.store(true, Ordering::SeqCst);
                    }
                    return Ok(a);
                }
                Err(e)
                    if transient(&e)
                        && tries + 1 < self.t.report_tries
                        && !self.flags.abandon.load(Ordering::SeqCst) =>
                {
                    tries += 1;
                    std::thread::sleep(self.t.report_retry);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// What an undeliverable or refused report means for the rest of the job.
    fn on_report_error(&mut self, e: ApiError) {
        match e {
            ApiError::Fenced { .. } | ApiError::LeaseLost => self.fail("LEASE_LOST"),
            e if e.is_code("JOB_FINISHED") || e.is_code("NOT_FOUND") || e.is_code("FORBIDDEN") => {
                self.silent.get_or_insert("ENDED");
            }
            e if e.is_code("JOB_CLAIM_STALE") => {
                self.silent.get_or_insert("ABANDONED");
            }
            e if transient(&e) || matches!(e, ApiError::SignedOut) => {
                self.silent.get_or_insert("DISCONNECTED");
            }
            _ => self.fail("INTERNAL"),
        }
    }

    fn step_finished(&mut self, seq: u32, result: Result<Value, String>) -> bool {
        let (state, code, output) = match result {
            Ok(out) => ("succeeded", None, Some(out)),
            Err(code) => ("failed", Some(code), None),
        };
        let r = JobReport::StepFinished {
            attempt: self.c.job.attempt,
            seq,
            state: state.into(),
            error_code: code.clone(),
            output,
        };
        let sent = match self.report(&r) {
            Ok(_) => true,
            Err(e) => {
                self.on_report_error(e);
                false
            }
        };
        self.states.insert(seq, state.into());
        if let Some(code) = code {
            self.fail(&code);
        } else {
            self.run.steps_done += 1;
        }
        self.save();
        sent
    }

    // ------------------------------------------------------------------------------------- the job
    fn run_to_end(mut self) {
        self.save();
        self.audit(
            "job_started",
            &format!("{} attempt {}", self.c.job.id, self.c.job.attempt),
        );
        match self.c.resume_from {
            // Nothing left to run: what remains is closing (if this computer still holds the profile) and the result.
            None => {
                if self.prepare_quietly() {
                    self.close_step();
                }
                self.finish();
            }
            Some(first) => match self.prepare() {
                Err((code, transient)) => self.give_back(code, transient),
                Ok(()) => {
                    let needs_browser = self
                        .c
                        .steps
                        .iter()
                        .any(|s| s.seq >= first && s.action != "close_profile");
                    let opened = if needs_browser && !self.cancel_wanted() && !self.abandoned() {
                        self.open()
                    } else {
                        if self.cancel_wanted() {
                            self.canceled = true;
                        }
                        Opened::Stop
                    };
                    match opened {
                        Opened::GaveBack => {}
                        Opened::Ready => {
                            self.run_steps(first);
                            self.close_step();
                            self.finish();
                        }
                        Opened::Stop => {
                            self.close_step();
                            self.finish();
                        }
                    }
                }
            },
        }
        self.done();
    }

    /// The local copy of the organization profile, if this computer has one (no restore).
    fn prepare_quietly(&mut self) -> bool {
        let Some(store) = self.store() else {
            return false;
        };
        let link = store
            .org_links(Some(&self.c.job.org_id))
            .unwrap_or_default()
            .into_iter()
            .find(|l| l.org_profile_id == self.c.job.profile_id);
        self.local = link.map(|l| l.local_profile_id);
        self.local.is_some()
    }

    /// Finds the profile on this computer, or restores its newest backup here first (as "Restore here" would).
    /// Errors are a job error code and whether it may work later.
    fn prepare(&mut self) -> Result<(), (&'static str, bool)> {
        let store = self.store().ok_or(("INTERNAL", true))?;
        let (org, prf) = (self.c.job.org_id.clone(), self.c.job.profile_id.clone());
        if self.prepare_quietly() {
            let local = self.local.clone().ok_or(("INTERNAL", false))?;
            let p = store
                .get_profile(&local)
                .ok()
                .flatten()
                .ok_or(("PROFILE_NOT_AVAILABLE", false))?;
            if p.trashed_at.is_some() {
                return Err(("PROFILE_NOT_AVAILABLE", false));
            }
            self.run.profile_id = Some(local.to_string());
            self.save();
            return Ok(());
        }
        let local = match crate::sync::restoring_here(&store, &prf) {
            Some(id) => id,
            None => {
                let name = Some(self.c.job.profile_name.trim())
                    .filter(|n| !n.is_empty())
                    .unwrap_or("Automation profile")
                    .chars()
                    .take(100)
                    .collect::<String>();
                let made = self.app.sync_restore_here(&org, &prf, &name).or_else(|e| {
                    if e.code == ipc::INVALID_LABEL.code {
                        self.app.sync_restore_here(&org, &prf, "Automation profile")
                    } else {
                        Err(e)
                    }
                });
                match made {
                    Ok(view) => ProfileId::parse(&view.id).map_err(|_| ("INTERNAL", false))?,
                    Err(e)
                        if e.code == ipc::CLOUD_OFFLINE.code
                            || e.code == ipc::CLOUD_UNAVAILABLE.code
                            || e.code == ipc::CLOUD_SIGNED_OUT.code =>
                    {
                        return Err(("PROFILE_NOT_AVAILABLE", true));
                    }
                    Err(e) if e.code == ipc::SYNC_FORBIDDEN.code => {
                        return Err(("ACCESS_REMOVED", false));
                    }
                    Err(_) => return Err(("PROFILE_NOT_AVAILABLE", false)),
                }
            }
        };
        self.local = Some(local.clone());
        self.run.profile_id = Some(local.to_string());
        self.save();
        self.audit("restore_here", &self.c.job.id.clone());
        let deadline = Instant::now() + self.t.restore_wait;
        while self.app.sync_restoring(&store, &local) {
            if self.flags.abandon.load(Ordering::SeqCst) || self.cancel_wanted() {
                return Err(("CANCELED", true));
            }
            if Instant::now() >= deadline {
                return Err(("RESTORE_FAILED", true));
            }
            self.app.sync_wake();
            std::thread::sleep(Duration::from_millis(100));
        }
        if store.sync_link(&local).ok().flatten().is_none() {
            return Err(("RESTORE_FAILED", false));
        }
        Ok(())
    }

    /// Nothing ran under this claim: it goes back to the queue (or, for a job that already ran, ends).
    fn give_back(&mut self, code: &'static str, transient: bool) {
        self.run.error_code = Some(code.into());
        if self.abandoned() {
            return;
        }
        let r = if self.c.job.state == "CLAIMED" && !self.started.get() {
            JobReport::Released {
                attempt: self.c.job.attempt,
                error_code: if code == "CANCELED" {
                    "PROFILE_NOT_AVAILABLE".into()
                } else {
                    code.into()
                },
            }
        } else if transient {
            // The server resumes it (safe steps only) or ends it.
            self.silent = Some("DISCONNECTED");
            return;
        } else {
            self.run.outcome = Some("FAILED".into());
            JobReport::Finished {
                attempt: self.c.job.attempt,
                state: "FAILED".into(),
                error_code: Some(code.into()),
            }
        };
        if let Err(e) = self.report(&r) {
            self.on_report_error(e);
        }
    }

    /// Opens the profile under the job's session lease, with the DevTools pipe; reports `started` as soon as the
    /// lease is held and the open step around the launch.
    fn open(&mut self) -> Opened {
        let Some(local) = self.local.clone() else {
            self.give_back("PROFILE_NOT_AVAILABLE", false);
            return Opened::GaveBack;
        };
        let Some(store) = self.store() else {
            self.give_back("INTERNAL", true);
            return Opened::GaveBack;
        };
        let base = self.c.lease_key.clone();
        let ours = |s: &TeamSession| s.open_key.starts_with(&base);
        let mut session = store.team_session(&local).ok().flatten();
        match &session {
            // Someone opened it on this computer, or a session here ended and its notice was not dismissed.
            Some(s) if !ours(s) => {
                let code = if leased(&s.phase) {
                    "PROFILE_IN_USE"
                } else {
                    "PROFILE_NOT_AVAILABLE"
                };
                self.give_back(code, false);
                return Opened::GaveBack;
            }
            Some(s) if !leased(&s.phase) => {
                // This job's session here ended (taken over, access removed).
                self.fail("LEASE_LOST");
                return Opened::Stop;
            }
            _ => {}
        }
        if self.app.supervisor.is_tracked(&local) {
            if session.is_none() {
                self.give_back("PROFILE_IN_USE", false);
                return Opened::GaveBack;
            }
            // This job's browser from before the app restarted: this app cannot drive it any more. It closes
            // (closing backup as usual) and the job continues in a new session, repeating only safe steps.
            match self.close_profile() {
                Closed::LeaseLost => {
                    self.fail("LEASE_LOST");
                    return Opened::Stop;
                }
                Closed::NeedsAttention => {
                    self.fail("BACKUP_PENDING");
                    return Opened::Stop;
                }
                Closed::Committed | Closed::NotNeeded | Closed::Uploading => {}
            }
            session = store
                .team_session(&local)
                .ok()
                .flatten()
                .filter(|s| ours(s));
            if session.as_ref().is_some_and(|s| leased(&s.phase)) {
                self.fail("BACKUP_PENDING");
                return Opened::Stop;
            }
        }
        let key = match &session {
            Some(s) if leased(&s.phase) => s.open_key.clone(),
            _ => lease_key(&base, self.run.opens),
        };
        let open_step = self.step("open_profile");
        let open_seq = open_step.as_ref().map(|s| s.seq);
        let open_pending = open_step
            .as_ref()
            .is_some_and(|s| matches!(self.state_of(s.seq), "pending" | "running"));
        let synced_before = store
            .sync_link(&local)
            .ok()
            .flatten()
            .map(|l| l.synced_version);
        self.run.state = "opening".into();
        self.save();
        if let Ok(mut w) = self.app.automation.wanted.lock() {
            w.insert(local.clone());
        }

        let refused: RefCell<Option<ApiError>> = RefCell::new(None);
        let canceled = Cell::new(false);
        let open_running = Cell::new(false);
        let job_id = self.c.job.id.clone();
        let attempt = self.c.job.attempt;
        let t0 = Instant::now();
        let result = {
            let this = &*self;
            let after = |lease: &str, token: &str| -> Result<(), String> {
                // A later open (after this lease ends) uses a new key; saved before anything else can fail.
                if let Ok(Some(mut r)) = store.automation_run(&job_id)
                    && lease_key(&base, r.opens) == key
                {
                    r.opens += 1;
                    let _ = store.save_automation_run(&r);
                }
                let started = JobReport::Started {
                    attempt,
                    lease_id: lease.to_owned(),
                    fencing_token: token.to_owned(),
                };
                if let Err(e) = this.report(&started) {
                    let code = e.code().to_owned();
                    *refused.borrow_mut() = Some(e);
                    return Err(code);
                }
                this.started.set(true);
                if let (true, Some(seq)) = (open_pending, open_seq) {
                    match this.report(&JobReport::StepStarted { attempt, seq }) {
                        Ok(a) if a.cancel_requested => {
                            canceled.set(true);
                            return Err("CANCELED".into());
                        }
                        Ok(_) => open_running.set(true),
                        Err(e) => {
                            let code = e.code().to_owned();
                            *refused.borrow_mut() = Some(e);
                            return Err(code);
                        }
                    }
                }
                Ok(())
            };
            self.app.open_for_job(
                &local,
                &JobOpen {
                    key: &key,
                    after_lease: &after,
                },
            )
        };
        if let Ok(Some(r)) = store.automation_run(&self.c.job.id) {
            self.run.opens = self.run.opens.max(r.opens);
        }
        let open_failed = |this: &mut Self, code: &str| {
            if let (true, Some(seq)) = (open_running.get(), open_seq) {
                this.step_finished(seq, Err(code.to_owned()));
            } else {
                this.fail(code);
            }
        };
        let op = match result {
            Ok(op) => op,
            Err((code, _)) => {
                self.app.not_wanted(&local);
                if let Some(e) = refused.take() {
                    self.on_report_error(e);
                    return if self.silent.is_some() {
                        Opened::GaveBack
                    } else {
                        Opened::Stop
                    };
                }
                if canceled.get() {
                    self.canceled = true;
                    return Opened::Stop;
                }
                let (job_code, transient) = open_code(code);
                if self.started.get() {
                    // The lease was held but the profile did not open; it was given back.
                    open_failed(self, job_code);
                    return Opened::Stop;
                }
                self.give_back(job_code, transient);
                return Opened::GaveBack;
            }
        };
        let launched = self
            .app
            .ops
            .wait(&op, self.t.open_wait)
            .filter(|o| o.status == OpStatus::Succeeded);
        let ends = launched.and_then(|_| self.app.take_devtools(&local, Duration::from_secs(10)));
        self.app.not_wanted(&local);
        let Some(ends) = ends else {
            open_failed(self, "LAUNCH_FAILED");
            return Opened::Stop;
        };
        let hub = Hub::from(ends);
        self.hub = Some(hub.clone());
        match Page::attach(hub, self.c.allowed_origins.clone()) {
            Ok(page) => self.page = Some(page),
            Err(e) => {
                open_failed(self, e.code());
                return Opened::Stop;
            }
        }
        if let (true, Some(seq)) = (open_running.get(), open_seq) {
            let synced_after = store
                .sync_link(&local)
                .ok()
                .flatten()
                .map(|l| l.synced_version);
            let mut out = json!({
                "restored": synced_after != synced_before,
                "elapsed_ms": elapsed_ms(t0),
            });
            if let Some(v) = self.app.installed_browser(&store).filter(|v| version_ok(v)) {
                out["browser_version"] = json!(v);
            }
            if !self.step_finished(seq, Ok(out)) {
                return Opened::Stop;
            }
        }
        self.run.state = "running".into();
        self.save();
        Opened::Ready
    }

    /// The job's own steps, in order, from `first`.
    fn run_steps(&mut self, first: u32) {
        let steps: Vec<JobStepInfo> = self
            .c
            .steps
            .iter()
            .filter(|s| {
                s.seq >= first
                    && !matches!(s.action.as_str(), "open_profile" | "close_profile")
                    && matches!(self.state_of(s.seq), "pending" | "running")
            })
            .cloned()
            .collect();
        for s in steps {
            if self.abandoned() || self.failure.is_some() || self.canceled {
                break;
            }
            if self.cancel_wanted() {
                self.canceled = true;
                break;
            }
            if s.effect == "external_mutation" {
                // Never repeated blindly, and not supported by this version.
                self.fail("INTERNAL");
                break;
            }
            let attempt = self.c.job.attempt;
            match self.report(&JobReport::StepStarted {
                attempt,
                seq: s.seq,
            }) {
                Ok(a) if a.cancel_requested && s.action != "hold_open" => {
                    self.canceled = true;
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    self.on_report_error(e);
                    break;
                }
            }
            self.states.insert(s.seq, "running".into());
            let result = self.run_step(&s);
            if self.abandoned() {
                break;
            }
            let result = result.map_err(|code| {
                // A browser that closed because the session ended reports the real reason.
                if code == "BROWSER_CLOSED" && self.session_ended() {
                    "LEASE_LOST".to_owned()
                } else {
                    code
                }
            });
            if !self.step_finished(s.seq, result) {
                break;
            }
        }
    }

    fn session_ended(&self) -> bool {
        let (Some(store), Some(local)) = (self.store(), self.local.as_ref()) else {
            return false;
        };
        store
            .team_session(local)
            .ok()
            .flatten()
            .is_some_and(|s| matches!(s.phase.as_str(), "taken_over" | "revoked"))
    }

    fn run_step(&mut self, s: &JobStepInfo) -> Result<Value, String> {
        let t0 = Instant::now();
        let input = &s.input;
        let page = || {
            self.page
                .as_ref()
                .ok_or_else(|| "BROWSER_CLOSED".to_owned())
        };
        match s.action.as_str() {
            "open_url" => {
                let url = input.get("url").and_then(Value::as_str).ok_or("INTERNAL")?;
                let ms = input
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(30_000)
                    .clamp(1_000, 60_000);
                let o = page()?
                    .open_url(url, Duration::from_millis(ms))
                    .map_err(|e| e.code().to_owned())?;
                let mut out = json!({
                    "final_origin": o.final_origin.chars().take(300).collect::<String>(),
                    "elapsed_ms": o.elapsed_ms.min(86_400_000),
                });
                if let Some(status) = o.http_status {
                    out["http_status"] = json!(status);
                }
                Ok(out)
            }
            "wait_for" => {
                let condition = input
                    .get("condition")
                    .and_then(Condition::from_json)
                    .ok_or("INTERNAL")?;
                let ms = input
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(15_000)
                    .clamp(100, 120_000);
                let waited = page()?
                    .wait_for(&condition, Duration::from_millis(ms))
                    .map_err(|e| e.code().to_owned())?;
                Ok(json!({ "elapsed_ms": waited.min(86_400_000) }))
            }
            "screenshot" => {
                let shot = page()?
                    .screenshot(MAX_ARTIFACT_BYTES)
                    .map_err(|e| e.code().to_owned())?;
                let id = self.upload(s.seq, &shot)?;
                Ok(json!({
                    "artifact_id": id,
                    "width": shot.width,
                    "height": shot.height,
                    "elapsed_ms": elapsed_ms(t0),
                }))
            }
            "debug_bridge" => self.debug_bridge(),
            "hold_open" => self.hold(),
            _ => Err("INTERNAL".into()),
        }
    }

    fn upload(&self, seq: u32, shot: &Shot) -> Result<String, String> {
        let mut tries = 0;
        loop {
            let r = self
                .app
                .with_automation(|api| {
                    api.upload_artifact(
                        &self.c.job.org_id,
                        &self.c.job.id,
                        seq,
                        self.c.job.attempt,
                        shot.width,
                        shot.height,
                        &shot.jpeg,
                    )
                })
                .unwrap_or(Err(ApiError::SignedOut));
            match r {
                Ok(id) if id_ok("art", &id) => return Ok(id),
                Err(e) if transient(&e) && tries + 1 < self.t.report_tries => {
                    tries += 1;
                    std::thread::sleep(self.t.report_retry);
                }
                _ => return Err("INTERNAL".into()),
            }
        }
    }

    /// Hands the session to a Playwright script on this computer through the authenticated loopback broker. Needs
    /// "Allow Playwright connections" here; the capability secret stays with the requester (only its digest is in
    /// the job).
    fn debug_bridge(&mut self) -> Result<Value, String> {
        let store = self.store().ok_or("INTERNAL")?;
        if !debugging_allowed(&store) {
            return Err("DEBUG_NOT_ALLOWED".into());
        }
        let digest = self
            .c
            .debug_capability_sha256
            .as_deref()
            .filter(|h| h.len() == 64)
            .and_then(|h| hex::decode(h).ok())
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or("DEBUG_NOT_ALLOWED")?;
        let hub = self.hub.clone().ok_or("BROWSER_CLOSED")?;
        // The job's own tab session ends; the script gets the connection.
        if let Some(p) = self.page.take() {
            p.detach();
        }
        let broker = Broker::start(
            hub,
            BrokerConfig {
                job_id: self.c.job.id.clone(),
                capability_sha256: digest,
                connect_within: self.t.debug_connect,
            },
        )
        .map_err(|_| "INTERNAL")?;
        let endpoint = broker.endpoint();
        self.audit(
            "debugging_opened",
            &format!("{} 127.0.0.1:{}", self.c.job.id, broker.port()),
        );
        self.broker = Some(broker);
        self.run.debug_endpoint = Some(endpoint.clone());
        self.save();
        Ok(json!({ "endpoint": endpoint }))
    }

    fn end_debugging(&mut self) {
        if let Some(b) = self.broker.take() {
            b.stop();
            let commands = self.hub.as_ref().map(Hub::relayed).unwrap_or(0);
            let connections = b.connections.load(Ordering::SeqCst);
            self.audit(
                "debugging_closed",
                &format!(
                    "{} connections {connections} commands {commands}",
                    self.c.job.id
                ),
            );
            self.run.debug_endpoint = None;
        }
    }

    /// Keeps the profile open until the job is stopped, its time is up, or the browser is closed here.
    fn hold(&mut self) -> Result<Value, String> {
        let t0 = Instant::now();
        let minutes = self.c.job.keep_open_minutes.unwrap_or(1).clamp(1, 480);
        let limit = self.t.minute * minutes;
        self.run.state = "holding".into();
        self.save();
        let mut checked = Instant::now();
        loop {
            if self.cancel_wanted() || self.flags.abandon.load(Ordering::SeqCst) {
                break;
            }
            if self.hub.as_ref().is_none_or(Hub::is_closed) || t0.elapsed() >= limit {
                break;
            }
            if checked.elapsed() >= Duration::from_secs(1) {
                checked = Instant::now();
                if self.session_ended() {
                    self.end_debugging();
                    return Err("LEASE_LOST".into());
                }
                if self.broker.is_some() && !self.store().is_some_and(|s| debugging_allowed(&s)) {
                    // Turned off here: the debugging session ends; the profile stays open for its time.
                    self.end_debugging();
                    self.save();
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.end_debugging();
        // Ended by the person at this computer: the job is canceled (the organization's stop ends a holding job
        // as succeeded).
        if self.flags.by_person.load(Ordering::SeqCst) {
            self.canceled = true;
        }
        self.run.state = "running".into();
        self.save();
        Ok(json!({ "elapsed_ms": elapsed_ms(t0) }))
    }

    /// The close step: closes the profile (closing backup and handoff as for a person) and reports how.
    fn close_step(&mut self) {
        self.end_debugging();
        self.page = None;
        let step = self.step("close_profile");
        let attempt = self.c.job.attempt;
        let mut reporting = false;
        if let Some(s) = &step
            && matches!(self.state_of(s.seq), "pending" | "running")
            && !self.abandoned()
        {
            match self.report(&JobReport::StepStarted {
                attempt,
                seq: s.seq,
            }) {
                Ok(_) => {
                    reporting = true;
                    // Steps that never ran are skipped (the server does the same).
                    for (seq, state) in self.states.iter_mut() {
                        if *seq < s.seq && state == "pending" {
                            *state = "skipped".into();
                        }
                    }
                }
                Err(e) => self.on_report_error(e),
            }
        }
        self.run.state = "closing".into();
        self.save();
        let t0 = Instant::now();
        let closed = self.close_profile();
        let result = match closed {
            Closed::Committed => Ok("committed"),
            Closed::NotNeeded => Ok("not_needed"),
            Closed::Uploading => Ok("pending"),
            Closed::NeedsAttention => Err(("BACKUP_PENDING", Some("pending"))),
            Closed::LeaseLost => Err(("LEASE_LOST", None)),
        };
        let Some(s) = step else {
            if let Err((code, _)) = result {
                self.fail(code);
            }
            return;
        };
        if !reporting {
            if let Err((code, _)) = result {
                self.fail(code);
            }
            return;
        }
        let (state, code, output) = match result {
            Ok(backup) => (
                "succeeded",
                None,
                json!({ "backup": backup, "elapsed_ms": elapsed_ms(t0) }),
            ),
            Err((code, backup)) => {
                let mut out = json!({ "elapsed_ms": elapsed_ms(t0) });
                if let Some(b) = backup {
                    out["backup"] = json!(b);
                }
                ("failed", Some(code.to_owned()), out)
            }
        };
        let r = JobReport::StepFinished {
            attempt,
            seq: s.seq,
            state: state.into(),
            error_code: code.clone(),
            output: Some(output),
        };
        if let Err(e) = self.report(&r) {
            self.on_report_error(e);
        }
        self.states.insert(s.seq, state.into());
        match code {
            Some(c) => self.fail(&c),
            None => self.run.steps_done += 1,
        }
        self.save();
    }

    /// Closes the profile if this job holds it here, then waits for its closing backup.
    fn close_profile(&mut self) -> Closed {
        let (Some(local), Some(store)) = (self.local.clone(), self.store()) else {
            return Closed::NotNeeded;
        };
        let base = self.c.lease_key.clone();
        let ours = |s: &TeamSession| s.open_key.starts_with(&base);
        let session = store
            .team_session(&local)
            .ok()
            .flatten()
            .filter(|s| ours(s));
        let tracked = self.app.supervisor.is_tracked(&local);
        if let Some(s) = &session
            && matches!(s.phase.as_str(), "taken_over" | "revoked")
        {
            // The session closes the browser itself and keeps this copy aside.
            self.hub = None;
            self.wait_closed(&local, self.t.stop_wait);
            return Closed::LeaseLost;
        }
        let held = session.as_ref().is_some_and(|s| leased(&s.phase));
        if !held && !(tracked && self.hub.is_some()) {
            return Closed::NotNeeded;
        }
        if tracked {
            if held {
                let _ = self.app.team_close(&local, None);
            } else {
                let _ = self.app.stop_profile(&local, false);
            }
            if !self.wait_closed(&local, self.t.stop_wait) {
                let _ = self.app.stop_profile(&local, true);
                self.wait_closed(&local, Duration::from_secs(10));
            }
        } else if session.as_ref().is_some_and(|s| s.phase == "lost") {
            // Closed while the connection was lost: the handoff starts now.
            let _ = self.app.team_close(&local, None);
        }
        self.hub = None;
        if !held {
            return Closed::NotNeeded;
        }
        let deadline = Instant::now() + self.t.close_wait;
        loop {
            match store.team_session(&local).ok().flatten() {
                None => return Closed::Committed,
                Some(s) if !ours(&s) => return Closed::Committed,
                Some(s) if matches!(s.phase.as_str(), "taken_over" | "revoked") => {
                    return Closed::LeaseLost;
                }
                Some(s) if s.phase == "pending" => return Closed::NeedsAttention,
                Some(_) => {}
            }
            if Instant::now() >= deadline {
                return Closed::Uploading;
            }
            self.app.sync_wake();
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_closed(&self, local: &ProfileId, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while self.app.supervisor.is_tracked(local) {
            if Instant::now() >= deadline {
                return false;
            }
            self.app.poll_once();
            std::thread::sleep(Duration::from_millis(50));
        }
        true
    }

    /// The job's result, from what ran here and what the claim said ran before.
    fn outcome(&self) -> (&'static str, Option<String>) {
        if self.canceled {
            return ("CANCELED", Some("CANCELED".into()));
        }
        if let Some(f) = &self.failure {
            return ("FAILED", Some(f.clone()));
        }
        let mut steps: Vec<&JobStepInfo> = self.c.steps.iter().collect();
        steps.sort_by_key(|s| s.seq);
        for s in steps {
            match self.state_of(s.seq) {
                "succeeded" | "skipped" => {}
                "outcome_unknown" => return ("FAILED", Some("OUTCOME_UNKNOWN".into())),
                "canceled" => return ("CANCELED", Some("CANCELED".into())),
                "failed" => {
                    return (
                        "FAILED",
                        Some(s.error_code.clone().unwrap_or_else(|| "INTERNAL".into())),
                    );
                }
                // Did not run (stopped before it): a person's stop or a cancel.
                _ if self.cancel_wanted() => return ("CANCELED", Some("CANCELED".into())),
                _ => return ("FAILED", Some("INTERNAL".into())),
            }
        }
        ("SUCCEEDED", None)
    }

    fn finish(&mut self) {
        let (state, code) = self.outcome();
        self.run.outcome = Some(state.into());
        self.run.error_code = code.clone();
        if self.abandoned() {
            return;
        }
        let attempt = self.c.job.attempt;
        let r = JobReport::Finished {
            attempt,
            state: state.into(),
            error_code: code,
        };
        match self.report(&r) {
            Ok(_) => {}
            Err(e) if e.is_code("JOB_FINISHED") => {}
            Err(e) if e.is_code("VALIDATION_FAILED") && state == "SUCCEEDED" => {
                // The server does not agree every step succeeded: the job fails instead.
                self.run.outcome = Some("FAILED".into());
                self.run.error_code = Some("INTERNAL".into());
                let r = JobReport::Finished {
                    attempt,
                    state: "FAILED".into(),
                    error_code: Some("INTERNAL".into()),
                };
                if let Err(e) = self.report(&r) {
                    self.on_report_error(e);
                }
            }
            Err(e) => self.on_report_error(e),
        }
    }

    fn done(mut self) {
        if let Some(local) = self.local.clone() {
            self.app.not_wanted(&local);
            // Never leave this job's browser open (a stop that skipped the close step).
            if self.hub.is_some() && self.app.supervisor.is_tracked(&local) {
                self.close_profile();
            }
        }
        self.end_debugging();
        if let Some(s) = self.silent {
            // The server has (or will have) the job's result; this computer did not report one.
            self.run.outcome = None;
            self.run.error_code = Some(s.into());
        }
        self.run.state = "done".into();
        self.save();
        let what = match (self.silent, self.run.outcome.as_deref()) {
            (Some("ABANDONED"), _) => "job_abandoned",
            (Some("DISCONNECTED"), _) => "job_disconnected",
            (Some(_), _) => "job_ended_elsewhere",
            (None, Some("SUCCEEDED")) => "job_succeeded",
            (None, Some("CANCELED")) => "job_canceled",
            (None, Some(_)) => "job_failed",
            (None, None) => "job_released",
        };
        let detail = format!(
            "{} {}",
            self.c.job.id,
            self.run.error_code.as_deref().unwrap_or("")
        );
        self.audit(what, detail.trim_end());
    }
}

/// A failed open, as a job error code and whether it may work later.
fn open_code(code: &str) -> (&'static str, bool) {
    match code {
        "PROFILE_IN_USE_ELSEWHERE"
        | "PROFILE_SESSION_UNCERTAIN"
        | "PROFILE_BUSY"
        | "PROFILE_STOPPING"
        | "PROFILE_IN_USE"
        | "PROFILE_STARTING" => ("PROFILE_IN_USE", false),
        "SHARED_OFFLINE" | "CLOUD_SIGNED_OUT" | "CLOUD_UNAVAILABLE" | "CLOUD_OFFLINE" => {
            ("PROFILE_NOT_AVAILABLE", true)
        }
        "NO_ACCESS" | "ENTITLEMENT_REQUIRED" => ("ACCESS_REMOVED", false),
        "RUNTIME_TOO_OLD" | "PROFILE_NEWER_THAN_RUNTIME" => ("UNSUPPORTED_BROWSER", false),
        "SESSION_RESTORE_FAILED" => ("RESTORE_FAILED", false),
        "PROFILE_RESTORING" | "SYNC_NOT_LINKED" | "SYNC_CONFLICT_OPEN" | "SESSION_ENDED"
        | "PROFILE_IN_TRASH" | "UNKNOWN_PROFILE" => ("PROFILE_NOT_AVAILABLE", false),
        _ => ("LAUNCH_FAILED", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_keys_repeat_for_retries_and_change_for_reopens() {
        let base = "job_01J9ZSEED0000000000000JOB1-agt_01J9ZSEED0000000000000AGT1";
        assert_eq!(lease_key(base, 0), base);
        assert_eq!(lease_key(base, 2), format!("{base}-r2"));
        assert!(lease_key(base, 3).starts_with(base));
        assert!(lease_key(base, 1000).len() <= 128);
    }

    #[test]
    fn open_failures_map_to_job_codes() {
        assert_eq!(
            open_code("PROFILE_IN_USE_ELSEWHERE"),
            ("PROFILE_IN_USE", false)
        );
        assert_eq!(open_code("SHARED_OFFLINE"), ("PROFILE_NOT_AVAILABLE", true));
        assert_eq!(open_code("NO_ACCESS"), ("ACCESS_REMOVED", false));
        assert_eq!(
            open_code("SESSION_RESTORE_FAILED"),
            ("RESTORE_FAILED", false)
        );
        assert_eq!(open_code("SOMETHING_NEW"), ("LAUNCH_FAILED", false));
        assert!(version_ok("155.0.8059.39") && !version_ok("155 beta") && !version_ok(""));
    }
}
