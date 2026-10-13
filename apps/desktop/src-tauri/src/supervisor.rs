//! Process supervisor (milestone 03, steps 2–6): keeps every profile's run state true to reality, whether or not
//! the manager window is open.
//!
//! - A profile is tracked from the moment its launch is accepted (STARTING, profile lock held) until all of its
//!   browser processes have exited (STOPPED/CRASHED, lock released).
//! - Processes are identified by (pid, OS start time, executable), never by pid alone. Helper processes are found by
//!   walking the process tree from the browser main process, so closing one profile never touches another's.
//! - "Ready" (the browser has started its helper processes) is tracked separately from "window open" (at least one
//!   renderer).
//! - A run ends only after the main process AND its helpers are gone ("wait for all writers"), or after
//!   [`QUIESCE_TIMEOUT`]. Clean vs. crashed comes from Chromium's own exit record.
//! - Stopping is graceful first. If the browser does not exit within the timeout the user is offered an explicit
//!   force close; nothing is force-killed silently.
//! - On manager start, recorded runs are re-checked: a still-running verified browser is adopted (its lock
//!   re-acquired), a vanished one is closed with the outcome Chromium recorded, and interrupted starts/recoveries
//!   are surfaced. An unrelated process is never adopted or signalled.

use pb_runtime::procs::{self, TreeFacts};
use pb_runtime::{
    ProcRecord, ProcessInspector, ProfileId, ProfileLock, ProfilesRoot, RunEvent, RunState,
    Spawned, prefs,
};
use pb_storage::LocalStore;
use pb_storage::runs::{RunOutcome, StartIdentity};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for helper processes after the main process exited.
pub const QUIESCE_TIMEOUT: Duration = Duration::from_secs(15);
/// A browser that never reports ready is shown as running (not ready) after this long.
pub const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// A non-clean exit within this window after spawn is an early exit (broken runtime, corrupt profile, ...).
pub const EARLY_EXIT: Duration = Duration::from_secs(10);

struct PendingExit {
    at: Instant,
    clean: bool,
    exit_code: Option<i64>,
    forced: bool,
    early: bool,
}

struct Tracked {
    run_id: Option<String>,
    pid: Option<u32>,
    identity: StartIdentity,
    child: Option<Child>,
    _lock: ProfileLock,
    state: RunState,
    adopted: bool,
    spawned_at: Option<Instant>,
    accepted_at: Instant,
    ready: bool,
    window_open: bool,
    helpers: usize,
    /// Last seen helper processes: (pid, start time). Used to wait for writers and for a forced close.
    tree: Vec<(u32, u64)>,
    force_available: bool,
    user_data: PathBuf,
    runtime_version: Option<String>,
    start_op: Option<String>,
    exit: Option<PendingExit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TreeUsage {
    pub profile_id: ProfileId,
    pub processes: usize,
    pub memory_bytes: u64,
    pub open_seconds: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ResourceUsage {
    pub profiles: Vec<TreeUsage>,
    pub manager_processes: usize,
    pub manager_memory_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunningProfile {
    pub profile_id: String,
    pub run_id: Option<String>,
    pub pid: Option<u32>,
    pub state: RunState,
    /// True if the process was already running when this manager instance started.
    pub adopted: bool,
    pub ready: bool,
    pub window_open: bool,
    pub helpers: usize,
    /// Graceful close timed out: the UI offers an explicit force close.
    pub force_available: bool,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct ReconcileReport {
    pub adopted: u32,
    pub cleared: u32,
    pub interrupted: u32,
    pub orphans_adopted: u32,
}

#[derive(Debug)]
pub enum PollEvent {
    Ready {
        profile: ProfileId,
        start_op: Option<String>,
    },
    Finished(Finished),
}

#[derive(Debug, Clone)]
pub struct Finished {
    pub profile: ProfileId,
    pub run_id: Option<String>,
    pub outcome: RunOutcome,
    pub state: RunState,
    pub start_op: Option<String>,
    pub user_data: PathBuf,
    pub runtime_version: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartConflict {
    /// Already starting or running: a repeated click returns the existing launch.
    AlreadyActive {
        start_op: Option<String>,
    },
    Stopping,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StopError {
    NotRunning,
    /// The browser has not been created yet (e.g. a backup before an engine upgrade is still running).
    NotStartedYet,
}

pub struct Supervisor {
    tracked: Mutex<HashMap<ProfileId, Tracked>>,
    busy: Mutex<HashSet<ProfileId>>,
    inspector: Arc<dyn ProcessInspector>,
}

fn identity_matches(p: &ProcRecord, pid: u32, start: u64) -> bool {
    p.pid == pid && p.start_time.abs_diff(start) <= 2
}

impl Supervisor {
    pub fn new(inspector: Arc<dyn ProcessInspector>) -> Self {
        Self {
            tracked: Mutex::new(HashMap::new()),
            busy: Mutex::new(HashSet::new()),
            inspector,
        }
    }

    pub fn inspector(&self) -> &Arc<dyn ProcessInspector> {
        &self.inspector
    }

    // ------------------------------------------------------------------------- busy (backup / recovery)
    /// Marks a profile busy for a backup or recovery. Fails if it is tracked or already busy.
    pub fn try_busy(&self, id: &ProfileId) -> bool {
        let tracked = self.is_tracked(id);
        match self.busy.lock() {
            Ok(mut b) if !tracked => b.insert(id.clone()),
            _ => false,
        }
    }

    pub fn clear_busy(&self, id: &ProfileId) {
        if let Ok(mut b) = self.busy.lock() {
            b.remove(id);
        }
    }

    pub fn is_busy(&self, id: &ProfileId) -> bool {
        self.busy.lock().map(|b| b.contains(id)).unwrap_or(true)
    }

    /// Profiles currently busy with a backup or a recovery.
    pub fn busy_profiles(&self) -> Vec<ProfileId> {
        self.busy
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    // ------------------------------------------------------------------------- launch
    /// Starts tracking an accepted launch (STARTING, no process yet). The caller holds `lock`.
    pub fn begin_start(
        &self,
        id: &ProfileId,
        lock: ProfileLock,
        user_data: PathBuf,
        runtime_version: Option<String>,
        start_op: String,
    ) -> Result<(), StartConflict> {
        let Ok(mut tracked) = self.tracked.lock() else {
            return Err(StartConflict::Stopping);
        };
        if let Some(t) = tracked.get(id) {
            return Err(match t.state {
                RunState::Stopping => StartConflict::Stopping,
                _ => StartConflict::AlreadyActive {
                    start_op: t.start_op.clone(),
                },
            });
        }
        tracked.insert(
            id.clone(),
            Tracked {
                run_id: None,
                pid: None,
                identity: StartIdentity::default(),
                child: None,
                _lock: lock,
                state: RunState::Starting,
                adopted: false,
                spawned_at: None,
                accepted_at: Instant::now(),
                ready: false,
                window_open: false,
                helpers: 0,
                tree: vec![],
                force_available: false,
                user_data,
                runtime_version,
                start_op: Some(start_op),
                exit: None,
            },
        );
        Ok(())
    }

    /// Returns the existing launch operation if the profile is already starting or running.
    pub fn active_start(&self, id: &ProfileId) -> Option<Result<Option<String>, StartConflict>> {
        let tracked = self.tracked.lock().ok()?;
        let t = tracked.get(id)?;
        Some(match t.state {
            RunState::Stopping => Err(StartConflict::Stopping),
            _ => Ok(t.start_op.clone()),
        })
    }

    /// Records the spawned process (the run row is written before the UI hears about it).
    pub fn attach_spawn(
        &self,
        store: &LocalStore,
        id: &ProfileId,
        spawned: Spawned,
        exe: &Path,
    ) -> Result<String, pb_storage::StoreError> {
        let info = self.inspector.inspect(spawned.pid);
        let identity = StartIdentity {
            start_time: info.as_ref().map(|i| i.start_time),
            exe: Some(exe.to_string_lossy().into_owned()),
        };
        let version = self
            .tracked
            .lock()
            .ok()
            .and_then(|t| t.get(id).and_then(|t| t.runtime_version.clone()));
        let run_id = store.begin_run(
            id,
            spawned.pid,
            &identity,
            version.as_deref(),
            RunState::Starting,
        )?;
        let _ = store.audit(Some(id), "start", "spawned", Some(&run_id), None);
        if let Ok(mut tracked) = self.tracked.lock()
            && let Some(t) = tracked.get_mut(id)
        {
            t.run_id = Some(run_id.clone());
            t.pid = Some(spawned.pid);
            t.identity = identity;
            t.child = spawned.child;
            t.spawned_at = Some(Instant::now());
        }
        Ok(run_id)
    }

    /// A launch failed before a process existed: stop tracking and release the lock.
    pub fn abort_start(&self, store: &LocalStore, id: &ProfileId, code: &str) {
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.remove(id);
        }
        let _ = store.set_run_state(id, RunState::Stopped, Some(Some(code)));
        let _ = store.audit(Some(id), "start", "failed", None, Some(code));
    }

    /// Takes over a verified browser that is already running for this profile (manager restarted or crashed).
    #[allow(clippy::too_many_arguments)]
    pub fn adopt(
        &self,
        store: &LocalStore,
        id: &ProfileId,
        lock: ProfileLock,
        pid: u32,
        identity: StartIdentity,
        user_data: PathBuf,
        runtime_version: Option<String>,
        existing_run: Option<String>,
    ) -> Result<(), pb_storage::StoreError> {
        let run_id = match existing_run {
            Some(r) => {
                store.set_run_state(id, RunState::Running, None)?;
                r
            }
            None => store.begin_run(
                id,
                pid,
                &identity,
                runtime_version.as_deref(),
                RunState::Running,
            )?,
        };
        let _ = store.audit(Some(id), "adopt", "running", Some(&run_id), None);
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.insert(
                id.clone(),
                Tracked {
                    run_id: Some(run_id),
                    pid: Some(pid),
                    identity,
                    child: None,
                    _lock: lock,
                    state: RunState::Running,
                    adopted: true,
                    spawned_at: None,
                    accepted_at: Instant::now(),
                    ready: true,
                    window_open: false,
                    helpers: 0,
                    tree: vec![],
                    force_available: false,
                    user_data,
                    runtime_version,
                    start_op: None,
                    exit: None,
                },
            );
        }
        Ok(())
    }

    // ------------------------------------------------------------------------- start-up reconciliation
    /// Rebuilds the process table after a manager restart or crash. `trusted_exes` are the runtime executables this
    /// manager may have launched; only those are adopted when no run was recorded.
    pub fn reconcile_on_startup(
        &self,
        store: &LocalStore,
        root: &ProfilesRoot,
        trusted_exes: &[PathBuf],
    ) -> ReconcileReport {
        let mut report = ReconcileReport::default();
        let snapshot = self.inspector.snapshot();
        let mut handled: HashSet<ProfileId> = HashSet::new();

        for run in store.active_runs().unwrap_or_default() {
            let id = run.profile_id.clone();
            handled.insert(id.clone());
            let dirs = root.dirs(&id);
            let stored_state = store
                .get_profile(&id)
                .ok()
                .flatten()
                .map(|p| p.state)
                .unwrap_or(RunState::Running);
            let alive = self.inspector.is_same(
                run.pid,
                run.identity.start_time,
                run.identity.exe.as_deref(),
            );
            let lock = alive
                .then(|| ProfileLock::try_acquire(&dirs.root).ok().flatten())
                .flatten();
            if let Some(lock) = lock {
                let version = run.runtime_version.clone();
                if self
                    .adopt(
                        store,
                        &id,
                        lock,
                        run.pid,
                        run.identity.clone(),
                        dirs.user_data.clone(),
                        version,
                        Some(run.run_id.clone()),
                    )
                    .is_ok()
                {
                    report.adopted += 1;
                }
                continue;
            }
            // The browser is gone (or the pid now belongs to something else): close the run without signalling.
            let record = prefs::exit_record(&dirs.user_data);
            let (outcome, state, error) = match (stored_state, &record) {
                (RunState::Starting, _) => (
                    RunOutcome::Interrupted,
                    RunState::Stopped,
                    Some("START_INTERRUPTED"),
                ),
                (_, Some(r)) if r.clean => (RunOutcome::Clean, RunState::Stopped, None),
                (RunState::Stopping, _) => (RunOutcome::Lost, RunState::Stopped, None),
                (_, Some(_)) => (
                    RunOutcome::Crashed,
                    RunState::Crashed,
                    Some("CRASHED_WHILE_MANAGER_CLOSED"),
                ),
                (_, None) => (RunOutcome::Lost, RunState::Stopped, None),
            };
            let _ = store.end_run(&run.run_id, outcome, None, state, error);
            let _ = store.audit(
                Some(&id),
                "interrupted",
                outcome.as_str(),
                Some(&run.run_id),
                error,
            );
            report.cleared += 1;
        }

        // States left behind without a run (manager died before spawning, or during a recovery).
        let stale = [
            RunState::Starting,
            RunState::Running,
            RunState::Stopping,
            RunState::Recovering,
        ];
        for (id, state) in store.profiles_in_states(&stale).unwrap_or_default() {
            if handled.contains(&id) {
                continue;
            }
            let (to, error) = match state.next(RunEvent::Interrupted) {
                Ok(RunState::Crashed) => (RunState::Crashed, Some("RECOVERY_INTERRUPTED")),
                _ if state == RunState::Starting => (RunState::Stopped, Some("START_INTERRUPTED")),
                _ => (RunState::Stopped, None),
            };
            let _ = store.set_run_state(&id, to, Some(error));
            let _ = store.audit(Some(&id), "interrupted", to.as_str(), None, error);
            report.interrupted += 1;
        }

        // Browsers running on one of our profile directories with no run recorded (the manager died between
        // spawning and recording). Adopt only if the executable is one of our runtimes.
        let prefix = procs::user_data_flag(root.path())
            .to_string_lossy()
            .into_owned();
        for p in &snapshot {
            if p.args.iter().any(|a| a.starts_with("--type=")) {
                continue;
            }
            let Some(arg) = p.args.iter().find(|a| a.starts_with(&prefix)) else {
                continue;
            };
            let rest = arg[prefix.len()..].trim_start_matches(['/', '\\']);
            let Some(id) = rest
                .split(['/', '\\'])
                .next()
                .and_then(|s| ProfileId::parse(s).ok())
            else {
                continue;
            };
            if self.is_tracked(&id) || store.get_profile(&id).ok().flatten().is_none() {
                continue;
            }
            let dirs = root.dirs(&id);
            let expected = procs::user_data_flag(&dirs.user_data)
                .to_string_lossy()
                .into_owned();
            if arg != &expected
                || !trusted_exes
                    .iter()
                    .any(|e| procs::same_executable(p.exe.as_deref(), e))
            {
                continue;
            }
            let Ok(Some(lock)) = ProfileLock::try_acquire(&dirs.root) else {
                continue;
            };
            let identity = StartIdentity {
                start_time: Some(p.start_time),
                exe: p.exe.as_ref().map(|e| e.to_string_lossy().into_owned()),
            };
            if self
                .adopt(
                    store,
                    &id,
                    lock,
                    p.pid,
                    identity,
                    dirs.user_data.clone(),
                    None,
                    None,
                )
                .is_ok()
            {
                report.orphans_adopted += 1;
            }
        }
        report
    }

    // ------------------------------------------------------------------------- monitoring
    /// One monitoring pass. Returns readiness changes and finished runs for the caller to act on.
    pub fn poll(&self, store: &LocalStore) -> Vec<PollEvent> {
        let has_processes = self
            .tracked
            .lock()
            .map(|t| t.values().any(|x| x.pid.is_some()))
            .unwrap_or(false);
        if !has_processes {
            return vec![];
        }
        let snapshot = self.inspector.snapshot();
        let Ok(mut tracked) = self.tracked.lock() else {
            return vec![];
        };
        let mut events = vec![];
        let mut done = vec![];
        for (id, t) in tracked.iter_mut() {
            let Some(pid) = t.pid else { continue };

            if t.exit.is_none() {
                let (alive, code) = match t.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(None) => (true, None),
                        Ok(Some(status)) => (false, exit_code(status)),
                        Err(_) => (false, None),
                    },
                    None => (
                        self.inspector.is_same(
                            pid,
                            t.identity.start_time,
                            t.identity.exe.as_deref(),
                        ),
                        None,
                    ),
                };
                if alive {
                    let facts = procs::tree_facts(&snapshot, pid);
                    t.tree = procs::descendants(&snapshot, pid)
                        .iter()
                        .map(|p| (p.pid, p.start_time))
                        .collect();
                    update_facts(store, id, t, &facts, &mut events);
                    continue;
                }
                // A process we started reports its exit status: only status 0 is an orderly exit (a signal or
                // non-zero code is a crash, even if Chromium's last saved exit record is from an earlier clean
                // run). For re-attached processes the status is unknown and Chromium's exit record decides.
                let clean = match code {
                    Some(c) => c == 0,
                    None => prefs::exit_record(&t.user_data).is_some_and(|r| r.clean),
                };
                t.exit = Some(PendingExit {
                    at: Instant::now(),
                    clean,
                    exit_code: code,
                    forced: false,
                    // An exit the user asked for is never an "early exit", however quick.
                    early: t.state == RunState::Starting
                        || (t.state != RunState::Stopping
                            && t.spawned_at.is_some_and(|s| s.elapsed() < EARLY_EXIT)),
                });
            }

            // Main process gone: wait until every helper (writer) has exited too.
            let Some(exit) = &t.exit else { continue };
            let lingering = t
                .tree
                .iter()
                .any(|(hp, hs)| snapshot.iter().any(|p| identity_matches(p, *hp, *hs)));
            if lingering && exit.at.elapsed() < QUIESCE_TIMEOUT {
                continue;
            }
            done.push(id.clone());
        }

        for id in done {
            let Some(t) = tracked.remove(&id) else {
                continue;
            };
            let Some(exit) = &t.exit else { continue };
            let (outcome, event) = if exit.forced {
                (RunOutcome::Forced, RunEvent::ForceStopped)
            } else if exit.clean {
                (RunOutcome::Clean, RunEvent::Exited { clean: true })
            } else if exit.early {
                (RunOutcome::EarlyExit, RunEvent::Exited { clean: false })
            } else {
                (RunOutcome::Crashed, RunEvent::Exited { clean: false })
            };
            let state = t.state.next(event).unwrap_or(RunState::Stopped);
            let error = match (state, outcome) {
                (RunState::Crashed, RunOutcome::EarlyExit) => Some("EXITED_EARLY"),
                (RunState::Crashed, _) => Some("CRASHED"),
                _ => None,
            };
            if let Some(run) = &t.run_id {
                let _ = store.end_run(run, outcome, exit.exit_code, state, error);
            } else {
                let _ = store.set_run_state(&id, state, Some(error));
            }
            let action = if state == RunState::Crashed {
                "crash"
            } else {
                "exit"
            };
            let _ = store.audit(
                Some(&id),
                action,
                outcome.as_str(),
                t.run_id.as_deref(),
                error,
            );
            events.push(PollEvent::Finished(Finished {
                profile: id.clone(),
                run_id: t.run_id.clone(),
                outcome,
                state,
                start_op: t.start_op.clone(),
                user_data: t.user_data.clone(),
                runtime_version: t.runtime_version.clone(),
            }));
            // `t` (and its profile lock) is dropped here.
        }
        events
    }

    // ------------------------------------------------------------------------- stopping
    /// Asks the browser to close (SIGTERM on macOS/Linux, WM_CLOSE on Windows). Returns false if already exiting.
    pub fn request_stop(&self, store: &LocalStore, id: &ProfileId) -> Result<bool, StopError> {
        let pid = {
            let Ok(mut tracked) = self.tracked.lock() else {
                return Err(StopError::NotRunning);
            };
            let t = tracked.get_mut(id).ok_or(StopError::NotRunning)?;
            let pid = t.pid.ok_or(StopError::NotStartedYet)?;
            if t.exit.is_some() {
                return Ok(false);
            }
            if t.state != RunState::Stopping {
                t.state = t
                    .state
                    .next(RunEvent::Stop)
                    .map_err(|_| StopError::NotRunning)?;
                let _ = store.set_run_state(id, RunState::Stopping, None);
                let _ = store.audit(Some(id), "stop", "requested", t.run_id.as_deref(), None);
            }
            pid
        };
        self.inspector.request_exit(pid);
        Ok(true)
    }

    pub fn mark_stop_timed_out(&self, id: &ProfileId) {
        if let Ok(mut tracked) = self.tracked.lock()
            && let Some(t) = tracked.get_mut(id)
        {
            t.force_available = true;
        }
    }

    /// Force-closes the profile's verified process tree (user-confirmed). Never touches other processes.
    pub fn force_stop(&self, store: &LocalStore, id: &ProfileId) -> Result<(), StopError> {
        let snapshot = self.inspector.snapshot();
        let Ok(mut tracked) = self.tracked.lock() else {
            return Err(StopError::NotRunning);
        };
        let t = tracked.get_mut(id).ok_or(StopError::NotRunning)?;
        let pid = t.pid.ok_or(StopError::NotStartedYet)?;
        if t.state != RunState::Stopping {
            t.state = t
                .state
                .next(RunEvent::Stop)
                .map_err(|_| StopError::NotRunning)?;
            let _ = store.set_run_state(id, RunState::Stopping, None);
        }
        // Current tree plus anything seen earlier that is still the same process.
        let mut victims: Vec<(u32, u64)> = procs::descendants(&snapshot, pid)
            .iter()
            .map(|p| (p.pid, p.start_time))
            .collect();
        victims.extend(t.tree.iter().copied());
        if self
            .inspector
            .is_same(pid, t.identity.start_time, t.identity.exe.as_deref())
        {
            self.inspector.kill(pid);
        }
        let mut seen = HashSet::new();
        for (vp, vs) in victims {
            if seen.insert(vp) && snapshot.iter().any(|p| identity_matches(p, vp, vs)) {
                self.inspector.kill(vp);
            }
        }
        if let Some(child) = t.child.as_mut() {
            let _ = child.try_wait();
        }
        t.exit = Some(PendingExit {
            at: Instant::now(),
            clean: false,
            exit_code: None,
            forced: true,
            early: false,
        });
        let _ = store.audit(Some(id), "force_stop", "killed", t.run_id.as_deref(), None);
        Ok(())
    }

    /// The manager is exiting and leaves browsers running: stop tracking them and release their profile locks
    /// (the next manager re-attaches). No process is signalled.
    pub fn detach_all(&self) {
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.clear();
        }
    }

    // ------------------------------------------------------------------------- queries
    pub fn is_tracked(&self, id: &ProfileId) -> bool {
        self.tracked
            .lock()
            .map(|t| t.contains_key(id))
            .unwrap_or(false)
    }

    pub fn status(&self, id: &ProfileId) -> Option<RunningProfile> {
        let tracked = self.tracked.lock().ok()?;
        tracked.get(id).map(|t| view(id, t))
    }

    pub fn running(&self) -> Vec<RunningProfile> {
        let Ok(tracked) = self.tracked.lock() else {
            return vec![];
        };
        let mut out: Vec<RunningProfile> = tracked.iter().map(|(id, t)| view(id, t)).collect();
        out.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        out
    }

    pub fn running_count(&self) -> usize {
        self.tracked.lock().map(|t| t.len()).unwrap_or(0)
    }

    pub fn running_ids(&self) -> Vec<ProfileId> {
        self.tracked
            .lock()
            .map(|t| t.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Process count and memory of every tracked browser tree (main process and its descendants), and of the
    /// manager's own processes (itself and its children that are not browser trees). Other browsers on the computer
    /// are never counted: only trees rooted at a main process this manager started or re-attached.
    pub fn resource_usage(&self) -> ResourceUsage {
        let tracked: Vec<(ProfileId, Option<u32>, Duration)> = self
            .tracked
            .lock()
            .map(|t| {
                t.iter()
                    .map(|(id, x)| (id.clone(), x.pid, x.accepted_at.elapsed()))
                    .collect()
            })
            .unwrap_or_default();
        let snapshot = self.inspector.snapshot();
        let mut browser_pids = HashSet::new();
        let profiles = tracked
            .into_iter()
            .map(|(id, pid, open_for)| {
                let (processes, memory_bytes) = match pid {
                    Some(pid) if snapshot.iter().any(|p| p.pid == pid) => {
                        browser_pids.insert(pid);
                        browser_pids
                            .extend(procs::descendants(&snapshot, pid).iter().map(|p| p.pid));
                        procs::tree_memory(&snapshot, pid)
                    }
                    _ => (0, 0),
                };
                TreeUsage {
                    profile_id: id,
                    processes,
                    memory_bytes,
                    open_seconds: open_for.as_secs(),
                }
            })
            .collect();
        let me = std::process::id();
        let own = snapshot.iter().find(|p| p.pid == me);
        let helpers: Vec<&ProcRecord> = procs::descendants(&snapshot, me)
            .into_iter()
            .filter(|p| !browser_pids.contains(&p.pid))
            .collect();
        ResourceUsage {
            profiles,
            manager_processes: usize::from(own.is_some()) + helpers.len(),
            manager_memory_bytes: own.map_or(0, |p| p.memory_bytes)
                + helpers.iter().map(|p| p.memory_bytes).sum::<u64>(),
        }
    }

    /// How long each tracked profile has been open, with its run id.
    pub fn open_durations(&self) -> Vec<(ProfileId, Option<String>, Duration)> {
        self.tracked
            .lock()
            .map(|t| {
                t.iter()
                    .map(|(id, x)| (id.clone(), x.run_id.clone(), x.accepted_at.elapsed()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Resident memory of tracked browser main processes (diagnostics; excludes the manager).
    pub fn browser_memory_bytes(&self) -> u64 {
        let pids: Vec<u32> = self
            .tracked
            .lock()
            .map(|t| t.values().filter_map(|x| x.pid).collect())
            .unwrap_or_default();
        pids.iter()
            .filter_map(|p| self.inspector.inspect(*p))
            .map(|i| i.memory_bytes)
            .sum()
    }
}

fn update_facts(
    store: &LocalStore,
    id: &ProfileId,
    t: &mut Tracked,
    facts: &TreeFacts,
    events: &mut Vec<PollEvent>,
) {
    t.helpers = facts.helpers;
    t.window_open = facts.renderers > 0;
    t.ready = t.ready || facts.helpers > 0;
    let slow = t.accepted_at.elapsed() > READY_TIMEOUT;
    if t.state == RunState::Starting && (t.ready || slow) {
        t.state = RunState::Running;
        let _ = store.set_run_state(
            id,
            RunState::Running,
            (!t.ready).then_some(Some("SLOW_START")),
        );
        events.push(PollEvent::Ready {
            profile: id.clone(),
            start_op: t.start_op.clone(),
        });
    }
}

fn view(id: &ProfileId, t: &Tracked) -> RunningProfile {
    RunningProfile {
        profile_id: id.to_string(),
        run_id: t.run_id.clone(),
        pid: t.pid,
        state: t.state,
        adopted: t.adopted,
        ready: t.ready,
        window_open: t.window_open,
        helpers: t.helpers,
        force_available: t.force_available,
    }
}

fn exit_code(status: std::process::ExitStatus) -> Option<i64> {
    if let Some(c) = status.code() {
        return Some(i64::from(c));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|s| -i64::from(s))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

pub mod fake {
    //! An in-memory process table for unit and integration tests (no real browsers needed). Processes have
    //! parents and command lines, so tree discovery and adoption run exactly as with real processes.
    use pb_runtime::{ProcRecord, ProcessInfo, ProcessInspector};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeProcesses {
        pub table: Mutex<HashMap<u32, ProcRecord>>,
        /// pids that ignore graceful exit requests
        pub stubborn: Mutex<Vec<u32>>,
        pub signals: Mutex<Vec<(u32, &'static str)>>,
    }

    impl FakeProcesses {
        pub fn add(&self, pid: u32, start_time: u64, exe: &str) {
            self.add_full(pid, None, start_time, exe, vec![]);
        }
        pub fn add_full(
            &self,
            pid: u32,
            parent: Option<u32>,
            start_time: u64,
            exe: &str,
            args: Vec<String>,
        ) {
            if let Ok(mut t) = self.table.lock() {
                t.insert(
                    pid,
                    ProcRecord {
                        pid,
                        parent,
                        start_time,
                        exe: Some(PathBuf::from(exe)),
                        args,
                        memory_bytes: 50_000_000,
                    },
                );
            }
        }
        pub fn set_memory(&self, pid: u32, bytes: u64) {
            if let Ok(mut t) = self.table.lock()
                && let Some(p) = t.get_mut(&pid)
            {
                p.memory_bytes = bytes;
            }
        }
        /// Removes a process and (like an exiting browser) its children.
        pub fn remove(&self, pid: u32) {
            if let Ok(mut t) = self.table.lock() {
                t.remove(&pid);
                let children: Vec<u32> = t
                    .values()
                    .filter(|p| p.parent == Some(pid))
                    .map(|p| p.pid)
                    .collect();
                for c in children {
                    t.remove(&c);
                }
            }
        }
        pub fn contains(&self, pid: u32) -> bool {
            self.table
                .lock()
                .map(|t| t.contains_key(&pid))
                .unwrap_or(false)
        }
    }

    impl ProcessInspector for FakeProcesses {
        fn inspect(&self, pid: u32) -> Option<ProcessInfo> {
            self.table.lock().ok()?.get(&pid).map(|p| ProcessInfo {
                pid,
                start_time: p.start_time,
                exe: p.exe.clone(),
                memory_bytes: 50_000_000,
            })
        }
        fn request_exit(&self, pid: u32) -> bool {
            if let Ok(mut s) = self.signals.lock() {
                s.push((pid, "exit"));
            }
            if !self
                .stubborn
                .lock()
                .map(|s| s.contains(&pid))
                .unwrap_or(false)
            {
                // Like Chromium's orderly shutdown: record a normal exit in the profile, then exit.
                let user_data = self.table.lock().ok().and_then(|t| {
                    t.get(&pid)?
                        .args
                        .iter()
                        .find_map(|a| a.strip_prefix("--user-data-dir=").map(PathBuf::from))
                });
                if let Some(ud) = user_data {
                    let path = pb_runtime::prefs::preferences_path(&ud);
                    let mut v: serde_json::Value = std::fs::read(&path)
                        .ok()
                        .and_then(|b| serde_json::from_slice(&b).ok())
                        .unwrap_or_else(|| serde_json::json!({}));
                    v["profile"]["exit_type"] = serde_json::json!("Normal");
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(&path, v.to_string());
                }
                self.remove(pid);
            }
            true
        }
        fn kill(&self, pid: u32) -> bool {
            if let Ok(mut s) = self.signals.lock() {
                s.push((pid, "kill"));
            }
            if let Ok(mut t) = self.table.lock() {
                t.remove(&pid);
            }
            true
        }
        fn snapshot(&self) -> Vec<ProcRecord> {
            self.table
                .lock()
                .map(|t| t.values().cloned().collect())
                .unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests;
