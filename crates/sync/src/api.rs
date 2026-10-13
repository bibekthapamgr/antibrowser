//! What the engine needs from the control plane and from object storage, as traits so the same engine runs against
//! the real API (desktop) and against an in-memory server with fault injection (tests).
//!
//! Data keys arrive here only inside [`InitResult`] and [`RestorePlan`], as [`SealKey`]s: never serialized, never
//! logged (their `Debug` is redacted), and dropped (zeroized) as soon as the file is sealed or opened.

use pb_seal::SealKey;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::sync::atomic::AtomicBool;

/// Failures the engine distinguishes. Everything else from the API is [`ApiError::Code`] with its stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// The server could not be reached, or its answer was lost. The job is kept and resumed later.
    #[error("the server could not be reached")]
    Offline,
    /// The session ended; sign in again. The job is kept.
    #[error("signed out")]
    SignedOut,
    /// `VERSION_CONFLICT`: another device committed a newer snapshot first.
    #[error("a newer snapshot exists (version {head_version})")]
    Conflict { head_version: i64 },
    /// `LEASE_HELD`: the profile is in use on another device.
    #[error("the profile is in use on another device")]
    LeaseHeld,
    /// `LEASE_NOT_HELD` / `FENCING_TOKEN_STALE`: this device's lease ended; the upload restarts under a new one.
    #[error("the lease was lost")]
    LeaseLost,
    #[error("the server refused the request ({code})")]
    Code { status: u16, code: String },
}

impl ApiError {
    pub fn code(&self) -> &str {
        match self {
            Self::Offline => "CLOUD_OFFLINE",
            Self::SignedOut => "CLOUD_SIGNED_OUT",
            Self::Conflict { .. } => "VERSION_CONFLICT",
            Self::LeaseHeld => "LEASE_HELD",
            Self::LeaseLost => "LEASE_NOT_HELD",
            Self::Code { code, .. } => code,
        }
    }
    pub fn is_code(&self, c: &str) -> bool {
        matches!(self, Self::Code { code, .. } if code == c)
    }
}

/// Failures of the signed-URL transfer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ObjectError {
    #[error("storage could not be reached")]
    Offline,
    /// The signed URL expired (a new one is requested).
    #[error("the transfer link expired")]
    Expired,
    #[error("storage refused the transfer ({0})")]
    Refused(String),
    #[error("cancelled")]
    Cancelled,
    #[error("local file error")]
    Local,
}

#[derive(Debug, Clone, Serialize)]
pub struct InitRequest {
    pub base_version: i64,
    pub fencing_token: String,
    pub platform: String,
    pub browser_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_size: Option<u64>,
}

/// `POST …/snapshots/init`. The data key is only in memory.
pub struct InitResult {
    pub operation_id: String,
    pub snapshot_id: String,
    pub org_id: String,
    pub profile_id: String,
    pub key_version: String,
    pub schema_version: u32,
    pub data_key: SealKey,
    pub part_size: u64,
    pub max_parts: u32,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PartUrl {
    pub part_number: u32,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StoredPart {
    pub part_number: u32,
    pub size: u64,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitPart {
    pub part_number: u32,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitRequest {
    pub fencing_token: String,
    pub digest: String,
    pub ciphertext_size: u64,
    pub plaintext_size: u64,
    pub parts: Vec<CommitPart>,
}

/// A server-side sync operation (`uploading`, `verifying`, `committed`, `failed`, `canceled`, `expired`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Operation {
    pub id: String,
    pub state: String,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub error_code: Option<String>,
}

/// A committed snapshot as the restore plan describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub version: i64,
    pub digest: String,
    pub ciphertext_size: u64,
    pub plaintext_size: u64,
    pub platform: String,
    pub browser_version: String,
    pub schema_version: u32,
    /// The device that made it (`None`: unknown).
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub committed_at: Option<String>,
}

/// `POST …/restore-plans`.
pub struct RestorePlan {
    pub snapshot: SnapshotInfo,
    pub head_version: i64,
    pub download_url: String,
    pub org_id: String,
    pub profile_id: String,
    /// The key version bound into the sealed file's header.
    pub key_version: String,
    pub data_key: SealKey,
}

pub trait SyncApi: Send + Sync {
    /// Returns the fencing token. `idempotency_key` makes a retried acquisition (answer lost) return the same lease.
    fn acquire_lease(
        &self,
        org: &str,
        profile: &str,
        idempotency_key: &str,
    ) -> Result<String, ApiError>;
    fn renew_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError>;
    fn release_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError>;
    fn init(
        &self,
        org: &str,
        profile: &str,
        idempotency_key: &str,
        req: &InitRequest,
    ) -> Result<InitResult, ApiError>;
    fn part_urls(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        parts: &[u32],
    ) -> Result<Vec<PartUrl>, ApiError>;
    fn stored_parts(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<Vec<StoredPart>, ApiError>;
    fn commit(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        req: &CommitRequest,
    ) -> Result<Operation, ApiError>;
    fn cancel(&self, org: &str, profile: &str, snapshot: &str) -> Result<(), ApiError>;
    fn operation(&self, org: &str, operation: &str) -> Result<Operation, ApiError>;
    fn restore_plan(
        &self,
        org: &str,
        profile: &str,
        snapshot: Option<&str>,
    ) -> Result<RestorePlan, ApiError>;
    /// The newest committed snapshot's metadata (no key, no link), or `None` when the profile has no backup yet.
    fn latest(&self, org: &str, profile: &str) -> Result<Option<SnapshotInfo>, ApiError>;
}

pub trait Objects: Send + Sync {
    /// Uploads one part; returns its ETag.
    fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, ObjectError>;
    /// Appends the object from byte `start` to `out`; returns the offset reached. When the server ignores the range,
    /// `restart` is called first (the caller truncates its file) and the offset counts from 0.
    fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, ObjectError>;
}

impl Objects for pb_cloud::Transfer {
    fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, ObjectError> {
        pb_cloud::Transfer::put_part(self, url, bytes).map_err(map_transfer)
    }
    fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, ObjectError> {
        pb_cloud::Transfer::download(self, url, start, out, restart, cancel, progress)
            .map_err(map_transfer)
    }
}

fn map_transfer(e: pb_cloud::TransferError) -> ObjectError {
    use pb_cloud::{HttpError, TransferError as T};
    match e {
        T::Http(HttpError::Offline) => ObjectError::Offline,
        T::Http(other) => ObjectError::Refused(format!("{other:?}")),
        T::Expired => ObjectError::Expired,
        T::Status(s) => ObjectError::Refused(s.to_string()),
        T::Cancelled => ObjectError::Cancelled,
        T::Io => ObjectError::Local,
    }
}
