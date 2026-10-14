//! Encrypted backups of organization profiles and restores (milestone 07, ADR-0014), plus this device's key for
//! sealed local backups.
//!
//! - A local profile linked to an organization profile is backed up after a clean close (automatic, on by default)
//!   or on request: the closed profile is sealed with a data key from the server (the profile is held only while it
//!   is sealed; opening it cancels that step), the sealed file is uploaded in parts and the server verifies it before
//!   it becomes the new version. Jobs resume after a restart or when the network returns ([`pb_sync::Engine`]).
//! - A restore downloads, verifies and unpacks into `<profile>/user-data.incoming`, then switches folders while the
//!   profile is closed: the previous data is kept as evidence (never deleted), a failed switch puts it back.
//! - Conflicts never overwrite: the user uploads theirs as the newest, replaces theirs with the newer backup, or opens
//!   the newer backup as a separate copy.
//! - The device key for local backups lives only in the OS keychain; without a usable keychain local backups stay
//!   plain copies (nothing is written to a plaintext key file).
//!
//! The window never sees a data key, a signed URL or a token: it gets [`SyncStatus`] and `sync` events.

use crate::events::{EventSink, SYNC};
use crate::ipc::{self, IpcError};
use crate::lifecycle::BackupJob;
use crate::state::{APP_VERSION, AppState, ProfileChanges, ProfileView, platform};
use pb_cloud::{Method, Transfer};
use pb_runtime::{ProfileId, ProfileLock, RunState, procs};
use pb_seal::SealKey;
use pb_storage::LocalStore;
use pb_storage::cloud as cs;
use pb_sync::api::SnapshotInfo;
use pb_sync::portability::{self, Here, Portability};
use pb_sync::rest::{RestApi, Transport, id_ok};
use pb_sync::{
    ApiError, AutomationApi, Engine, Job, JobStore, MemoryJobs, Objects, Opened, Poll,
    RestoreChecks, RestoreJob, RestoreState, RestoreTarget, SessionApi, Source, SyncApi, SyncError,
    UploadJob, UploadState,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;

/// Keychain account of this device's local-backup key (32 random bytes, base64).
pub const DEVICE_KEY_ACCOUNT: &str = "backup-key-v1";
/// Unfinished jobs are retried this often (and immediately when woken).
const WORKER_TICK: Duration = Duration::from_secs(60);

/// The control plane (snapshots and session leases) and object storage, as one object (tests use
/// [`pb_sync::fake::FakeClient`]).
pub trait Backend: SyncApi + SessionApi + Objects + AutomationApi {}
impl<T: SyncApi + SessionApi + Objects + AutomationApi + ?Sized> Backend for T {}

pub struct SyncRuntime {
    transfer: Transfer,
    backend: RwLock<Option<Arc<dyn Backend>>>,
    wake: Mutex<bool>,
    cv: Condvar,
    /// The job running now.
    current: Mutex<Option<Running>>,
    pub(crate) poll: RwLock<Poll>,
    /// Profiles whose folders are being switched (launch refused meanwhile).
    switching: Mutex<HashSet<ProfileId>>,
    /// Latest progress and transient error per profile, for [`SyncStatus`].
    progress: Mutex<HashMap<ProfileId, Progress>>,
    run_lock: Mutex<()>,
    worker: AtomicBool,
}

/// The job the worker is running: its profile, its cancel flag, and whether the user canceled it.
#[derive(Clone)]
struct Running {
    profile: ProfileId,
    cancel: Arc<AtomicBool>,
    by_user: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Progress {
    pub phase: Option<&'static str>,
    pub done: u64,
    pub total: u64,
    /// The last error that left the job waiting (offline, signed out, profile open…).
    pub waiting_for: Option<String>,
}

impl SyncRuntime {
    pub fn new() -> Self {
        Self {
            // Plain http only to loopback addresses (a developer's storage or an SSH tunnel).
            transfer: Transfer::new(true),
            backend: RwLock::new(None),
            wake: Mutex::new(true),
            cv: Condvar::new(),
            current: Mutex::new(None),
            poll: RwLock::new(Poll::default()),
            switching: Mutex::new(HashSet::new()),
            progress: Mutex::new(HashMap::new()),
            run_lock: Mutex::new(()),
            worker: AtomicBool::new(false),
        }
    }
}

impl Default for SyncRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ================================================================================================ API client

/// The signed-in session as the snapshot API's transport (the access token never leaves the shell).
struct Shell<'a>(&'a AppState);

impl Transport for Shell<'_> {
    fn call(
        &self,
        method: Method,
        path: &str,
        idempotency_key: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, ApiError> {
        self.0.shell_api(method, path, idempotency_key, body)
    }
    fn put_bytes(&self, path: &str, content_type: &str, bytes: &[u8]) -> Result<Value, ApiError> {
        self.0.shell_put_bytes(path, content_type, bytes)
    }
}

// ================================================================================================ job storage

/// Jobs in the local database; every save is also a `sync` event for the window.
struct Jobs<'a> {
    store: &'a LocalStore,
    events: &'a dyn EventSink,
}

impl JobStore for Jobs<'_> {
    fn save(&self, job: &Job) -> Result<(), String> {
        let local =
            ProfileId::parse(job.local_profile_id()).map_err(|_| "profile id".to_owned())?;
        let previous = self
            .store
            .sync_job(job.id())
            .ok()
            .flatten()
            .map(|j| j.state);
        let payload = serde_json::to_string(job).map_err(|e| e.to_string())?;
        let kind = match job {
            Job::Upload(_) => "upload",
            Job::Restore(_) => "restore",
        };
        self.store
            .save_sync_job(job.id(), kind, &local, job.state(), &payload)
            .map_err(|e| e.to_string())?;
        if let Job::Upload(u) = job
            && u.state == UploadState::Uploading
            && previous.as_deref() == Some("preparing")
        {
            // The sealed file holds exactly the closed profile: nothing local is left to back up (unless it is
            // opened again, which marks it changed).
            let _ = self.store.set_sync_dirty(&local, false);
        }
        self.events.emit_json(
            SYNC,
            json!({ "profile_id": local.as_str(), "job_id": job.id(), "kind": kind, "state": job.state() }),
        );
        Ok(())
    }
}

/// The job store the engine saves into (every save is a `sync` event).
pub(crate) fn jobs_for<'a>(store: &'a LocalStore, events: &'a dyn EventSink) -> impl JobStore + 'a {
    Jobs { store, events }
}

fn load_job(stored: &pb_storage::sync::StoredJob) -> Option<Job> {
    serde_json::from_str(&stored.payload).ok()
}

// ================================================================================================ restore checks

struct Checks<'a> {
    here: Here<'a>,
    data: &'a Path,
}

impl RestoreChecks for Checks<'_> {
    fn compatible(&self, s: &SnapshotInfo) -> Result<(), String> {
        let v = portability::classify(
            &s.platform,
            &s.browser_version,
            s.schema_version,
            s.device_id.as_deref(),
            &self.here,
        );
        if v.portability == Portability::Unsupported {
            Err(v.reason.to_owned())
        } else {
            Ok(())
        }
    }
    fn free_space(&self, _: &Path) -> io::Result<u64> {
        fs4::available_space(self.data)
    }
}

// ================================================================================================ views

#[derive(Serialize, Debug)]
pub struct JobView {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub error_code: Option<String>,
    pub updated_at: String,
    /// Upload: the version it became. Restore: the version restored.
    pub version: Option<i64>,
    pub head_version: Option<i64>,
    /// Restore: what the restored profile keeps on this computer.
    pub portability: Option<Portability>,
}

#[derive(Serialize, Debug)]
pub struct LocalBackupView {
    pub created_at_unix: u64,
    pub sealed: bool,
    /// False when it was sealed with a device key this computer no longer has.
    pub openable: bool,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Debug)]
pub struct SyncStatus {
    pub profile_id: String,
    pub linked: bool,
    pub org_id: Option<String>,
    pub org_profile_id: Option<String>,
    pub synced_version: i64,
    pub synced_at: Option<String>,
    pub dirty: bool,
    pub auto_backup: bool,
    pub conflict_head: Option<i64>,
    pub job: Option<JobView>,
    pub progress: Progress,
    pub restoring: bool,
    pub local_backup: Option<LocalBackupView>,
    /// New local backups are sealed with this device's key.
    pub local_backups_sealed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictChoice {
    /// Upload this computer's profile as the newest version (the other stays in the history).
    UploadMine,
    /// Replace this computer's profile with the newer backup (the current data is kept as evidence).
    UseNewer,
    /// Restore the newer backup as a separate local copy to compare first.
    OpenNewerAsCopy,
}

impl ConflictChoice {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "upload_mine" => Some(Self::UploadMine),
            "use_newer" => Some(Self::UseNewer),
            "open_newer_as_copy" => Some(Self::OpenNewerAsCopy),
            _ => None,
        }
    }
}

fn job_view(stored: &pb_storage::sync::StoredJob, data: &AppState) -> JobView {
    let job = load_job(stored);
    let (error_code, version, head_version, portability) = match &job {
        Some(Job::Upload(u)) => (u.error_code.clone(), u.version, u.head_version, None),
        Some(Job::Restore(r)) => (
            r.error_code.clone(),
            r.snapshot.as_ref().map(|s| s.version),
            r.head_version,
            r.snapshot.as_ref().map(|s| data.portability_of(s)),
        ),
        None => (Some("SYNC_JOB_UNREADABLE".into()), None, None, None),
    };
    JobView {
        id: stored.id.clone(),
        kind: stored.kind.clone(),
        state: stored.state.clone(),
        error_code,
        updated_at: stored.updated_at.clone(),
        version,
        head_version,
        portability,
    }
}

fn settings_json(p: &pb_storage::LocalProfile) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "format": "project-browser-profile-settings",
        "version": 1,
        "name": p.name,
        "start_urls": p.start_urls,
        "camera": p.camera,
        "microphone": p.microphone,
        "location": p.location,
        "privacy": p.privacy,
    }))
    .unwrap_or_default()
}

// ================================================================================================ state

impl AppState {
    // --------------------------------------------------------------------------------------- device key
    /// Loads this device's local-backup key from the keychain, creating it on first use. Without a usable
    /// keychain local backups stay plain copies; the key is never written anywhere else.
    pub fn load_backup_key(&self) {
        let available = self.keychain.read().map(|k| k.available).unwrap_or(false);
        let key = if available {
            self.secret_store().ok().and_then(|secrets| {
                match secrets.get(DEVICE_KEY_ACCOUNT) {
                    Ok(Some(b64)) => SealKey::from_base64(&b64).ok(),
                    Ok(None) => {
                        let key = SealKey::generate().ok()?;
                        secrets.set(DEVICE_KEY_ACCOUNT, &key.to_base64()).ok()?;
                        // Only use a key the keychain demonstrably kept.
                        let back = secrets.get(DEVICE_KEY_ACCOUNT).ok().flatten()?;
                        (SealKey::from_base64(&back).ok()?.fingerprint() == key.fingerprint())
                            .then_some(key)
                    }
                    Err(_) => None,
                }
            })
        } else {
            None
        };
        self.backups.set_seal_key(key);
    }

    // --------------------------------------------------------------------------------------- plumbing
    /// Replaces the API and storage (tests).
    pub fn use_sync_backend(&self, backend: Arc<dyn Backend>) {
        if let Ok(mut b) = self.sync.backend.write() {
            *b = Some(backend);
        }
    }

    pub fn set_sync_poll(&self, poll: Poll) {
        if let Ok(mut p) = self.sync.poll.write() {
            *p = poll;
        }
    }

    /// The session lease protocol (milestone 08) through the same backend.
    pub(crate) fn with_session<T>(
        &self,
        f: impl FnOnce(&dyn SessionApi) -> T,
    ) -> Result<T, SyncError> {
        let injected = self.sync.backend.read().ok().and_then(|b| b.clone());
        if let Some(b) = injected {
            return Ok(f(&*b));
        }
        let store = self
            .store()
            .map_err(|_| SyncError::Local("LOCAL_STORE_ERROR".into()))?;
        let device = store
            .cloud_state(cs::DEVICE_ID)
            .ok()
            .flatten()
            .filter(|d| id_ok("dev", d))
            .ok_or(SyncError::Api(ApiError::SignedOut))?;
        let api = RestApi {
            transport: Shell(self),
            device,
        };
        Ok(f(&api))
    }

    /// The automation endpoints (milestone 10) through the same backend.
    pub(crate) fn with_automation<T>(
        &self,
        f: impl FnOnce(&dyn AutomationApi) -> T,
    ) -> Result<T, SyncError> {
        let injected = self.sync.backend.read().ok().and_then(|b| b.clone());
        if let Some(b) = injected {
            return Ok(f(&*b));
        }
        let store = self
            .store()
            .map_err(|_| SyncError::Local("LOCAL_STORE_ERROR".into()))?;
        let device = store
            .cloud_state(cs::DEVICE_ID)
            .ok()
            .flatten()
            .filter(|d| id_ok("dev", d))
            .ok_or(SyncError::Api(ApiError::SignedOut))?;
        let api = RestApi {
            transport: Shell(self),
            device,
        };
        Ok(f(&api))
    }

    fn with_backend<T>(
        &self,
        f: impl FnOnce(&dyn SyncApi, &dyn Objects) -> T,
    ) -> Result<T, SyncError> {
        let injected = self.sync.backend.read().ok().and_then(|b| b.clone());
        if let Some(b) = injected {
            return Ok(f(&*b, &*b));
        }
        let store = self
            .store()
            .map_err(|_| SyncError::Local("LOCAL_STORE_ERROR".into()))?;
        let device = store
            .cloud_state(cs::DEVICE_ID)
            .ok()
            .flatten()
            .filter(|d| id_ok("dev", d))
            .ok_or(SyncError::Api(ApiError::SignedOut))?;
        let api = RestApi {
            transport: Shell(self),
            device,
        };
        Ok(f(&api, &self.sync.transfer))
    }

    pub(crate) fn installed_browser(&self, store: &LocalStore) -> Option<String> {
        self.resolve_runtime(store).ok().and_then(|r| r.version)
    }

    fn here<'a>(
        &self,
        store: &LocalStore,
        device: &'a mut Option<String>,
        browser: &'a mut Option<String>,
    ) -> Here<'a> {
        *device = store.cloud_state(cs::DEVICE_ID).ok().flatten();
        *browser = self.installed_browser(store);
        Here {
            platform: platform(),
            device_id: device.as_deref(),
            browser_version: browser.as_deref(),
        }
    }

    fn portability_of(&self, s: &SnapshotInfo) -> Portability {
        let Ok(store) = self.store() else {
            return Portability::Unsupported;
        };
        let (mut d, mut b) = (None, None);
        let here = self.here(&store, &mut d, &mut b);
        portability::classify(
            &s.platform,
            &s.browser_version,
            s.schema_version,
            s.device_id.as_deref(),
            &here,
        )
        .portability
    }

    fn set_progress(&self, profile: &ProfileId, f: impl FnOnce(&mut Progress)) {
        if let Ok(mut m) = self.sync.progress.lock() {
            f(m.entry(profile.clone()).or_default());
        }
    }

    /// Asks the sync worker to look at unfinished jobs now.
    pub fn sync_wake(&self) {
        if let Ok(mut w) = self.sync.wake.lock() {
            *w = true;
            self.sync.cv.notify_all();
        }
    }

    /// Starts the background worker (once): unfinished jobs resume at start-up, after a clean close, when asked,
    /// and every minute (a lost network comes back by itself).
    pub fn start_sync_worker(self: &Arc<Self>) {
        if self.sync.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            loop {
                {
                    let Ok(mut woken) = this.sync.wake.lock() else {
                        return;
                    };
                    if !*woken {
                        woken = match this.sync.cv.wait_timeout(woken, WORKER_TICK) {
                            Ok((g, _)) => g,
                            Err(_) => return,
                        };
                    }
                    *woken = false;
                }
                this.run_sync_jobs();
            }
        });
    }

    /// Runs every unfinished job once (the worker's step; tests call it directly). Returns how many ran.
    pub fn run_sync_jobs(self: &Arc<Self>) -> usize {
        let Ok(_one_runner) = self.sync.run_lock.lock() else {
            return 0;
        };
        let Ok(store) = self.store() else {
            return 0;
        };
        let open = store.open_sync_jobs().unwrap_or_default();
        let mut ran = 0;
        for stored in open {
            let Some(job) = load_job(&stored) else {
                continue;
            };
            ran += 1;
            match job {
                Job::Upload(u) => self.run_upload(&store, u),
                Job::Restore(r) => self.run_restore(&store, r),
            }
        }
        ran
    }

    fn engine_poll(&self) -> Poll {
        self.sync.poll.read().map(|p| *p).unwrap_or_default()
    }

    // --------------------------------------------------------------------------------------- upload
    fn run_upload(self: &Arc<Self>, store: &Arc<LocalStore>, mut job: UploadJob) {
        let Ok(local) = ProfileId::parse(&job.local_profile_id) else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let by_user = Arc::new(AtomicBool::new(false));
        if let Ok(mut c) = self.sync.current.lock() {
            *c = Some(Running {
                profile: local.clone(),
                cancel: cancel.clone(),
                by_user: by_user.clone(),
            });
        }
        let jobs = Jobs {
            store,
            events: &*self.events,
        };
        let work = self.paths.data.join("sync");
        let progress_local = local.clone();
        let progress = move |_id: &str, phase: &'static str, done: u64, total: u64| {
            self.set_progress(&progress_local, |p| {
                p.phase = Some(phase);
                p.done = done;
                p.total = total;
            });
        };
        let poll = self.engine_poll();
        let outcome = self.with_backend(|api, objects| {
            let engine = Engine {
                api,
                objects,
                jobs: &jobs,
                work_dir: &work,
                cancel: &cancel,
                progress: &progress,
                poll,
            };
            let mut sealed_once = false;
            let result = loop {
                match engine.upload(&mut job, None) {
                    Err(SyncError::NeedsProfile) if !sealed_once => {
                        sealed_once = true;
                        if let Err(e) = self.seal_closed(store, &local, &engine, &mut job, &cancel)
                        {
                            break Err(e);
                        }
                    }
                    other => break other,
                }
            };
            match &result {
                Err(SyncError::Cancelled) if by_user.load(Ordering::SeqCst) => {
                    let _ = engine.cancel_upload(&mut job);
                }
                Err(SyncError::Local(code)) => {
                    let _ = engine.fail_upload(&mut job, code);
                }
                Err(SyncError::Api(e)) if is_permanent(e) => {
                    let _ = engine.fail_upload(&mut job, e.code());
                }
                _ => {}
            }
            result
        });
        if let Ok(mut c) = self.sync.current.lock() {
            *c = None;
        }
        let waiting = match outcome {
            Ok(Ok(_)) => None,
            Ok(Err(e)) | Err(e) => Some(e.code()),
        };
        self.set_progress(&local, |p| {
            p.phase = None;
            p.waiting_for = waiting.filter(|_| !job.state.is_terminal());
        });
        self.after_upload(store, &local, &job);
        // Milestone 08: a session's closing backup (or a recovery copy) moves the session on.
        if job.lease_mode != pb_sync::LeaseMode::Job {
            self.team_after_upload(store, &job);
        }
    }

    /// Seals the closed profile while holding it like a backup does (a launch cancels this step).
    fn seal_closed(
        self: &Arc<Self>,
        store: &LocalStore,
        local: &ProfileId,
        engine: &Engine<'_>,
        job: &mut UploadJob,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), SyncError> {
        let profile = store
            .get_profile(local)
            .ok()
            .flatten()
            .ok_or_else(|| SyncError::Local("UNKNOWN_PROFILE".into()))?;
        if job.is_recovery() {
            // A recovery copy (milestone 08) seals the copy kept aside when the lease was lost, not the profile.
            let dir = self
                .team_quarantine_dir(store, local)
                .filter(|d| d.is_dir())
                .ok_or_else(|| SyncError::Local("RECOVERY_COPY_MISSING".into()))?;
            let settings = settings_json(&profile);
            let browser = profile
                .runtime_version
                .clone()
                .or_else(|| self.installed_browser(store))
                .filter(|v| pb_sync::portability::major(v).is_some())
                .unwrap_or_else(|| "0.0.0.0".into());
            let source = Source {
                user_data: &dir,
                settings_json: Some(&settings),
                platform: platform(),
                browser_version: &browser,
                app_version: APP_VERSION,
            };
            return engine.seal(job, &source);
        }
        if profile.trashed_at.is_some() {
            return Err(SyncError::Local("PROFILE_IN_TRASH".into()));
        }
        // Only a verified clean shutdown is backed up: crashed or recovering profiles wait for recovery.
        if profile.state != RunState::Stopped {
            return Err(SyncError::NeedsProfile);
        }
        let dirs = self.root.dirs(local);
        let lock = self.claim_profile(local, cancel)?;
        let result = (|| {
            let snapshot = self.supervisor.inspector().snapshot();
            if !procs::browser_mains(&snapshot, &dirs.user_data).is_empty() {
                return Err(SyncError::NeedsProfile);
            }
            if !dirs.user_data.is_dir() {
                return Err(SyncError::Local("PROFILE_NEVER_OPENED".into()));
            }
            let settings = settings_json(&profile);
            let browser = profile
                .runtime_version
                .clone()
                .or_else(|| self.installed_browser(store))
                .filter(|v| pb_sync::portability::major(v).is_some())
                .unwrap_or_else(|| "0.0.0.0".into());
            let source = Source {
                user_data: &dirs.user_data,
                settings_json: Some(&settings),
                platform: platform(),
                browser_version: &browser,
                app_version: APP_VERSION,
            };
            engine.seal(job, &source)
        })();
        drop(lock);
        self.release_profile(local);
        result
    }

    /// Marks a closed profile busy and locks it, registered so that a launch cancels the holder.
    fn claim_profile(
        &self,
        local: &ProfileId,
        cancel: &Arc<AtomicBool>,
    ) -> Result<ProfileLock, SyncError> {
        let dirs = self.root.dirs(local);
        let mut jobs = self
            .backups_running
            .lock()
            .map_err(|_| SyncError::NeedsProfile)?;
        if jobs.contains_key(local) || !self.supervisor.try_busy(local) {
            return Err(SyncError::NeedsProfile);
        }
        let Ok(Some(lock)) = ProfileLock::try_acquire(&dirs.root) else {
            self.supervisor.clear_busy(local);
            return Err(SyncError::NeedsProfile);
        };
        jobs.insert(
            local.clone(),
            BackupJob {
                cancel: cancel.clone(),
                op: String::new(),
            },
        );
        Ok(lock)
    }

    fn release_profile(&self, local: &ProfileId) {
        if let Ok(mut jobs) = self.backups_running.lock() {
            jobs.remove(local);
        }
        self.supervisor.clear_busy(local);
    }

    fn after_upload(&self, store: &LocalStore, local: &ProfileId, job: &UploadJob) {
        match job.state {
            UploadState::Committed => {
                if let (Some(v), Some(snap)) = (job.version, &job.snapshot_id) {
                    let _ = store.set_synced(local, v, snap, None);
                    let _ = store.audit(
                        Some(local),
                        "sync",
                        "committed",
                        None,
                        Some(&format!("version {v}")),
                    );
                }
            }
            UploadState::Conflict => {
                let _ = store.set_sync_conflict(local, job.head_version);
                let _ = store.set_sync_dirty(local, true);
                let _ = store.audit(Some(local), "sync", "conflict", None, None);
            }
            UploadState::Failed | UploadState::Canceled => {
                let _ = store.set_sync_dirty(local, true);
                let _ = store.audit(
                    Some(local),
                    "sync",
                    job.state.as_str(),
                    None,
                    job.error_code.as_deref(),
                );
            }
            _ => {}
        }
    }

    /// An unfinished upload of this profile, or a new one based on its last synchronized version.
    fn enqueue_upload(&self, store: &LocalStore, local: &ProfileId) -> Result<String, IpcError> {
        let link = store.sync_link(local)?.ok_or(ipc::SYNC_NOT_LINKED)?;
        if let Some(open) = store
            .open_sync_jobs()?
            .into_iter()
            .find(|j| &j.local_profile_id == local)
        {
            return if open.kind == "upload" {
                Ok(open.id)
            } else {
                Err(ipc::SYNC_BUSY)
            };
        }
        let job = pb_sync::new_upload(
            local.as_str(),
            &link.org_id,
            &link.org_profile_id,
            link.synced_version,
        )
        .map_err(|_| ipc::INTERNAL)?;
        Jobs {
            store,
            events: &*self.events,
        }
        .save(&Job::Upload(job.clone()))
        .map_err(|_| ipc::INTERNAL)?;
        Ok(job.id)
    }

    // --------------------------------------------------------------------------------------- restore
    fn run_restore(self: &Arc<Self>, store: &Arc<LocalStore>, mut job: RestoreJob) {
        let Ok(local) = ProfileId::parse(&job.local_profile_id) else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let by_user = Arc::new(AtomicBool::new(false));
        if let Ok(mut c) = self.sync.current.lock() {
            *c = Some(Running {
                profile: local.clone(),
                cancel: cancel.clone(),
                by_user: by_user.clone(),
            });
        }
        let jobs = Jobs {
            store,
            events: &*self.events,
        };
        let work = self.paths.data.join("sync");
        let dirs = self.root.dirs(&local);
        let dest = dirs.root.join("user-data.incoming");
        let progress_local = local.clone();
        let progress = move |_id: &str, phase: &'static str, done: u64, total: u64| {
            self.set_progress(&progress_local, |p| {
                p.phase = Some(phase);
                p.done = done;
                p.total = total;
            });
        };
        let (mut d, mut b) = (None, None);
        let here = self.here(store, &mut d, &mut b);
        let checks = Checks {
            here,
            data: &self.paths.data,
        };
        let poll = self.engine_poll();
        let outcome = self.with_backend(|api, objects| {
            let engine = Engine {
                api,
                objects,
                jobs: &jobs,
                work_dir: &work,
                cancel: &cancel,
                progress: &progress,
                poll,
            };
            let result = (|| {
                let Some(opened) = engine.restore(&mut job, &dest, &checks)? else {
                    return Ok(());
                };
                self.switch_restored(store, &local, &job, &opened, &dest)?;
                engine.finish_restore(&mut job)
            })();
            if matches!(result, Err(SyncError::Cancelled)) && by_user.load(Ordering::SeqCst) {
                let _ = engine.cancel_restore(&mut job, &dest);
            } else if let Err(SyncError::Local(code)) = &result {
                job.state = RestoreState::Failed;
                job.error_code = Some(code.clone());
                let _ = std::fs::remove_dir_all(&dest);
                let _ = jobs.save(&Job::Restore(job.clone()));
            }
            result
        });
        if let Ok(mut c) = self.sync.current.lock() {
            *c = None;
        }
        let waiting = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(e)) | Err(e) => Some(e.code()),
        };
        self.set_progress(&local, |p| {
            p.phase = None;
            p.waiting_for = waiting.filter(|_| !job.state.is_terminal());
        });
        if job.state == RestoreState::Failed {
            let _ = store.audit(
                Some(&local),
                "cloud_restore",
                "failed",
                None,
                job.error_code.as_deref(),
            );
        }
    }

    /// Replaces the profile's folder with the restored one while it is closed. The previous data becomes evidence
    /// (kept, never deleted); if the switch fails it is put back.
    fn switch_restored(
        self: &Arc<Self>,
        store: &LocalStore,
        local: &ProfileId,
        job: &RestoreJob,
        opened: &Opened,
        dest: &Path,
    ) -> Result<(), SyncError> {
        let _no_launch = self
            .launch_lock
            .lock()
            .map_err(|_| SyncError::NeedsProfile)?;
        let profile = store
            .get_profile(local)
            .ok()
            .flatten()
            .ok_or_else(|| SyncError::Local("UNKNOWN_PROFILE".into()))?;
        if matches!(
            profile.state,
            RunState::Starting | RunState::Running | RunState::Stopping
        ) {
            return Err(SyncError::NeedsProfile);
        }
        let dirs = self.root.dirs(local);
        let never = Arc::new(AtomicBool::new(false));
        let lock = self.claim_profile(local, &never)?;
        if let Ok(mut s) = self.sync.switching.lock() {
            s.insert(local.clone());
        }
        let result = (|| {
            let incoming = dest.join("user-data");
            let evidence = if dirs.user_data.exists() {
                Some(
                    self.backups
                        .preserve_evidence(local.as_str(), &dirs.user_data, "cloud-restore")
                        .map_err(|_| SyncError::Local("SYNC_IO_ERROR".into()))?,
                )
            } else {
                None
            };
            if std::fs::rename(&incoming, &dirs.user_data).is_err() {
                if let Some(ev) = &evidence {
                    let _ = std::fs::rename(ev.join("user-data"), &dirs.user_data);
                }
                return Err(SyncError::Local("SYNC_IO_ERROR".into()));
            }
            let _ = std::fs::remove_dir_all(dest);
            Ok(())
        })();
        drop(lock);
        self.release_profile(local);
        if let Ok(mut s) = self.sync.switching.lock() {
            s.remove(local);
        }
        result?;
        let _ = store.set_run_state(local, RunState::Stopped, Some(None));
        self.apply_restored_settings(store, local, opened);
        let snap = &opened.snapshot;
        let linked = store.sync_link(local).ok().flatten();
        if job.link_after {
            let _ = store.link_restored(
                local,
                &job.org_id,
                &job.org_profile_id,
                opened.head_version,
                &snap.id,
            );
        } else if job.target == RestoreTarget::Replace
            && linked.is_some_and(|l| l.org_profile_id == job.org_profile_id)
        {
            // The next upload is based on the newest version; an older version restored here becomes the newest at
            // the next backup (a rollback), so the profile counts as changed.
            let _ = store.set_synced(
                local,
                opened.head_version,
                &snap.id,
                Some(snap.version != opened.head_version),
            );
        }
        let label = match self.portability_of(snap) {
            Portability::Supported => "supported",
            Portability::SignInRequired => "sign_in_required",
            Portability::Unsupported => "unsupported",
        };
        let _ = store.audit(
            Some(local),
            "cloud_restore",
            "ok",
            None,
            Some(&format!("version {} {label}", snap.version)),
        );
        self.events.emit_json(
            SYNC,
            json!({ "profile_id": local.as_str(), "job_id": job.id, "kind": "restore", "state": "restored",
                    "version": snap.version, "portability": label }),
        );
        self.notify_running_changed();
        Ok(())
    }

    /// Applies the snapshot's profile settings (validated like any edit; proxies are never part of a snapshot).
    fn apply_restored_settings(&self, store: &LocalStore, local: &ProfileId, opened: &Opened) {
        let Some(raw) = opened.meta.get("settings.json") else {
            return;
        };
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            return;
        };
        if v.get("format").and_then(Value::as_str) != Some("project-browser-profile-settings") {
            return;
        }
        let Ok(Some(current)) = store.get_profile(local) else {
            return;
        };
        let urls: Option<Vec<String>> = v
            .get("start_urls")
            .and_then(|u| serde_json::from_value(u.clone()).ok());
        let privacy: Option<pb_runtime::PrivacyConfig> = v
            .get("privacy")
            .and_then(|p| serde_json::from_value(p.clone()).ok());
        let text = |k: &str| v.get(k).and_then(Value::as_str);
        let _ = self.update_profile(
            local,
            current.version,
            ProfileChanges {
                start_urls: urls.as_deref(),
                camera: text("camera"),
                microphone: text("microphone"),
                location: text("location"),
                privacy: privacy.as_ref(),
                ..ProfileChanges::default()
            },
        );
    }

    /// `source`: (organization, organization profile).
    fn new_restore(
        &self,
        store: &LocalStore,
        (org, org_profile): (&str, &str),
        target_profile: &ProfileId,
        target: RestoreTarget,
        snapshot: Option<&str>,
        link_after: bool,
    ) -> Result<String, IpcError> {
        if snapshot.is_some_and(|s| !id_ok("snp", s)) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let id = pb_sync::job::random_id("sj_").map_err(|_| ipc::INTERNAL)?;
        let mut job = RestoreJob::new(
            id.clone(),
            org,
            org_profile,
            target_profile.as_str(),
            target,
            snapshot,
        );
        job.link_after = link_after;
        Jobs {
            store,
            events: &*self.events,
        }
        .save(&Job::Restore(job))
        .map_err(|_| ipc::INTERNAL)?;
        self.sync_wake();
        Ok(id)
    }

    // --------------------------------------------------------------------------------------- hooks
    /// A linked profile was opened: its data is changing.
    pub(crate) fn sync_profile_started(&self, store: &LocalStore, local: &ProfileId) {
        let _ = store.mark_sync_dirty(local);
    }

    /// True while a restore of this profile is unfinished or switching folders (launch is refused).
    pub(crate) fn sync_restoring(&self, store: &LocalStore, local: &ProfileId) -> bool {
        if self
            .sync
            .switching
            .lock()
            .map(|s| s.contains(local))
            .unwrap_or(false)
        {
            return true;
        }
        store
            .open_sync_jobs()
            .unwrap_or_default()
            .iter()
            .any(|j| &j.local_profile_id == local && j.kind == "restore")
    }

    /// After a clean close: back up linked profiles with automatic backup on. A shared session's closing backup
    /// is the session's (milestone 08, `team_after_exit`).
    pub(crate) fn sync_after_clean_exit(&self, local: &ProfileId) {
        let Ok(store) = self.store() else {
            return;
        };
        if store.team_session(local).ok().flatten().is_some() {
            self.sync_wake();
            return;
        }
        let Ok(Some(link)) = store.sync_link(local) else {
            return;
        };
        if link.auto_backup && link.conflict_head.is_none() && link.dirty {
            let _ = self.enqueue_upload(&store, local);
        }
        self.sync_wake();
    }

    // --------------------------------------------------------------------------------------- commands
    pub fn sync_status(&self, local: &ProfileId) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        store.get_profile(local)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let link = store.sync_link(local)?;
        let job = store.latest_sync_job(local)?.map(|j| job_view(&j, self));
        let progress = self
            .sync
            .progress
            .lock()
            .ok()
            .and_then(|m| m.get(local).cloned())
            .unwrap_or_default();
        let local_backup = self
            .backups
            .last_good(local.as_str())
            .map(|b| LocalBackupView {
                openable: self.backups.openable(&b),
                created_at_unix: b.created_at_unix,
                sealed: b.sealed,
                bytes: b.bytes,
                files: b.files,
            });
        Ok(SyncStatus {
            profile_id: local.to_string(),
            linked: link.is_some(),
            org_id: link.as_ref().map(|l| l.org_id.clone()),
            org_profile_id: link.as_ref().map(|l| l.org_profile_id.clone()),
            synced_version: link.as_ref().map_or(0, |l| l.synced_version),
            synced_at: link.as_ref().and_then(|l| l.synced_at.clone()),
            dirty: link.as_ref().is_some_and(|l| l.dirty),
            auto_backup: link.as_ref().is_some_and(|l| l.auto_backup),
            conflict_head: link.as_ref().and_then(|l| l.conflict_head),
            restoring: self.sync_restoring(&store, local),
            job,
            progress,
            local_backup,
            local_backups_sealed: self.backups.sealing(),
        })
    }

    /// Backs up a linked profile now (it must be closed after a clean shutdown).
    pub fn sync_backup_now(&self, local: &ProfileId) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(local)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let link = store.sync_link(local)?.ok_or(ipc::SYNC_NOT_LINKED)?;
        if link.conflict_head.is_some() {
            return Err(ipc::SYNC_CONFLICT_OPEN);
        }
        // A shared session's backup is its closing backup (milestone 08): hand off, retry or give it up there.
        if let Some(s) = store.team_session(local)? {
            return Err(if crate::team::leased(&s.phase) {
                ipc::TEAM_SESSION_ACTIVE
            } else {
                ipc::SESSION_ENDED
            });
        }
        if profile.state != RunState::Stopped {
            return Err(ipc::SYNC_PROFILE_NOT_CLOSED);
        }
        let _ = store.set_sync_dirty(local, true);
        self.enqueue_upload(&store, local)?;
        self.sync_wake();
        self.sync_status(local)
    }

    /// Cancels this profile's unfinished upload or restore (the last committed version stays the newest).
    pub fn sync_cancel(self: &Arc<Self>, local: &ProfileId) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        let running = self
            .sync
            .current
            .lock()
            .ok()
            .and_then(|c| c.as_ref().filter(|r| &r.profile == local).cloned());
        if let Some(r) = running {
            r.by_user.store(true, Ordering::SeqCst);
            r.cancel.store(true, Ordering::SeqCst);
            return self.sync_status(local);
        }
        let jobs = Jobs {
            store: &store,
            events: &*self.events,
        };
        let work = self.paths.data.join("sync");
        let never = AtomicBool::new(false);
        for stored in store.open_sync_jobs()? {
            if &stored.local_profile_id != local {
                continue;
            }
            let poll = self.engine_poll();
            let quiet = |_: &str, _: &'static str, _: u64, _: u64| {};
            let canceled = self.with_backend(|api, objects| {
                let engine = Engine {
                    api,
                    objects,
                    jobs: &jobs,
                    work_dir: &work,
                    cancel: &never,
                    progress: &quiet,
                    poll,
                };
                match load_job(&stored) {
                    Some(Job::Upload(mut u)) => {
                        let r = engine.cancel_upload(&mut u);
                        self.after_upload(&store, local, &u);
                        r
                    }
                    Some(Job::Restore(mut r)) => {
                        let dest = self.root.dirs(local).root.join("user-data.incoming");
                        engine.cancel_restore(&mut r, &dest)
                    }
                    None => Ok(()),
                }
            });
            if canceled.is_err() {
                // Signed out: cancel locally; the server expires the pending upload by itself.
                if let Some(mut j) = load_job(&stored) {
                    match &mut j {
                        Job::Upload(u) => u.state = UploadState::Canceled,
                        Job::Restore(r) => r.state = RestoreState::Canceled,
                    }
                    let _ = jobs.save(&j);
                }
            }
        }
        // A shared session's closing backup canceled by the person: the session waits for their decision.
        if let Ok(Some(s)) = store.team_session(local)
            && let Some(job_id) = s.upload_job_id.as_deref()
            && let Ok(Some(stored)) = store.sync_job(job_id)
            && let Some(Job::Upload(u)) = load_job(&stored)
            && u.state == UploadState::Canceled
        {
            self.team_after_upload(&store, &u);
        }
        self.sync_status(local)
    }

    pub fn sync_set_auto(&self, local: &ProfileId, on: bool) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        if !store.set_auto_backup(local, on)? {
            return Err(ipc::SYNC_NOT_LINKED);
        }
        self.sync_status(local)
    }

    pub fn sync_resolve(
        &self,
        local: &ProfileId,
        choice: ConflictChoice,
    ) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(local)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let link = store.sync_link(local)?.ok_or(ipc::SYNC_NOT_LINKED)?;
        if link.conflict_head.is_none() {
            return Err(ipc::SYNC_NO_CONFLICT);
        }
        match choice {
            ConflictChoice::UploadMine => {
                if profile.state != RunState::Stopped {
                    return Err(ipc::SYNC_PROFILE_NOT_CLOSED);
                }
                store.accept_conflict_base(local)?;
                self.enqueue_upload(&store, local)?;
                self.sync_wake();
            }
            ConflictChoice::UseNewer => {
                self.restore_into(&store, local, &profile, &link, None)?;
            }
            ConflictChoice::OpenNewerAsCopy => {
                self.restore_copy(&store, &profile, &link, None)?;
            }
        }
        self.sync_status(local)
    }

    /// Restores a linked profile from its newest backup (or `snapshot`): into this profile (the current data is
    /// kept as evidence), or `as_copy` into a new local profile (rollback-to-copy).
    pub fn sync_restore(
        &self,
        local: &ProfileId,
        snapshot: Option<&str>,
        as_copy: bool,
    ) -> Result<SyncStatus, IpcError> {
        let store = self.store()?;
        let profile = store.get_profile(local)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        let link = store.sync_link(local)?.ok_or(ipc::SYNC_NOT_LINKED)?;
        if as_copy {
            self.restore_copy(&store, &profile, &link, snapshot)?;
        } else {
            self.restore_into(&store, local, &profile, &link, snapshot)?;
        }
        self.sync_status(local)
    }

    fn restore_into(
        &self,
        store: &LocalStore,
        local: &ProfileId,
        profile: &pb_storage::LocalProfile,
        link: &pb_storage::sync::SyncLink,
        snapshot: Option<&str>,
    ) -> Result<String, IpcError> {
        if matches!(
            profile.state,
            RunState::Starting | RunState::Running | RunState::Stopping
        ) {
            return Err(ipc::SYNC_PROFILE_NOT_CLOSED);
        }
        if store
            .open_sync_jobs()?
            .iter()
            .any(|j| &j.local_profile_id == local)
        {
            return Err(ipc::SYNC_BUSY);
        }
        self.new_restore(
            store,
            (&link.org_id, &link.org_profile_id),
            local,
            RestoreTarget::Replace,
            snapshot,
            false,
        )
    }

    fn restore_copy(
        &self,
        store: &LocalStore,
        profile: &pb_storage::LocalProfile,
        link: &pb_storage::sync::SyncLink,
        snapshot: Option<&str>,
    ) -> Result<ProfileId, IpcError> {
        let name: String = format!("{} (restored copy)", profile.name)
            .chars()
            .take(ipc::limits::LABEL_CHARS)
            .collect();
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let copy = store.insert_profile(pb_storage::NewProfile::basic(
            id,
            profile.workspace_id.clone(),
            &name,
            profile.client_id.clone(),
        ))?;
        let _ = store.audit(Some(&copy.id), "create", "restored_copy", None, None);
        self.new_restore(
            store,
            (&link.org_id, &link.org_profile_id),
            &copy.id,
            RestoreTarget::Copy,
            snapshot,
            false,
        )?;
        Ok(copy.id)
    }

    /// Restores an organization profile onto this computer for the first time: a new local profile in the active
    /// workspace, linked to the organization profile once its data is in place.
    pub fn sync_restore_here(
        &self,
        org_id: &str,
        org_profile_id: &str,
        name: &str,
    ) -> Result<ProfileView, IpcError> {
        if !id_ok("org", org_id) || !id_ok("prf", org_profile_id) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let name = ipc::clean_text(name, ipc::limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let store = self.store()?;
        let pending = store.open_sync_jobs()?.iter().any(|j| {
            matches!(load_job(j), Some(Job::Restore(r)) if r.link_after && r.org_profile_id == org_profile_id)
        });
        if pending
            || store
                .org_links(Some(org_id))?
                .iter()
                .any(|l| l.org_profile_id == org_profile_id)
        {
            return Err(ipc::SYNC_ALREADY_HERE);
        }
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        // Fail before anything is created when there is nothing to restore (or no access).
        match self.with_backend(|api, _| api.latest(org_id, org_profile_id)) {
            Ok(Ok(Some(_))) => {}
            Ok(Ok(None)) => return Err(ipc::SYNC_NO_BACKUP),
            Ok(Err(ApiError::Offline)) => return Err(ipc::CLOUD_OFFLINE),
            Ok(Err(ApiError::SignedOut)) | Err(SyncError::Api(ApiError::SignedOut)) => {
                return Err(ipc::CLOUD_SIGNED_OUT);
            }
            Ok(Err(e)) if e.is_code("NOT_FOUND") => return Err(ipc::SYNC_NO_BACKUP),
            Ok(Err(e)) if e.is_code("FORBIDDEN") => return Err(ipc::SYNC_FORBIDDEN),
            _ => return Err(ipc::CLOUD_UNAVAILABLE),
        }
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let p = store.insert_profile(pb_storage::NewProfile::basic(id, Some(ws), &name, None))?;
        let _ = store.audit(Some(&p.id), "create", "restore_here", None, None);
        self.new_restore(
            &store,
            (org_id, org_profile_id),
            &p.id,
            RestoreTarget::Copy,
            None,
            true,
        )?;
        Ok(self.view(p))
    }
}

/// The local profile a "restore here" of this organization profile is being restored into, if one is unfinished
/// (milestone 10: an automation job waits for it).
pub(crate) fn restoring_here(store: &LocalStore, org_profile_id: &str) -> Option<ProfileId> {
    store
        .open_sync_jobs()
        .ok()?
        .iter()
        .find_map(|j| match load_job(j) {
            Some(Job::Restore(r)) if r.link_after && r.org_profile_id == org_profile_id => {
                Some(j.local_profile_id.clone())
            }
            _ => None,
        })
}

/// R3: every unfinished first download ("restore here") of an organization: (organization profile, local copy).
pub(crate) fn restoring_here_of(store: &LocalStore, org_id: &str) -> Vec<(String, ProfileId)> {
    store
        .open_sync_jobs()
        .unwrap_or_default()
        .iter()
        .filter_map(|j| match load_job(j) {
            Some(Job::Restore(r)) if r.link_after && r.org_id == org_id => {
                Some((r.org_profile_id, j.local_profile_id.clone()))
            }
            _ => None,
        })
        .collect()
}

impl AppState {
    /// Cancels one unfinished job (best effort; the server expires what it does not hear about).
    pub(crate) fn cancel_job_quietly(&self, store: &LocalStore, local: &ProfileId, job_id: &str) {
        let running = self
            .sync
            .current
            .lock()
            .ok()
            .and_then(|c| c.as_ref().filter(|r| &r.profile == local).cloned());
        if let Some(r) = running {
            r.by_user.store(true, Ordering::SeqCst);
            r.cancel.store(true, Ordering::SeqCst);
        }
        let Ok(Some(stored)) = store.sync_job(job_id) else {
            return;
        };
        let jobs = Jobs {
            store,
            events: &*self.events,
        };
        let work = self.paths.data.join("sync");
        let never = AtomicBool::new(false);
        let poll = self.engine_poll();
        let quiet = |_: &str, _: &'static str, _: u64, _: u64| {};
        let done = self.with_backend(|api, objects| {
            let engine = Engine {
                api,
                objects,
                jobs: &jobs,
                work_dir: &work,
                cancel: &never,
                progress: &quiet,
                poll,
            };
            match load_job(&stored) {
                Some(Job::Upload(mut u)) => engine.cancel_upload(&mut u),
                Some(Job::Restore(mut r)) => {
                    let dest = self.root.dirs(local).root.join("user-data.incoming");
                    engine.cancel_restore(&mut r, &dest)
                }
                None => Ok(()),
            }
        });
        if !matches!(done, Ok(Ok(())))
            && let Some(mut j) = load_job(&stored)
        {
            match &mut j {
                Job::Upload(u) => u.state = UploadState::Canceled,
                Job::Restore(r) => r.state = RestoreState::Canceled,
            }
            let _ = jobs.save(&j);
        }
    }

    /// Puts the newest backup on this computer before a shared session opens (milestone 08): downloaded, verified
    /// and unpacked into a fresh folder, then switched in (the previous folder is kept as evidence). Runs in the
    /// open's own thread with its own job record, so the background worker never picks it up twice.
    pub(crate) fn restore_for_session(
        self: &Arc<Self>,
        store: &Arc<LocalStore>,
        local: &ProfileId,
        link: &pb_storage::sync::SyncLink,
        _session: &pb_storage::team::TeamSession,
    ) -> Result<(), String> {
        let id = pb_sync::job::random_id("sj_").map_err(|_| "RNG".to_owned())?;
        let mut job = RestoreJob::new(
            id,
            &link.org_id,
            &link.org_profile_id,
            local.as_str(),
            RestoreTarget::Replace,
            None,
        );
        let memory = MemoryJobs::default();
        let work = self.paths.data.join("sync");
        let dest = self.root.dirs(local).root.join("user-data.incoming");
        let never = AtomicBool::new(false);
        let quiet = |_: &str, _: &'static str, _: u64, _: u64| {};
        let (mut d, mut b) = (None, None);
        let here = self.here(store, &mut d, &mut b);
        let checks = Checks {
            here,
            data: &self.paths.data,
        };
        let poll = self.engine_poll();
        let out = self.with_backend(|api, objects| {
            let engine = Engine {
                api,
                objects,
                jobs: &memory,
                work_dir: &work,
                cancel: &never,
                progress: &quiet,
                poll,
            };
            for _ in 0..3 {
                match engine.restore(&mut job, &dest, &checks)? {
                    Some(opened) => {
                        self.switch_restored(store, local, &job, &opened, &dest)?;
                        return engine.finish_restore(&mut job);
                    }
                    None if job.state.is_terminal() => break,
                    None => {}
                }
            }
            Err(SyncError::Local(
                job.error_code
                    .clone()
                    .unwrap_or_else(|| "RESTORE_FAILED".into()),
            ))
        });
        match out {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) | Err(e) => {
                let _ = std::fs::remove_dir_all(&dest);
                Err(e.code())
            }
        }
    }
}

impl AppState {
    /// Restores a recovery copy (milestone 08) into a new local profile that stays unlinked: it is a copy to look
    /// at, never the organization's profile. The server allows it to owners and admins only.
    pub fn restore_recovery_copy(
        &self,
        org_id: &str,
        org_profile_id: &str,
        snapshot_id: &str,
        name: &str,
    ) -> Result<ProfileView, IpcError> {
        if !id_ok("org", org_id) || !id_ok("prf", org_profile_id) || !id_ok("snp", snapshot_id) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let name = ipc::clean_text(name, ipc::limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let store = self.store()?;
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let p = store.insert_profile(pb_storage::NewProfile::basic(id, Some(ws), &name, None))?;
        let _ = store.audit(Some(&p.id), "create", "recovery_copy", None, None);
        self.new_restore(
            &store,
            (org_id, org_profile_id),
            &p.id,
            RestoreTarget::Copy,
            Some(snapshot_id),
            false,
        )?;
        Ok(self.view(p))
    }
}

fn is_permanent(e: &ApiError) -> bool {
    matches!(e, ApiError::Code { status, .. } if (400..500).contains(status) && ![408, 409, 429].contains(status))
}

/// Finishes or rolls back folder switches interrupted by a crash (start-up, see `tidy_profiles`).
pub(crate) fn tidy_restore(root: &Path, user_data: &Path) {
    for name in ["user-data.incoming", "user-data.opening"] {
        let dir = root.join(name);
        if !dir.is_dir() {
            continue;
        }
        let restored = dir.join("user-data");
        if name == "user-data.incoming" && !user_data.exists() && restored.is_dir() {
            // Crashed after the old data became evidence and before the new folder moved in: finish the switch.
            let _ = std::fs::rename(&restored, user_data);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Where unfinished sync jobs keep sealed files and downloads.
pub fn work_dir(data: &Path) -> PathBuf {
    data.join("sync")
}
