//! Profile lifecycle commands: start, stop, force close, recovery, backups and runtime installation
//! (milestone 03). Every step that can fail before a process exists is checked first, in this order:
//!
//! 1. the profile is not already starting/running (a repeated click returns the existing launch) or closing;
//! 2. it is not busy with recovery (a routine backup is cancelled instead), and its directory reference equals its id;
//! 3. a verified runtime is installed (or a debug/test override is configured);
//! 4. there is enough free disk space;
//! 5. the profile lock can be taken (serializes launches across threads and processes);
//! 6. no other browser is already using the directory (our own runtime is re-attached, anything else refused);
//! 7. Chromium's settings files are readable (otherwise the profile is marked damaged and recovery is offered);
//! 8. the profile was not last opened by a newer browser (downgrades are refused).
//!
//! The browser is then prepared and started on a worker thread: a backup is taken first when the browser engine
//! is about to be upgraded, profile settings are written into Chromium's Preferences, and the process is spawned
//! from a structured argument list.

use crate::events::{QUIT_REQUESTED, WARNING};
use crate::ipc::{self, IpcError, limits};
use crate::operations::{OpKind, Started};
use crate::state::{AppState, ProfileView, platform};
use crate::supervisor::{GRACEFUL_TIMEOUT, PollEvent, StartConflict, StopError};
use pb_runtime::backup::BackupError;
use pb_runtime::procs;
use pb_runtime::{
    BrowserInstall, BrowserPrefs, LaunchRequest, ProfileId, ProfileLock, ProfileState, RunState,
    prefs, prepare_launch,
};
use pb_storage::LocalStore;
use pb_storage::RuntimeInstallation;
use pb_storage::runs::{ProcessRun, RunOutcome};
use pb_update::install::{FsSpace, InstallError, Installer};
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Launching or backing up is refused below this much free space (Chromium may corrupt data on a full disk).
pub const MIN_FREE_BYTES: u64 = 1024 * 1024 * 1024;
/// While profiles run, the user is warned below this much free space.
pub const WARN_FREE_BYTES: u64 = 256 * 1024 * 1024;
/// A new last-good backup is taken after a clean close when the previous one is older than this.
pub const BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 3600);
/// How long a launch waits for a cancelled routine backup to release the profile.
pub const BACKUP_CANCEL_WAIT: Duration = Duration::from_secs(5);

/// A background backup in progress (routine after a clean close, or requested with `backup_now`).
pub struct BackupJob {
    pub cancel: Arc<AtomicBool>,
    pub op: String,
}

#[derive(Serialize)]
pub struct ProfileStatus {
    pub profile: ProfileView,
    pub runs: Vec<ProcessRun>,
    pub backup: Option<pb_runtime::backup::BackupInfo>,
    pub evidence_count: usize,
    /// Suggested next step for a crashed/damaged profile: reopen | restore_backup | start_fresh.
    pub suggested_recovery: Option<&'static str>,
}

fn free_space(path: &Path) -> std::io::Result<u64> {
    fs4::available_space(path)
}

impl AppState {
    // ------------------------------------------------------------------------- launch
    pub fn launch_profile(
        self: &Arc<Self>,
        profile_id: &ProfileId,
        start_url: Option<&str>,
    ) -> Result<Started, IpcError> {
        if start_url.is_some_and(|u| u.len() > limits::URL_BYTES || !pb_runtime::valid_start_url(u))
        {
            return Err(pb_runtime::LaunchError::BadStartUrl.into());
        }
        let store = self.store()?;
        let _guard = self.launch_lock.lock().map_err(|_| ipc::INTERNAL)?;

        // 1. Idempotent: a repeated click while starting/running creates no second run.
        match self.supervisor.active_start(profile_id) {
            Some(Ok(Some(op))) => return Ok(Started { operation_id: op }),
            Some(Ok(None)) => {
                let op = self
                    .ops
                    .start(OpKind::LaunchProfile, Some(profile_id.to_string()));
                self.ops.succeed(&op);
                return Ok(Started { operation_id: op });
            }
            Some(Err(_)) => return Err(ipc::PROFILE_STOPPING),
            None => {}
        }
        // 2. A routine backup never blocks the user: cancel it and wait briefly for it to let go.
        if self.supervisor.is_busy(profile_id) && !self.cancel_backup(profile_id) {
            return Err(ipc::PROFILE_BUSY);
        }
        let profile = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if profile.data_dir_ref != profile_id.as_str() {
            return Err(pb_runtime::LaunchError::Layout(pb_runtime::LayoutError::Escape).into());
        }
        if profile.state == RunState::Recovering {
            return Err(ipc::PROFILE_BUSY);
        }
        if profile.trashed_at.is_some() {
            return Err(ipc::PROFILE_IN_TRASH);
        }
        // 3.
        let runtime = self.resolve_runtime(&store)?;
        // 4.
        if free_space(&self.paths.data).unwrap_or(u64::MAX) < MIN_FREE_BYTES {
            return Err(ipc::LOW_DISK_SPACE);
        }
        let urls: Vec<String> = match start_url {
            Some(u) => vec![u.to_owned()],
            None => profile.start_urls.clone(),
        };
        let spec = prepare_launch(
            &self.root,
            Some(&BrowserInstall {
                executable: runtime.executable.clone(),
                revision: runtime.version.clone().unwrap_or_else(|| "dev".into()),
            }),
            ProfileState {
                exists: true,
                running: false,
            },
            LaunchRequest {
                profile_id,
                start_urls: &urls,
                switches: &self.runtime.switches,
            },
        )?;
        // 5.
        let mut lock = ProfileLock::try_acquire(&spec.dirs.root).map_err(|_| ipc::INTERNAL)?;
        if lock.is_none() && self.supervisor.is_busy(profile_id) && self.cancel_backup(profile_id) {
            // A routine backup started between steps 2 and 5 and has now been cancelled.
            lock = ProfileLock::try_acquire(&spec.dirs.root).map_err(|_| ipc::INTERNAL)?;
        }
        let lock = lock.ok_or(ipc::PROFILE_BUSY)?;
        // 6.
        let snapshot = self.supervisor.inspector().snapshot();
        if let Some(main) = procs::browser_mains(&snapshot, &spec.dirs.user_data).first() {
            if !procs::same_executable(main.exe.as_deref(), &runtime.executable) {
                return Err(ipc::PROFILE_IN_USE);
            }
            let identity = pb_storage::runs::StartIdentity {
                start_time: Some(main.start_time),
                exe: main.exe.as_ref().map(|e| e.to_string_lossy().into_owned()),
            };
            self.supervisor.adopt(
                &store,
                profile_id,
                lock,
                main.pid,
                identity,
                spec.dirs.user_data.clone(),
                runtime.version.clone(),
                None,
            )?;
            let op = self
                .ops
                .start(OpKind::LaunchProfile, Some(profile_id.to_string()));
            self.ops.succeed(&op);
            self.notify_running_changed();
            return Ok(Started { operation_id: op });
        }
        // 7.
        if prefs::check_readable(&spec.dirs.user_data).is_err() {
            let _ = store.set_run_state(
                profile_id,
                RunState::Crashed,
                Some(Some("PROFILE_DATA_UNREADABLE")),
            );
            let _ = store.audit(
                Some(profile_id),
                "start",
                "refused",
                None,
                Some("PROFILE_DATA_UNREADABLE"),
            );
            return Err(ipc::PROFILE_DATA_UNREADABLE);
        }
        // 8.
        let last = prefs::last_version(&spec.dirs.user_data);
        let (last_major, new_major) = (
            last.as_deref().and_then(pb_update::major),
            runtime.version.as_deref().and_then(pb_update::major),
        );
        if let (Some(l), Some(n)) = (last_major, new_major)
            && l > n
        {
            return Err(ipc::PROFILE_NEWER_THAN_RUNTIME);
        }
        let upgrade_backup = matches!((last_major, new_major), (Some(l), Some(n)) if l < n);

        let op = self
            .ops
            .start(OpKind::LaunchProfile, Some(profile_id.to_string()));
        self.supervisor
            .begin_start(
                profile_id,
                lock,
                spec.dirs.user_data.clone(),
                runtime.version.clone(),
                op.clone(),
            )
            .map_err(|e| match e {
                StartConflict::Stopping => ipc::PROFILE_STOPPING,
                StartConflict::AlreadyActive { .. } => ipc::PROFILE_BUSY,
            })?;
        let _ = store.set_run_state(profile_id, RunState::Starting, Some(None));
        self.notify_running_changed();

        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            this.finish_launch(&store, &id, &op_id, spec, profile, upgrade_backup, last);
        });
        Ok(Started { operation_id: op })
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_launch(
        self: &Arc<Self>,
        store: &LocalStore,
        id: &ProfileId,
        op: &str,
        spec: pb_runtime::LaunchSpec,
        profile: pb_storage::LocalProfile,
        upgrade_backup: bool,
        previous_version: Option<String>,
    ) {
        let abort = |code: &'static str, message: &'static str| {
            self.supervisor.abort_start(store, id, code);
            self.ops.fail(op, code, message);
            self.notify_running_changed();
        };
        // The engine upgrade is one-way: keep a copy made by the old version first.
        if upgrade_backup {
            match self.backups.create(
                id.as_str(),
                &spec.dirs.user_data,
                previous_version.as_deref(),
                &free_space,
                None,
            ) {
                Ok(_) => {
                    let _ = store.record_backup(id, previous_version.as_deref());
                    let _ = store.audit(Some(id), "backup", "before_upgrade", None, None);
                }
                Err(BackupError::LowDisk { .. }) => {
                    return abort(
                        "LOW_DISK_SPACE",
                        "Not enough disk space for the safety copy taken before a browser update.",
                    );
                }
                Err(_) => {
                    return abort(
                        "BACKUP_FAILED",
                        "The safety copy before the browser update could not be made.",
                    );
                }
            }
        }
        let settings_download = store
            .get_setting(pb_storage::settings::DOWNLOAD_DIR)
            .ok()
            .and_then(|v| v.value.as_str().map(str::to_owned));
        let display_name = match &profile.client_name {
            Some(c) => format!("{} · {c}", profile.name),
            None => profile.name.clone(),
        };
        let browser_prefs = BrowserPrefs {
            display_name,
            colour: profile.client_colour.clone(),
            download_dir: profile
                .download_dir
                .clone()
                .or(settings_download)
                .map(Into::into),
            camera: profile.camera,
            microphone: profile.microphone,
            location: profile.location,
        };
        if prefs::apply(&spec.dirs.user_data, &browser_prefs).is_err() {
            return abort(
                "PROFILE_DATA_UNREADABLE",
                "The profile's browser settings could not be written.",
            );
        }
        let t0 = Instant::now();
        let spawned = match self.launcher.spawn(&spec) {
            Ok(s) => s,
            Err(e) => {
                let err = IpcError::from(e);
                return abort(err.code, err.message);
            }
        };
        let _ = store.record_timing("browser_spawn_ms", t0.elapsed().as_secs_f64() * 1000.0);
        if self
            .supervisor
            .attach_spawn(store, id, spawned, &spec.executable)
            .is_err()
        {
            // Could not record the run: do not leave an untracked browser behind.
            let _ = self.supervisor.force_stop(store, id);
            self.ops
                .fail(op, "LOCAL_STORE_ERROR", "The launch could not be recorded.");
        }
        self.notify_running_changed();
        // Readiness is reported by the monitor; poll here too so the operation finishes promptly.
        let deadline = Instant::now() + crate::supervisor::READY_TIMEOUT + Duration::from_secs(2);
        while Instant::now() < deadline {
            self.poll_once();
            if self
                .ops
                .get(op)
                .is_some_and(|o| o.status != crate::operations::OpStatus::Running)
            {
                let _ =
                    store.record_timing("browser_ready_ms", t0.elapsed().as_secs_f64() * 1000.0);
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    // ------------------------------------------------------------------------- monitoring
    /// One supervisor pass plus follow-up actions. Called by the monitor thread and by waiting operations.
    pub fn poll_once(self: &Arc<Self>) {
        let Ok(store) = self.store() else { return };
        let events = self.supervisor.poll(&store);
        let mut changed = false;
        for event in events {
            changed = true;
            match event {
                PollEvent::Ready { start_op, .. } => {
                    if let Some(op) = start_op {
                        self.ops.succeed(&op);
                    }
                }
                PollEvent::Finished(f) => {
                    if let Some(op) = &f.start_op {
                        match f.outcome {
                            RunOutcome::EarlyExit => self.ops.fail(
                                op,
                                "EXITED_EARLY",
                                "The browser closed right after starting.",
                            ),
                            RunOutcome::Crashed => {
                                self.ops
                                    .fail(op, "CRASHED", "The browser closed unexpectedly.")
                            }
                            _ => self.ops.succeed(op),
                        }
                    }
                    if f.outcome == RunOutcome::Clean {
                        self.maybe_backup(&f.profile, f.runtime_version.clone(), false);
                    }
                }
            }
        }
        if changed {
            self.notify_running_changed();
        }
        // Disk check about every 30 s while profiles are open.
        let n = self.poll_count.fetch_add(1, Ordering::Relaxed);
        // Trash retention: shortly after start-up, then about hourly (one poll is ~1.5 s).
        if n % 2400 == 2 {
            self.purge_expired_trash();
        }
        if n.is_multiple_of(20) && self.supervisor.running_count() > 0 {
            let free = free_space(&self.paths.data).unwrap_or(u64::MAX);
            if free < WARN_FREE_BYTES {
                if !self.low_disk_warned.swap(true, Ordering::Relaxed) {
                    for id in self.supervisor.running_ids() {
                        let _ = store.audit(Some(&id), "backup", "skipped", None, Some("LOW_DISK"));
                    }
                    self.events.emit_json(
                        WARNING,
                        json!({ "code": "LOW_DISK_SPACE", "free_bytes": free }),
                    );
                }
            } else {
                self.low_disk_warned.store(false, Ordering::Relaxed);
            }
        }
    }

    // ------------------------------------------------------------------------- stop
    /// Graceful close (`force = false`), or the explicit force close the UI offers after a timeout.
    pub fn stop_profile(
        self: &Arc<Self>,
        profile_id: &ProfileId,
        force: bool,
    ) -> Result<Started, IpcError> {
        let store = self.store()?;
        let result = if force {
            self.supervisor.force_stop(&store, profile_id).map(|_| true)
        } else {
            self.supervisor.request_stop(&store, profile_id)
        };
        match result {
            Err(StopError::NotRunning) => return Err(ipc::NOT_RUNNING),
            Err(StopError::NotStartedYet) => return Err(ipc::PROFILE_STARTING),
            Ok(_) => {}
        }
        let op = self
            .ops
            .start(OpKind::StopProfile, Some(profile_id.to_string()));
        self.notify_running_changed();
        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            if this.wait_until_closed(std::slice::from_ref(&id), GRACEFUL_TIMEOUT) {
                this.ops.succeed(&op_id);
            } else {
                this.supervisor.mark_stop_timed_out(&id);
                this.ops.fail(
                    &op_id,
                    "STOP_TIMED_OUT",
                    "The profile is not responding. You can force it to close.",
                );
            }
            this.notify_running_changed();
        });
        Ok(Started { operation_id: op })
    }

    fn wait_until_closed(self: &Arc<Self>, ids: &[ProfileId], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            self.poll_once();
            if ids.iter().all(|id| !self.supervisor.is_tracked(id)) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// Closes every running profile gracefully and in parallel. With `force`, profiles that do not respond in
    /// time are force-closed (only used after the user chose that). `then` runs once all have closed.
    pub fn close_all(
        self: &Arc<Self>,
        force: bool,
        then: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<Started, IpcError> {
        let store = self.store()?;
        let op = self.ops.start(OpKind::CloseAll, None);
        let this = self.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            let ids = this.supervisor.running_ids();
            for id in &ids {
                let _ = this.supervisor.request_stop(&store, id);
            }
            this.notify_running_changed();
            let mut closed = this.wait_until_closed(&ids, GRACEFUL_TIMEOUT);
            if !closed && force {
                for id in this.supervisor.running_ids() {
                    let _ = this.supervisor.force_stop(&store, &id);
                }
                closed = this.wait_until_closed(&ids, Duration::from_secs(20));
            }
            if closed {
                this.ops.succeed(&op_id);
                if let Some(f) = then {
                    f();
                }
            } else {
                let stuck = this.supervisor.running_ids();
                for id in &stuck {
                    this.supervisor.mark_stop_timed_out(id);
                }
                this.ops.fail(
                    &op_id,
                    "STOP_TIMED_OUT",
                    "Some profiles are not responding. You can force them to close.",
                );
                if then.is_some() {
                    // Ask again, now offering a forced close.
                    this.events.emit_json(
                        QUIT_REQUESTED,
                        json!({ "running": this.supervisor.running_count(), "unresponsive": stuck.len() }),
                    );
                }
            }
            this.notify_running_changed();
        });
        Ok(Started { operation_id: op })
    }

    // ------------------------------------------------------------------------- status & recovery
    pub fn profile_status(&self, profile_id: &ProfileId) -> Result<ProfileStatus, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let runs = store.runs_for(profile_id, 5)?;
        let backup = self.backups.last_good(profile_id.as_str());
        let view = self.view(profile);
        let suggested_recovery = match (view.state, view.last_error.as_deref(), &backup) {
            (RunState::Crashed, Some("PROFILE_DATA_UNREADABLE"), Some(_)) => Some("restore_backup"),
            (RunState::Crashed, Some("PROFILE_DATA_UNREADABLE"), None) => Some("start_fresh"),
            (RunState::Crashed, _, Some(_)) if view.crash_count >= 3 => Some("restore_backup"),
            (RunState::Crashed, _, _) => Some("reopen"),
            _ => None,
        };
        Ok(ProfileStatus {
            evidence_count: self.backups.evidence_count(profile_id.as_str()),
            profile: view,
            runs,
            backup,
            suggested_recovery,
        })
    }

    /// `reopen` | `restore_backup` (last good copy into a fresh directory; damaged data kept as evidence) |
    /// `start_fresh` (empty browser data; old data kept as evidence) | `backup_now`.
    pub fn recover_profile(
        self: &Arc<Self>,
        profile_id: &ProfileId,
        action: &str,
    ) -> Result<Started, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if action == "reopen" {
            return self.launch_profile(profile_id, None);
        }
        if !matches!(action, "restore_backup" | "start_fresh" | "backup_now") {
            return Err(ipc::INVALID_ARGUMENT);
        }
        if self.supervisor.is_tracked(profile_id) || profile.state == RunState::Recovering {
            return Err(ipc::NOT_RECOVERABLE);
        }
        if action == "restore_backup" && self.backups.last_good(profile_id.as_str()).is_none() {
            return Err(ipc::NO_BACKUP);
        }
        if action == "backup_now" {
            let op = self
                .maybe_backup(profile_id, profile.runtime_version, true)
                .ok_or(ipc::PROFILE_BUSY)?;
            return Ok(Started { operation_id: op });
        }
        if !self.supervisor.try_busy(profile_id) {
            return Err(ipc::PROFILE_BUSY);
        }
        let dirs = self.root.dirs(profile_id);
        let lock = match ProfileLock::try_acquire(&dirs.root) {
            Ok(Some(l)) => l,
            _ => {
                self.supervisor.clear_busy(profile_id);
                return Err(ipc::PROFILE_BUSY);
            }
        };
        let _ = store.set_run_state(profile_id, RunState::Recovering, None);
        let op = self
            .ops
            .start(OpKind::RecoverProfile, Some(profile_id.to_string()));
        self.notify_running_changed();
        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        let action = action.to_owned();
        std::thread::spawn(move || {
            let result = match action.as_str() {
                "restore_backup" => this
                    .backups
                    .restore(id.as_str(), &dirs.user_data, &free_space)
                    .map(|_| ()),
                _ => this
                    .backups
                    .start_fresh(id.as_str(), &dirs.user_data)
                    .map(|_| ())
                    .map_err(BackupError::from),
            };
            match result {
                Ok(()) => {
                    let _ = store.clear_crash_state(&id);
                    let _ = store.audit(Some(&id), "recover", &action, None, None);
                    this.ops.succeed(&op_id);
                }
                Err(e) => {
                    let _ = store.set_run_state(&id, RunState::Crashed, Some(Some(e.code())));
                    let _ = store.audit(Some(&id), "recover", "failed", None, Some(e.code()));
                    this.ops.fail(
                        &op_id,
                        e.code(),
                        "Recovery did not complete. Your data was not changed.",
                    );
                }
            }
            drop(lock);
            this.supervisor.clear_busy(&id);
            this.notify_running_changed();
        });
        Ok(Started { operation_id: op })
    }

    /// Takes a last-good copy of a closed profile in the background when one is due (or `force`). Returns the
    /// operation id, or `None` when nothing was started.
    pub fn maybe_backup(
        self: &Arc<Self>,
        profile_id: &ProfileId,
        runtime_version: Option<String>,
        force: bool,
    ) -> Option<String> {
        if !force && let Some(info) = self.backups.last_good(profile_id.as_str()) {
            let age = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
                .saturating_sub(info.created_at_unix);
            let same_major = info.runtime_version.as_deref().and_then(pb_update::major)
                == runtime_version.as_deref().and_then(pb_update::major);
            if age < BACKUP_INTERVAL.as_secs() && same_major {
                return None;
            }
        }
        let store = self.store().ok()?;
        let cancel = Arc::new(AtomicBool::new(false));
        let dirs = self.root.dirs(profile_id);
        let (op, lock) = {
            // Marking the profile busy, locking it and registering the job happen together, so anyone who sees
            // the profile busy with a backup finds the job (see `cancel_backup` and `running_backup`).
            let mut jobs = self.backups_running.lock().ok()?;
            if let Some(job) = jobs.get(profile_id) {
                return force.then(|| job.op.clone());
            }
            if !self.supervisor.try_busy(profile_id) {
                return None;
            }
            let Ok(Some(lock)) = ProfileLock::try_acquire(&dirs.root) else {
                self.supervisor.clear_busy(profile_id);
                return None;
            };
            let op = self
                .ops
                .start(OpKind::BackupProfile, Some(profile_id.to_string()));
            jobs.insert(
                profile_id.clone(),
                BackupJob {
                    cancel: cancel.clone(),
                    op: op.clone(),
                },
            );
            (op, lock)
        };
        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            // Profiles are copied only when no browser process uses the directory.
            let snapshot = this.supervisor.inspector().snapshot();
            if !procs::browser_mains(&snapshot, &dirs.user_data).is_empty() {
                this.ops
                    .fail(&op_id, "PROFILE_IN_USE", "The profile is in use.");
            } else {
                match this.backups.create(
                    id.as_str(),
                    &dirs.user_data,
                    runtime_version.as_deref(),
                    &free_space,
                    Some(&cancel),
                ) {
                    Ok(_) => {
                        let _ = store.record_backup(&id, runtime_version.as_deref());
                        let _ = store.audit(Some(&id), "backup", "created", None, None);
                        this.ops.succeed(&op_id);
                    }
                    Err(BackupError::Cancelled) => {
                        let _ = store.audit(Some(&id), "backup", "cancelled", None, None);
                        this.ops.fail(
                            &op_id,
                            "BACKUP_CANCELLED",
                            "The backup was skipped because the profile was opened.",
                        );
                    }
                    Err(e) => {
                        let _ = store.audit(Some(&id), "backup", "failed", None, Some(e.code()));
                        this.ops
                            .fail(&op_id, e.code(), "The backup could not be made.");
                    }
                }
            }
            drop(lock);
            this.end_backup(&id);
        });
        Some(op)
    }

    fn end_backup(&self, profile_id: &ProfileId) {
        match self.backups_running.lock() {
            Ok(mut jobs) => {
                jobs.remove(profile_id);
                self.supervisor.clear_busy(profile_id);
            }
            Err(_) => self.supervisor.clear_busy(profile_id),
        }
    }

    /// Cancels a routine backup of `profile_id` and waits up to [`BACKUP_CANCEL_WAIT`] for it to release the
    /// profile. Returns `true` when the profile is free, `false` when it stays busy with something that cannot
    /// be cancelled (recovery) or the backup did not stop in time.
    pub(crate) fn cancel_backup(&self, profile_id: &ProfileId) -> bool {
        let flag = match self.backups_running.lock() {
            Ok(jobs) => match jobs.get(profile_id) {
                Some(job) => job.cancel.clone(),
                None => return !self.supervisor.is_busy(profile_id),
            },
            Err(_) => return false,
        };
        flag.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + BACKUP_CANCEL_WAIT;
        while self.supervisor.is_busy(profile_id) {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    // ------------------------------------------------------------------------- runtime install
    /// Downloads, verifies and installs the runtime pinned in the signed manifest (`runtime.install(version)`).
    pub fn install_runtime(self: &Arc<Self>, version: &str) -> Result<Started, IpcError> {
        let manifest = self.manifest.clone().ok_or(ipc::RUNTIME_UNAVAILABLE)?;
        if manifest.runtime.version != version {
            return Err(ipc::RUNTIME_NOT_IN_MANIFEST);
        }
        let artifact = manifest
            .artifact_for(platform())
            .cloned()
            .ok_or(ipc::RUNTIME_UNAVAILABLE)?;
        let store = self.store()?;
        if self.installing.swap(true, Ordering::SeqCst) {
            return Err(ipc::INSTALL_IN_PROGRESS);
        }
        let op = self
            .ops
            .start(OpKind::InstallRuntime, Some(version.to_owned()));
        let this = self.clone();
        let op_id = op.clone();
        let version = version.to_owned();
        std::thread::spawn(move || {
            let cancel = Arc::new(AtomicBool::new(false));
            let result = this
                .runtime
                .fetcher
                .source(&artifact.url, artifact.size_bytes, cancel)
                .map_err(|e| InstallError::Download(e.to_string()))
                .and_then(|source| {
                    let installer = Installer {
                        root: this.paths.runtimes.clone(),
                        space: &FsSpace,
                    };
                    let mut last = 0.0f32;
                    installer.install(source.as_ref(), &artifact, &version, &mut |p| {
                        let fraction = match p.stage {
                            pb_update::install::Stage::Downloading
                            | pb_update::install::Stage::Copying => {
                                0.8 * p.done as f32 / p.total.max(1) as f32
                            }
                            pb_update::install::Stage::Verifying => 0.8,
                            pb_update::install::Stage::Extracting => {
                                0.8 + 0.18 * p.done as f32 / p.total.max(1) as f32
                            }
                            pb_update::install::Stage::Finalizing => 0.99,
                        };
                        if fraction - last >= 0.01 {
                            last = fraction;
                            this.ops.progress(&op_id, fraction);
                        }
                    })
                });
            match result {
                Ok(installed) => {
                    let _ = store.upsert_runtime(&RuntimeInstallation {
                        version: installed.version.clone(),
                        platform: installed.platform.clone(),
                        digest: installed.sha256.clone(),
                        verified_at: Some(now_rfc3339()),
                        path: installed.path.to_string_lossy().into_owned(),
                        status: "verified".into(),
                        distribution: Some(manifest.distribution.id.clone()),
                        executable: Some(artifact.executable.clone()),
                    });
                    let _ = store.audit(
                        None,
                        "runtime_install",
                        "verified",
                        None,
                        Some(&installed.version),
                    );
                    this.ops.succeed(&op_id);
                }
                Err(e) => {
                    let _ = store.audit(None, "runtime_install", "failed", None, Some(e.code()));
                    let message = match &e {
                        InstallError::InsufficientSpace { .. } => {
                            "Not enough disk space to install the browser."
                        }
                        InstallError::Quarantined { .. } => {
                            "The download did not match the approved browser and was quarantined."
                        }
                        InstallError::SignatureCheckFailed => {
                            "The browser's code signature did not verify; it was quarantined."
                        }
                        InstallError::Download(_) => {
                            "The browser could not be downloaded. Check your connection."
                        }
                        InstallError::InProgress => {
                            "An earlier install was interrupted. Discard it on this screen, then try again."
                        }
                        _ => "The browser could not be installed.",
                    };
                    this.ops.fail(&op_id, e.code(), message);
                }
            }
            this.installing.store(false, Ordering::SeqCst);
        });
        Ok(Started { operation_id: op })
    }
}

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil date from days since epoch (Howard Hinnant's algorithm), avoiding a date-time dependency.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_utc_timestamps() {
        let s = super::now_rfc3339();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }
}
