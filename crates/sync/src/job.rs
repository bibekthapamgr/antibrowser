//! Persistent job records. The engine saves the job after every step, so a killed app (or a lost network) resumes
//! from the last saved step instead of starting over, and never commits the same upload twice.
//!
//! Nothing secret is in a job: no data key, no signed URL, no access token. Fencing tokens and idempotency keys are
//! not secrets (they only work together with the device's session).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

/// Upload states. `LocalDirty → Preparing → Uploading → Verifying → Committed`; a failed or canceled job keeps the
/// last committed version as it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadState {
    /// The profile changed since its last committed snapshot; nothing started yet.
    LocalDirty,
    /// Lease, init (data key) and sealing into a local file.
    Preparing,
    /// Sending the sealed file's parts to signed URLs.
    Uploading,
    /// Committed by the device; the server verifies size, header and SHA-256 before it becomes the new version.
    Verifying,
    Committed,
    /// Another device committed first. Nothing was overwritten; the user decides.
    Conflict,
    Failed,
    Canceled,
}

impl UploadState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Committed | Self::Conflict | Self::Failed | Self::Canceled
        )
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalDirty => "local_dirty",
            Self::Preparing => "preparing",
            Self::Uploading => "uploading",
            Self::Verifying => "verifying",
            Self::Committed => "committed",
            Self::Conflict => "conflict",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

/// Whose lease an upload runs under (milestone 08).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LeaseMode {
    /// The upload takes, renews and releases its own short upload lease (backups of a closed profile, milestone 07).
    /// Losing it restarts the upload under a new one.
    #[default]
    Job,
    /// The closing backup of a shared session: it uses the session's lease and token, never acquires or releases
    /// one itself (the session heartbeats and releases after the commit). If the lease was taken over or revoked the
    /// upload ends (`LEASE_TAKEN_OVER`, `LEASE_REVOKED`…) instead of taking the profile back.
    Session { lease_id: String },
    /// A recovery copy of a session lease this device lost: kept by the server, never the head.
    Recovery { lease_id: String },
}

/// The sealed file waiting to be uploaded (`<work dir>/<snapshot id>.pbseal`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedFile {
    pub digest: String,
    pub size: u64,
    pub plaintext_size: u64,
    pub files: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadJob {
    pub id: String,
    pub local_profile_id: String,
    pub org_id: String,
    pub org_profile_id: String,
    /// The committed version this device's copy is based on.
    pub base_version: i64,
    pub state: UploadState,
    /// Idempotency key of a lease acquisition in flight (answer possibly lost).
    #[serde(default)]
    pub lease_key: Option<String>,
    #[serde(default)]
    pub fencing_token: Option<String>,
    /// Idempotency key of the init request: a retry after a lost answer returns the same upload.
    #[serde(default)]
    pub init_key: Option<String>,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub key_version: Option<String>,
    #[serde(default)]
    pub part_size: u64,
    #[serde(default)]
    pub sealed: Option<SealedFile>,
    /// Uploaded parts: number → ETag (stored as a list: integer map keys do not survive the tagged `Job` enum).
    #[serde(default, with = "parts_list")]
    pub parts: BTreeMap<u32, String>,
    /// The version this snapshot became.
    #[serde(default)]
    pub version: Option<i64>,
    /// The newer version found on conflict.
    #[serde(default)]
    pub head_version: Option<i64>,
    #[serde(default)]
    pub error_code: Option<String>,
    /// Times the upload was restarted from scratch (lease lost, upload expired, verification failed).
    #[serde(default)]
    pub restarts: u32,
    /// Milestone 08: whose lease this upload runs under.
    #[serde(default)]
    pub lease_mode: LeaseMode,
}

impl UploadJob {
    pub fn new(
        id: String,
        local_profile_id: &str,
        org_id: &str,
        org_profile_id: &str,
        base_version: i64,
    ) -> Self {
        Self {
            id,
            local_profile_id: local_profile_id.to_owned(),
            org_id: org_id.to_owned(),
            org_profile_id: org_profile_id.to_owned(),
            base_version,
            state: UploadState::LocalDirty,
            lease_key: None,
            fencing_token: None,
            init_key: None,
            snapshot_id: None,
            operation_id: None,
            key_version: None,
            part_size: 0,
            sealed: None,
            parts: BTreeMap::new(),
            version: None,
            head_version: None,
            error_code: None,
            restarts: 0,
            lease_mode: LeaseMode::Job,
        }
    }

    /// The closing backup of a session: under the session's lease and token.
    pub fn under_session(mut self, lease_id: &str, fencing_token: &str) -> Self {
        self.lease_mode = LeaseMode::Session {
            lease_id: lease_id.to_owned(),
        };
        self.fencing_token = Some(fencing_token.to_owned());
        self
    }

    /// A recovery copy of what this device had under a session lease it lost (`fencing_token`: that lease's).
    pub fn as_recovery(mut self, lease_id: &str, fencing_token: &str) -> Self {
        self.lease_mode = LeaseMode::Recovery {
            lease_id: lease_id.to_owned(),
        };
        self.fencing_token = Some(fencing_token.to_owned());
        self
    }

    pub fn is_recovery(&self) -> bool {
        matches!(self.lease_mode, LeaseMode::Recovery { .. })
    }
    pub fn session_lease(&self) -> Option<&str> {
        match &self.lease_mode {
            LeaseMode::Session { lease_id } => Some(lease_id),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreState {
    Planning,
    Downloading,
    /// Downloaded and verified (SHA-256); being authenticated, decrypted and unpacked into a fresh folder.
    Opening,
    /// Unpacked into the fresh folder; waiting for the caller's atomic switch.
    Ready,
    Done,
    Failed,
    Canceled,
}

impl RestoreState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Canceled)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Downloading => "downloading",
            Self::Opening => "opening",
            Self::Ready => "ready",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

/// Where a restore goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreTarget {
    /// Replace the linked local profile's data (the current data is kept as evidence).
    Replace,
    /// A new local profile (rollback-to-copy, or first restore on this computer).
    Copy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreJob {
    pub id: String,
    pub org_id: String,
    pub org_profile_id: String,
    /// The local profile the data goes into (for a copy: created before the switch).
    pub local_profile_id: String,
    pub target: RestoreTarget,
    /// The snapshot asked for (`None`: the newest).
    #[serde(default)]
    pub requested: Option<String>,
    /// Link the target to the organization profile once restored (first restore on this computer). A rollback copy
    /// stays an unlinked local profile.
    #[serde(default)]
    pub link_after: bool,
    pub state: RestoreState,
    /// Pinned at the first plan, so a resumed download continues the same snapshot.
    #[serde(default)]
    pub snapshot: Option<crate::api::SnapshotInfo>,
    #[serde(default)]
    pub head_version: Option<i64>,
    #[serde(default)]
    pub downloaded: u64,
    #[serde(default)]
    pub error_code: Option<String>,
}

impl RestoreJob {
    pub fn new(
        id: String,
        org_id: &str,
        org_profile_id: &str,
        local_profile_id: &str,
        target: RestoreTarget,
        requested: Option<&str>,
    ) -> Self {
        Self {
            id,
            org_id: org_id.to_owned(),
            org_profile_id: org_profile_id.to_owned(),
            local_profile_id: local_profile_id.to_owned(),
            target,
            requested: requested.map(str::to_owned),
            link_after: false,
            state: RestoreState::Planning,
            snapshot: None,
            head_version: None,
            downloaded: 0,
            error_code: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Job {
    Upload(UploadJob),
    Restore(RestoreJob),
}

impl Job {
    pub fn id(&self) -> &str {
        match self {
            Self::Upload(j) => &j.id,
            Self::Restore(j) => &j.id,
        }
    }
    pub fn local_profile_id(&self) -> &str {
        match self {
            Self::Upload(j) => &j.local_profile_id,
            Self::Restore(j) => &j.local_profile_id,
        }
    }
    pub fn state(&self) -> &'static str {
        match self {
            Self::Upload(j) => j.state.as_str(),
            Self::Restore(j) => j.state.as_str(),
        }
    }
    pub fn is_terminal(&self) -> bool {
        match self {
            Self::Upload(j) => j.state.is_terminal(),
            Self::Restore(j) => j.state.is_terminal(),
        }
    }
}

/// Durable job storage (the desktop's SQLite; memory in tests).
pub trait JobStore: Send + Sync {
    fn save(&self, job: &Job) -> Result<(), String>;
}

/// Jobs kept as serialized JSON, exactly as a durable store would round-trip them.
#[derive(Default)]
pub struct MemoryJobs {
    jobs: Mutex<HashMap<String, String>>,
}

impl MemoryJobs {
    pub fn load(&self, id: &str) -> Option<Job> {
        let jobs = self.jobs.lock().ok()?;
        serde_json::from_str(jobs.get(id)?).ok()
    }
}

impl JobStore for MemoryJobs {
    fn save(&self, job: &Job) -> Result<(), String> {
        let json = serde_json::to_string(job).map_err(|e| e.to_string())?;
        self.jobs
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .insert(job.id().to_owned(), json);
        Ok(())
    }
}

mod parts_list {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub fn serialize<S: Serializer>(m: &BTreeMap<u32, String>, s: S) -> Result<S::Ok, S::Error> {
        m.iter().collect::<Vec<_>>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<u32, String>, D::Error> {
        Ok(Vec::<(u32, String)>::deserialize(d)?.into_iter().collect())
    }
}

/// A fresh random id with a prefix (jobs, idempotency keys).
pub fn random_id(prefix: &str) -> Result<String, getrandom::Error> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b)?;
    Ok(format!("{prefix}{}", hex::encode(b)))
}
