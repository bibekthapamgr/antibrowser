//! The upload and restore engine. Every step is saved before the next begins, so an interrupted job (network gone,
//! app killed, computer asleep) resumes from where it stopped:
//!
//! ```text
//! upload:  LocalDirty → Preparing (lease, init, seal) → Uploading (parts) → Verifying (server checks) → Committed
//!                         ↘ Conflict (another device committed first: nothing overwritten)
//! restore: Planning → Downloading (resumable) → Opening (SHA-256, then authenticated decryption into a fresh folder)
//!          → Ready (the caller switches folders atomically) → Done
//! ```
//!
//! Rules:
//!  - An upload is committed at most once: the init request carries an idempotency key, and a resumed upload asks
//!    the server for the operation's state before sending anything again.
//!  - Losing the lease, an expired upload or a failed verification restarts the upload under a new snapshot id (the
//!    sealed file is bound to its snapshot id, so it is never reused); restarts are bounded.
//!  - Milestone 08: an upload under a shared session's lease ([`LeaseMode::Session`]) never takes or releases a lease
//!    itself; if the lease was taken over or revoked it ends (`LEASE_TAKEN_OVER`, `LEASE_REVOKED`, …) instead of taking
//!    the profile back. A recovery upload ([`LeaseMode::Recovery`]) is kept by the server and never becomes the head.
//!  - A conflict never overwrites anything: the newer snapshot stays the head, this device's profile stays as it is,
//!    and the user chooses.
//!  - A restore never touches the current profile: it is downloaded, verified and unpacked into a fresh folder, and
//!    only the caller's switch replaces the profile (keeping the previous data).

use crate::api::{
    ApiError, CommitPart, CommitRequest, InitRequest, ObjectError, Objects, SnapshotInfo, SyncApi,
};
use crate::job::{
    Job, JobStore, LeaseMode, RestoreJob, RestoreState, SealedFile, UploadJob, UploadState,
    random_id,
};
use pb_seal::{Binding, Kind, Limits, Member, SealError};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// An upload restarts from scratch at most this many times before it is marked failed.
pub const MAX_RESTARTS: u32 = 3;
/// Part URLs are requested this many at a time (they expire after 15 minutes).
const URL_BATCH: usize = 8;
/// The lease is renewed at least this often during a long upload (leases last 2–10 minutes).
const RENEW_EVERY: Duration = Duration::from_secs(45);
/// Free space kept beyond what a restore needs.
pub const RESTORE_HEADROOM: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    /// The API answered with an error the engine does not resolve itself (offline, signed out, lease held, or a
    /// transient server error). The job is saved and can be resumed.
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error("storage could not be reached")]
    StorageOffline,
    #[error("storage refused the transfer")]
    Storage(String),
    /// The upload needs to (re)seal the profile, but the profile was not offered (it is open, or not on this device).
    #[error("the profile must be closed to back it up")]
    NeedsProfile,
    #[error("cancelled")]
    Cancelled,
    /// A local failure (disk full, file error) with a stable code.
    #[error("local error {0}")]
    Local(String),
    #[error("the job could not be saved: {0}")]
    Store(String),
}

impl SyncError {
    pub fn code(&self) -> String {
        match self {
            Self::Api(e) => e.code().to_owned(),
            Self::StorageOffline => "STORAGE_OFFLINE".into(),
            Self::Storage(_) => "STORAGE_REFUSED".into(),
            Self::NeedsProfile => "PROFILE_NOT_CLOSED".into(),
            Self::Cancelled => "CANCELED".into(),
            Self::Local(c) => c.clone(),
            Self::Store(_) => "SYNC_STORE_FAILED".into(),
        }
    }
    /// Worth retrying later without user action.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Api(ApiError::Offline) | Self::StorageOffline => true,
            Self::Api(ApiError::Code { status, .. }) => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

fn local(e: io::Error) -> SyncError {
    SyncError::Local(if e.kind() == io::ErrorKind::StorageFull {
        "LOW_DISK_SPACE".into()
    } else {
        "SYNC_IO_ERROR".into()
    })
}

fn seal_err(e: SealError) -> SyncError {
    match e {
        SealError::Cancelled => SyncError::Cancelled,
        SealError::ChangedDuringBackup => SyncError::NeedsProfile,
        other => SyncError::Local(other.code().into()),
    }
}

fn object_err(e: ObjectError) -> SyncError {
    match e {
        ObjectError::Offline => SyncError::StorageOffline,
        ObjectError::Cancelled => SyncError::Cancelled,
        ObjectError::Local => SyncError::Local("SYNC_IO_ERROR".into()),
        ObjectError::Expired => SyncError::Storage("expired".into()),
        ObjectError::Refused(s) => SyncError::Storage(s),
    }
}

/// A client error the engine cannot fix by retrying (permission, quota, size, missing profile…).
fn permanent(e: &ApiError) -> bool {
    matches!(e, ApiError::Code { status, .. } if (400..500).contains(status) && ![408, 409, 429].contains(status))
}

/// How long a single run waits for the server's verification before returning [`Outcome::Waiting`].
#[derive(Clone, Copy, Debug)]
pub struct Poll {
    pub interval: Duration,
    pub max_wait: Duration,
}

impl Default for Poll {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(2),
            max_wait: Duration::from_secs(120),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The job reached a terminal state (see its `state`).
    Finished,
    /// Still verifying on the server; run again later.
    Waiting,
}

/// The closed profile an upload seals.
pub struct Source<'a> {
    pub user_data: &'a Path,
    /// The profile's settings (exported from the app's own database, not from the browser's files).
    pub settings_json: Option<&'a [u8]>,
    /// The profile's own stored website sessions, decrypted from the source computer's browser cookie store and
    /// carried inside this (end-to-end-encrypted) snapshot so an enrolled teammate's computer can restore them
    /// without a fresh sign-in (ADR-0028). Only ever set for workspace (organization) snapshots, never for
    /// local-only backups, and only ever held inside the sealed container — never written to disk in the clear.
    pub portable_cookies: Option<&'a [u8]>,
    pub platform: &'a str,
    pub browser_version: &'a str,
    pub app_version: &'a str,
}

/// What a restore checks before it downloads.
pub trait RestoreChecks {
    /// `Err(code)` when this computer cannot use the snapshot (for example an older browser than the one that made
    /// it).
    fn compatible(&self, snapshot: &SnapshotInfo) -> Result<(), String>;
    fn free_space(&self, path: &Path) -> io::Result<u64>;
}

/// Progress for the UI: (job id, phase, done, total).
pub type ProgressFn<'a> = dyn Fn(&str, &'static str, u64, u64) + Sync + 'a;

pub struct Engine<'a> {
    pub api: &'a dyn SyncApi,
    pub objects: &'a dyn Objects,
    pub jobs: &'a dyn JobStore,
    /// Sealed files waiting for upload and downloads in progress (`<data>/sync`).
    pub work_dir: &'a Path,
    pub cancel: &'a AtomicBool,
    pub progress: &'a ProgressFn<'a>,
    pub poll: Poll,
}

/// The restored snapshot's metadata members (`snapshot.json`, `settings.json`) and size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub snapshot: SnapshotInfo,
    pub head_version: i64,
    pub meta: BTreeMap<String, Vec<u8>>,
    pub files: u64,
    pub bytes: u64,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Engine<'_> {
    fn save_upload(&self, job: &UploadJob) -> Result<(), SyncError> {
        self.jobs
            .save(&Job::Upload(job.clone()))
            .map_err(SyncError::Store)
    }
    fn save_restore(&self, job: &RestoreJob) -> Result<(), SyncError> {
        self.jobs
            .save(&Job::Restore(job.clone()))
            .map_err(SyncError::Store)
    }
    fn check_cancel(&self) -> Result<(), SyncError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(SyncError::Cancelled)
        } else {
            Ok(())
        }
    }

    pub fn sealed_path(&self, snapshot_id: &str) -> PathBuf {
        self.work_dir.join(format!("{snapshot_id}.pbseal"))
    }
    fn partial_path(&self, snapshot_id: &str) -> PathBuf {
        self.work_dir.join(format!("{snapshot_id}.pbseal.part"))
    }
    pub fn download_path(&self, snapshot_id: &str) -> PathBuf {
        self.work_dir.join(format!("{snapshot_id}.download"))
    }

    fn remove_local(&self, job: &UploadJob) {
        if let Some(s) = &job.snapshot_id {
            let _ = fs::remove_file(self.sealed_path(s));
            let _ = fs::remove_file(self.partial_path(s));
        }
    }

    // ===================================================================================================== upload

    /// Runs (or resumes) an upload until it reaches a terminal state or must wait. `source` is needed only when the
    /// profile has to be sealed (a fresh job, or a restart); a resumed upload of an existing sealed file needs none.
    pub fn upload(
        &self,
        job: &mut UploadJob,
        source: Option<&Source<'_>>,
    ) -> Result<Outcome, SyncError> {
        loop {
            if job.state.is_terminal() {
                return Ok(Outcome::Finished);
            }
            self.check_cancel()?;
            match job.state {
                UploadState::LocalDirty => {
                    job.state = UploadState::Preparing;
                    self.save_upload(job)?;
                }
                UploadState::Preparing => self.prepare(job, source)?,
                UploadState::Uploading => self.send(job)?,
                UploadState::Verifying => {
                    if !self.verify(job)? {
                        return Ok(Outcome::Waiting);
                    }
                }
                _ => return Ok(Outcome::Finished),
            }
        }
    }

    /// Runs only the steps that need the closed profile (lease, init, sealing) and stops once the sealed file is
    /// ready, so the caller can release the profile before the (possibly long) transfer.
    pub fn seal(&self, job: &mut UploadJob, source: &Source<'_>) -> Result<(), SyncError> {
        loop {
            self.check_cancel()?;
            match job.state {
                UploadState::LocalDirty => {
                    job.state = UploadState::Preparing;
                    self.save_upload(job)?;
                }
                UploadState::Preparing => self.prepare(job, Some(source))?,
                _ => return Ok(()),
            }
        }
    }

    /// Gives up on an upload with a local reason (for example the disk is full): the server's pending upload is
    /// canceled and the last committed snapshot stays the head.
    pub fn fail_upload(&self, job: &mut UploadJob, code: &str) -> Result<(), SyncError> {
        if job.state.is_terminal() {
            return Ok(());
        }
        self.fail(job, code)
    }

    /// Cancels an unfinished upload (the profile keeps its last committed snapshot).
    pub fn cancel_upload(&self, job: &mut UploadJob) -> Result<(), SyncError> {
        if job.state.is_terminal() {
            return Ok(());
        }
        if let Some(s) = &job.snapshot_id {
            let _ = self.api.cancel(&job.org_id, &job.org_profile_id, s);
        }
        self.remove_local(job);
        self.release(job);
        job.state = UploadState::Canceled;
        job.error_code = Some("CANCELED".into());
        self.save_upload(job)
    }

    fn release(&self, job: &mut UploadJob) {
        // Only an upload's own lease is released here; a session releases its lease after the commit.
        if job.lease_mode == LeaseMode::Job
            && let Some(t) = job.fencing_token.take()
        {
            let _ = self.api.release_lease(&job.org_id, &job.org_profile_id, &t);
        }
        job.lease_key = None;
    }

    /// The lease answered "not yours": an upload's own lease restarts the upload under a new one; a session's upload
    /// ends when the lease was taken over or revoked (the session decides what happens to the local copy) and waits
    /// when it merely expired (the session revives it with its next heartbeat).
    fn lease_error(&self, job: &mut UploadJob, e: ApiError, counts: bool) -> Result<(), SyncError> {
        match (&job.lease_mode, e) {
            (LeaseMode::Job, ApiError::LeaseLost | ApiError::Fenced { .. }) => {
                self.restart(job, "LEASE_NOT_HELD", counts, true)
            }
            (LeaseMode::Session { .. }, ApiError::Fenced { state }) => {
                self.fail(job, &fenced_code(&state))
            }
            (LeaseMode::Session { .. }, e) | (LeaseMode::Job, e) => Err(e.into()),
            (LeaseMode::Recovery { .. }, e) => self.fail(job, e.code()),
        }
    }

    /// Makes sure this device holds the profile's lease (renewing it, or acquiring a new one).
    fn ensure_lease(&self, job: &mut UploadJob) -> Result<(), SyncError> {
        if job.lease_mode != LeaseMode::Job {
            // A session's upload uses the session's token (the session heartbeats); a recovery upload has none to
            // keep.
            return if job.fencing_token.is_some() {
                Ok(())
            } else {
                self.fail(job, "LEASE_LOST")
            };
        }
        if let Some(t) = job.fencing_token.clone() {
            match self.api.renew_lease(&job.org_id, &job.org_profile_id, &t) {
                Ok(()) => return Ok(()),
                Err(ApiError::LeaseLost | ApiError::Fenced { .. }) => {
                    // A sealed file or an upload under the old lease cannot be committed any more.
                    let started = job.snapshot_id.is_some();
                    self.restart(job, "LEASE_NOT_HELD", started, true)?;
                    if job.state.is_terminal() {
                        return Ok(());
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        let key = match &job.lease_key {
            Some(k) => k.clone(),
            None => {
                let k = random_id("lease-").map_err(|_| SyncError::Local("RNG".into()))?;
                job.lease_key = Some(k.clone());
                self.save_upload(job)?;
                k
            }
        };
        let token = self
            .api
            .acquire_lease(&job.org_id, &job.org_profile_id, &key)?;
        job.fencing_token = Some(token);
        job.lease_key = None;
        self.save_upload(job)
    }

    /// Abandons the current snapshot and goes back to Preparing (or Failed after too many restarts).
    fn restart(
        &self,
        job: &mut UploadJob,
        reason: &str,
        counts: bool,
        lease_lost: bool,
    ) -> Result<(), SyncError> {
        if let Some(s) = &job.snapshot_id {
            // Best effort: an upload that is not canceled expires on the server by itself.
            let _ = self.api.cancel(&job.org_id, &job.org_profile_id, s);
        }
        self.remove_local(job);
        job.snapshot_id = None;
        job.operation_id = None;
        job.init_key = None;
        job.key_version = None;
        job.sealed = None;
        job.parts.clear();
        if lease_lost {
            job.fencing_token = None;
            job.lease_key = None;
        }
        if counts {
            job.restarts += 1;
        }
        job.error_code = Some(reason.to_owned());
        if job.restarts > MAX_RESTARTS {
            self.release(job);
            job.state = UploadState::Failed;
        } else {
            job.state = UploadState::Preparing;
        }
        self.save_upload(job)
    }

    fn fail(&self, job: &mut UploadJob, code: &str) -> Result<(), SyncError> {
        if let Some(s) = &job.snapshot_id {
            let _ = self.api.cancel(&job.org_id, &job.org_profile_id, s);
        }
        self.remove_local(job);
        self.release(job);
        job.state = UploadState::Failed;
        job.error_code = Some(code.to_owned());
        self.save_upload(job)
    }

    fn conflict(&self, job: &mut UploadJob, head: Option<i64>) -> Result<(), SyncError> {
        // The sealed file is bound to a snapshot that will never be committed; the profile itself is untouched.
        self.remove_local(job);
        self.release(job);
        job.state = UploadState::Conflict;
        job.head_version = head;
        job.error_code = Some("VERSION_CONFLICT".into());
        self.save_upload(job)
    }

    fn prepare(&self, job: &mut UploadJob, source: Option<&Source<'_>>) -> Result<(), SyncError> {
        self.ensure_lease(job)?;
        if job.state != UploadState::Preparing {
            return Ok(());
        }
        if let (Some(s), Some(_)) = (&job.snapshot_id, &job.sealed)
            && self.sealed_path(s).is_file()
        {
            job.state = UploadState::Uploading;
            return self.save_upload(job);
        }
        let source = source.ok_or(SyncError::NeedsProfile)?;
        let Some(fencing) = job.fencing_token.clone() else {
            return Ok(()); // lease lost again: the loop acquires a new one
        };
        let init_key = match &job.init_key {
            Some(k) => k.clone(),
            None => {
                let k = random_id("init-").map_err(|_| SyncError::Local("RNG".into()))?;
                job.init_key = Some(k.clone());
                self.save_upload(job)?;
                k
            }
        };
        let req = InitRequest {
            base_version: job.base_version,
            fencing_token: fencing,
            platform: source.platform.to_owned(),
            browser_version: source.browser_version.to_owned(),
            estimated_size: None,
            recovery: job.is_recovery(),
        };
        let init = match self
            .api
            .init(&job.org_id, &job.org_profile_id, &init_key, &req)
        {
            Ok(i) => i,
            Err(ApiError::Conflict { head_version }) => {
                return self.conflict(job, Some(head_version));
            }
            Err(e @ (ApiError::LeaseLost | ApiError::Fenced { .. })) => {
                return self.lease_error(job, e, false);
            }
            Err(e) if e.is_code("IDEMPOTENCY_KEY_REUSED") => {
                // The request changed since the key was used (new lease, new browser): start a new upload.
                job.init_key = None;
                return self.save_upload(job);
            }
            Err(e) if permanent(&e) => return self.fail(job, e.code()),
            Err(e) => return Err(e.into()),
        };
        if init.org_id != job.org_id || init.profile_id != job.org_profile_id {
            return self.fail(job, "BAD_RESPONSE");
        }
        job.snapshot_id = Some(init.snapshot_id.clone());
        job.operation_id = Some(init.operation_id.clone());
        job.key_version = Some(init.key_version.clone());
        job.part_size = init.part_size.max(1);
        job.parts.clear();
        self.save_upload(job)?;

        fs::create_dir_all(self.work_dir).map_err(local)?;
        let partial = self.partial_path(&init.snapshot_id);
        let _ = fs::remove_file(&partial);
        let snapshot_meta = serde_json::to_vec_pretty(&json!({
            "format": "project-browser-snapshot",
            "schema_version": init.schema_version,
            "org_id": job.org_id,
            "profile_id": job.org_profile_id,
            "snapshot_id": init.snapshot_id,
            "base_version": job.base_version,
            "platform": source.platform,
            "browser_version": source.browser_version,
            "app_version": source.app_version,
            "created_at_unix": now_unix(),
        }))
        .map_err(|_| SyncError::Local("SYNC_IO_ERROR".into()))?;
        let mut members = vec![Member {
            name: "snapshot.json",
            bytes: &snapshot_meta,
        }];
        if let Some(s) = source.settings_json {
            members.push(Member {
                name: "settings.json",
                bytes: s,
            });
        }
        // Workspace snapshots only: the profile's own re-keyable sessions ride inside the same encrypted container
        // (the member is sealed under the snapshot data key alongside everything else, ADR-0028).
        if let Some(c) = source.portable_cookies {
            members.push(Member {
                name: "cookies.json",
                bytes: c,
            });
        }
        let binding = Binding {
            kind: Kind::OrgSnapshot,
            org_id: Some(job.org_id.clone()),
            profile_id: job.org_profile_id.clone(),
            object_id: init.snapshot_id.clone(),
            key_version: init.key_version.clone(),
        };
        let total = pb_seal::archive::measure(source.user_data).unwrap_or(0);
        let id = job.id.clone();
        let outcome = pb_seal::seal_profile(
            source.user_data,
            &members,
            &init.data_key,
            &binding,
            &partial,
            self.cancel,
            &mut |done| (self.progress)(&id, "sealing", done, total),
        )
        .map_err(seal_err)?;
        drop(init.data_key); // wiped
        let parts = outcome.sealed_bytes.div_ceil(job.part_size).max(1);
        if outcome.sealed_bytes > init.max_bytes || parts > u64::from(init.max_parts) {
            let _ = fs::remove_file(&partial);
            return self.fail(job, "SNAPSHOT_TOO_LARGE");
        }
        fs::rename(&partial, self.sealed_path(&init.snapshot_id)).map_err(local)?;
        job.sealed = Some(SealedFile {
            digest: outcome.digest,
            size: outcome.sealed_bytes,
            plaintext_size: outcome.stats.bytes,
            files: outcome.stats.files,
        });
        job.state = UploadState::Uploading;
        self.save_upload(job)
    }

    fn part_len(sealed: &SealedFile, part_size: u64, n: u32) -> u64 {
        let start = u64::from(n - 1) * part_size;
        sealed.size.saturating_sub(start).min(part_size)
    }

    /// Sends the missing parts, then commits.
    fn send(&self, job: &mut UploadJob) -> Result<(), SyncError> {
        self.ensure_lease(job)?;
        if job.state != UploadState::Uploading {
            return Ok(());
        }
        let (Some(snapshot), Some(op_id), Some(sealed)) = (
            job.snapshot_id.clone(),
            job.operation_id.clone(),
            job.sealed.clone(),
        ) else {
            return self.restart(job, "LOCAL_STATE_LOST", true, false);
        };
        let file = self.sealed_path(&snapshot);
        if !file.is_file() {
            return self.restart(job, "LOCAL_FILE_MISSING", true, false);
        }
        // A commit whose answer was lost: the server already moved on. Never upload or commit twice.
        let op = self.api.operation(&job.org_id, &op_id)?;
        match op.state.as_str() {
            "uploading" => {}
            "verifying" | "committed" | "kept" => {
                job.state = UploadState::Verifying;
                return self.save_upload(job);
            }
            "failed" if op.error_code.as_deref() == Some("VERSION_CONFLICT") => {
                return self.conflict(job, None);
            }
            _ => {
                let reason = op.error_code.unwrap_or_else(|| op.state.to_uppercase());
                return self.restart(job, &reason, true, false);
            }
        }
        let org = job.org_id.clone();
        let prf = job.org_profile_id.clone();
        let part_size = job.part_size.max(1);
        let count = u32::try_from(sealed.size.div_ceil(part_size).max(1))
            .map_err(|_| SyncError::Local("SNAPSHOT_TOO_LARGE".into()))?;

        // What storage already holds (parts stored before an interruption); anything else is sent again.
        let stored = match self.api.stored_parts(&org, &prf, &snapshot) {
            Ok(p) => p,
            Err(e) if permanent(&e) => return self.restart(job, e.code(), true, false),
            Err(e) => return Err(e.into()),
        };
        let mut have = BTreeMap::new();
        for p in stored {
            if (1..=count).contains(&p.part_number)
                && p.size == Self::part_len(&sealed, part_size, p.part_number)
            {
                have.insert(p.part_number, p.etag);
            }
        }
        job.parts = have;
        self.save_upload(job)?;

        let missing: Vec<u32> = (1..=count).filter(|n| !job.parts.contains_key(n)).collect();
        let mut f = fs::File::open(&file).map_err(local)?;
        let mut renewed = Instant::now();
        let id = job.id.clone();
        for batch in missing.chunks(URL_BATCH) {
            self.check_cancel()?;
            if renewed.elapsed() >= RENEW_EVERY {
                self.ensure_lease(job)?;
                if job.state != UploadState::Uploading {
                    return Ok(());
                }
                renewed = Instant::now();
            }
            let urls = match self.api.part_urls(&org, &prf, &snapshot, batch) {
                Ok(u) => u,
                Err(e @ (ApiError::LeaseLost | ApiError::Fenced { .. })) => {
                    return self.lease_error(job, e, true);
                }
                Err(e) if e.is_code("SYNC_STATE_CONFLICT") || permanent(&e) => {
                    return self.restart(job, e.code(), true, false);
                }
                Err(e) => return Err(e.into()),
            };
            for n in batch {
                self.check_cancel()?;
                let Some(url) = urls.iter().find(|u| u.part_number == *n) else {
                    return Err(ApiError::Code {
                        status: 502,
                        code: "BAD_RESPONSE".into(),
                    }
                    .into());
                };
                let len = Self::part_len(&sealed, part_size, *n);
                let mut bytes = vec![0u8; len as usize];
                f.seek(SeekFrom::Start(u64::from(n - 1) * part_size))
                    .map_err(local)?;
                f.read_exact(&mut bytes).map_err(local)?;
                let etag = match self.objects.put_part(&url.url, &bytes) {
                    Ok(e) => e,
                    Err(ObjectError::Expired) => {
                        // The link expired while earlier parts were sending: one fresh link for this part.
                        let again = self.api.part_urls(&org, &prf, &snapshot, &[*n])?;
                        let u = again.first().ok_or(SyncError::Api(ApiError::Code {
                            status: 502,
                            code: "BAD_RESPONSE".into(),
                        }))?;
                        self.objects.put_part(&u.url, &bytes).map_err(object_err)?
                    }
                    Err(e) => return Err(object_err(e)),
                };
                job.parts.insert(*n, etag);
                self.save_upload(job)?;
                let done: u64 = job
                    .parts
                    .keys()
                    .map(|p| Self::part_len(&sealed, part_size, *p))
                    .sum();
                (self.progress)(&id, "uploading", done, sealed.size);
            }
        }

        let Some(fencing) = job.fencing_token.clone() else {
            return Ok(());
        };
        let req = CommitRequest {
            fencing_token: fencing,
            digest: sealed.digest.clone(),
            ciphertext_size: sealed.size,
            plaintext_size: sealed.plaintext_size,
            parts: job
                .parts
                .iter()
                .map(|(n, e)| CommitPart {
                    part_number: *n,
                    etag: e.clone(),
                })
                .collect(),
        };
        match self.api.commit(&org, &prf, &snapshot, &req) {
            Ok(_) => {
                job.state = UploadState::Verifying;
                self.save_upload(job)
            }
            Err(ApiError::Conflict { head_version }) => self.conflict(job, Some(head_version)),
            Err(e @ (ApiError::LeaseLost | ApiError::Fenced { .. })) => {
                self.lease_error(job, e, true)
            }
            Err(e)
                if e.is_code("UPLOAD_INCOMPLETE")
                    || e.is_code("SYNC_STATE_CONFLICT")
                    || e.is_code("NOT_FOUND") =>
            {
                self.restart(job, e.code(), true, false)
            }
            Err(e) if permanent(&e) => self.fail(job, e.code()),
            Err(e) => Err(e.into()),
        }
    }

    /// Waits for the server's verification. `Ok(false)`: still verifying after `poll.max_wait`.
    fn verify(&self, job: &mut UploadJob) -> Result<bool, SyncError> {
        let Some(op_id) = job.operation_id.clone() else {
            self.restart(job, "LOCAL_STATE_LOST", true, false)?;
            return Ok(true);
        };
        let started = Instant::now();
        loop {
            let op = self.api.operation(&job.org_id, &op_id)?;
            match op.state.as_str() {
                // `kept`: a recovery copy (milestone 08), stored but never a version.
                "committed" | "kept" => {
                    job.version = op.version;
                    job.state = UploadState::Committed;
                    job.error_code = None;
                    self.remove_local(job);
                    self.release(job);
                    self.save_upload(job)?;
                    return Ok(true);
                }
                "failed" if op.error_code.as_deref() == Some("VERSION_CONFLICT") => {
                    self.conflict(job, None)?;
                    return Ok(true);
                }
                "uploading" => {
                    // The commit never reached the server: send it again.
                    job.state = UploadState::Uploading;
                    self.save_upload(job)?;
                    return Ok(true);
                }
                "verifying" => {
                    if started.elapsed() >= self.poll.max_wait {
                        return Ok(false);
                    }
                    self.check_cancel()?;
                    std::thread::sleep(self.poll.interval);
                }
                _ => {
                    let reason = op.error_code.unwrap_or_else(|| op.state.to_uppercase());
                    if reason == "FENCING_TOKEN_STALE" && job.lease_mode != LeaseMode::Job {
                        // The session's lease ended while the server verified: this upload can never be the head.
                        self.fail(job, "LEASE_LOST")?;
                        return Ok(true);
                    }
                    // Verification failed (size, header, digest), or the upload expired: a fresh snapshot.
                    self.restart(job, &reason, true, false)?;
                    return Ok(true);
                }
            }
        }
    }

    // ==================================================================================================== restore

    /// Runs (or resumes) a restore up to [`RestoreState::Ready`]: the snapshot is downloaded (resuming), its SHA-256
    /// checked against the manifest, then authenticated, decrypted and unpacked into `dest` (created fresh). The
    /// current profile is not touched; the caller switches folders and then calls [`Engine::finish_restore`].
    pub fn restore(
        &self,
        job: &mut RestoreJob,
        dest: &Path,
        checks: &dyn RestoreChecks,
    ) -> Result<Option<Opened>, SyncError> {
        // Each pass gets a fresh plan; a link that keeps expiring (clock skew, storage misconfigured) stops here.
        for _ in 0..3 {
            self.check_cancel()?;
            if job.state.is_terminal() {
                return Ok(None);
            }
            // Ready after an interruption: the unpacked folder may be gone; unpack again from the kept download.
            if let Some(opened) = self.restore_step(job, dest, checks)? {
                return Ok(Some(opened));
            }
        }
        if job.state.is_terminal() {
            return Ok(None);
        }
        Err(SyncError::Storage("expired".into()))
    }

    fn fail_restore(&self, job: &mut RestoreJob, code: &str) -> Result<(), SyncError> {
        if let Some(s) = &job.snapshot {
            let _ = fs::remove_file(self.download_path(&s.id));
        }
        job.state = RestoreState::Failed;
        job.error_code = Some(code.to_owned());
        self.save_restore(job)
    }

    /// Removes the kept download once the caller has switched folders.
    pub fn finish_restore(&self, job: &mut RestoreJob) -> Result<(), SyncError> {
        if let Some(s) = &job.snapshot {
            let _ = fs::remove_file(self.download_path(&s.id));
        }
        job.state = RestoreState::Done;
        job.error_code = None;
        self.save_restore(job)
    }

    pub fn cancel_restore(&self, job: &mut RestoreJob, dest: &Path) -> Result<(), SyncError> {
        if let Some(s) = &job.snapshot {
            let _ = fs::remove_file(self.download_path(&s.id));
        }
        let _ = fs::remove_dir_all(dest);
        job.state = RestoreState::Canceled;
        self.save_restore(job)
    }

    fn restore_step(
        &self,
        job: &mut RestoreJob,
        dest: &Path,
        checks: &dyn RestoreChecks,
    ) -> Result<Option<Opened>, SyncError> {
        // A plan per run: download links and the data key are short-lived and never saved.
        let pinned = job
            .snapshot
            .as_ref()
            .map(|s| s.id.clone())
            .or_else(|| job.requested.clone());
        let plan = match self
            .api
            .restore_plan(&job.org_id, &job.org_profile_id, pinned.as_deref())
        {
            Ok(p) => p,
            Err(e) if permanent(&e) => {
                self.fail_restore(job, e.code())?;
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if plan.org_id != job.org_id
            || plan.profile_id != job.org_profile_id
            || pinned.as_deref().is_some_and(|p| p != plan.snapshot.id)
        {
            self.fail_restore(job, "BAD_RESPONSE")?;
            return Ok(None);
        }
        if job
            .snapshot
            .as_ref()
            .is_some_and(|s| s.digest != plan.snapshot.digest)
        {
            // The manifest changed under a pinned id: never mix bytes of two versions.
            self.fail_restore(job, "SNAPSHOT_CHANGED")?;
            return Ok(None);
        }
        let snap = plan.snapshot.clone();
        job.snapshot = Some(snap.clone());
        job.head_version = Some(plan.head_version);
        if let Err(code) = checks.compatible(&snap) {
            self.fail_restore(job, &code)?;
            return Ok(None);
        }
        fs::create_dir_all(self.work_dir).map_err(local)?;
        let download = self.download_path(&snap.id);
        let have = fs::metadata(&download).map(|m| m.len()).unwrap_or(0);
        let have = if have > snap.ciphertext_size { 0 } else { have };
        let needed = (snap.ciphertext_size - have)
            .saturating_add(snap.plaintext_size)
            .saturating_add(RESTORE_HEADROOM);
        let free = checks.free_space(self.work_dir).map_err(local)?;
        if free < needed {
            // Nothing was changed; the current profile is intact.
            self.fail_restore(job, "LOW_DISK_SPACE")?;
            return Ok(None);
        }
        let downloaded = have == snap.ciphertext_size
            && matches!(job.state, RestoreState::Opening | RestoreState::Ready);
        if !downloaded {
            job.state = RestoreState::Downloading;
            job.downloaded = have;
            self.save_restore(job)?;
            if have == 0 {
                // Start empty (a leftover larger than the snapshot is not resumable). Truncated through its own
                // handle: Windows refuses to change the length through an append-only handle.
                fs::File::create(&download).map_err(local)?;
            }
            // Append mode: after a restart (truncated through another handle) writes continue at the new end.
            let mut out = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&download)
                .map_err(local)?;
            let id = job.id.clone();
            let total = snap.ciphertext_size;
            let restart_target = download.clone();
            let reached = self.objects.download(
                &plan.download_url,
                have,
                &mut out,
                &mut || {
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&restart_target)?
                        .set_len(0)
                },
                self.cancel,
                &mut |done| (self.progress)(&id, "downloading", done, total),
            );
            let reached = match reached {
                Ok(r) => r,
                Err(ObjectError::Expired) => return Ok(None), // a new plan, a new link
                Err(e) => {
                    job.downloaded = fs::metadata(&download).map(|m| m.len()).unwrap_or(0);
                    self.save_restore(job)?;
                    return Err(object_err(e));
                }
            };
            drop(out);
            job.downloaded = reached;
        }
        // Size and SHA-256 must match the committed manifest before anything is decrypted (checked again on every
        // resume: the kept file could have been changed in between).
        let (digest, size) = pb_seal::digest_file(&download).map_err(local)?;
        if size != snap.ciphertext_size || digest != snap.digest {
            let _ = fs::remove_file(&download);
            job.downloaded = 0;
            self.fail_restore(job, "DIGEST_MISMATCH")?;
            return Ok(None);
        }
        job.state = RestoreState::Opening;
        self.save_restore(job)?;

        if dest.exists() {
            fs::remove_dir_all(dest).map_err(local)?;
        }
        fs::create_dir_all(dest).map_err(local)?;
        let binding = Binding {
            kind: Kind::OrgSnapshot,
            org_id: Some(job.org_id.clone()),
            profile_id: job.org_profile_id.clone(),
            object_id: snap.id.clone(),
            key_version: plan.key_version.clone(),
        };
        let limits = Limits {
            max_bytes: snap.plaintext_size.saturating_add(1 << 20),
            ..Limits::default()
        };
        let id = job.id.clone();
        let total = snap.plaintext_size;
        let opened = pb_seal::open_profile(
            &download,
            &plan.data_key,
            &binding,
            dest,
            &limits,
            self.cancel,
            &mut |done| (self.progress)(&id, "opening", done, total),
        );
        drop(plan.data_key);
        match opened {
            Ok(u) => {
                job.state = RestoreState::Ready;
                job.error_code = None;
                self.save_restore(job)?;
                Ok(Some(Opened {
                    snapshot: snap,
                    head_version: plan.head_version,
                    meta: u.meta,
                    files: u.files,
                    bytes: u.bytes,
                }))
            }
            Err(SealError::Cancelled) => {
                let _ = fs::remove_dir_all(dest);
                Err(SyncError::Cancelled)
            }
            Err(e) => {
                // Wrong key, modified file or unsafe archive: fail closed, nothing kept.
                let _ = fs::remove_dir_all(dest);
                self.fail_restore(job, e.code())?;
                Ok(None)
            }
        }
    }
}

/// Starts an upload job for a profile whose data changed since `base_version`.
/// The job error code for a lease that ended (`taken_over` → `LEASE_TAKEN_OVER`).
pub fn fenced_code(state: &str) -> String {
    let s: String = state
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(32)
        .collect::<String>()
        .to_uppercase();
    if s.is_empty() {
        "LEASE_LOST".into()
    } else {
        format!("LEASE_{s}")
    }
}

pub fn new_upload(
    local_profile_id: &str,
    org_id: &str,
    org_profile_id: &str,
    base_version: i64,
) -> Result<UploadJob, SyncError> {
    let id = random_id("sj_").map_err(|_| SyncError::Local("RNG".into()))?;
    Ok(UploadJob::new(
        id,
        local_profile_id,
        org_id,
        org_profile_id,
        base_version,
    ))
}
