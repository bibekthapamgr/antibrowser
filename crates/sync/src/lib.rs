//! Encrypted snapshot synchronization (milestone 07, ADR-0014): the desktop side of
//! `init → upload parts → commit → server verification`, and of `restore plan → download → verify → open`.
//! Milestone 08 (ADR-0015) adds the session lease protocol ([`SessionApi`]): uploads that run under a shared
//! session's lease, and recovery copies from a device that lost its lease.
//!
//! - [`api`]: what the engine needs from the API and from object storage (traits; data keys stay in memory).
//! - [`job`]: persistent, secret-free job records, saved after every step.
//! - [`engine`]: the resumable state machines.
//! - [`portability`]: what a restored snapshot keeps on this computer (supported / sign-in required / unsupported).
//! - [`rest`]: the snapshot API over HTTP (paths, bodies, parsing, error mapping), shared by the desktop and tests.
//! - `fake` (feature `testing`): an in-memory server with the real rules and fault injection.

pub mod api;
pub mod engine;
pub mod job;
pub mod portability;
pub mod rest;

#[cfg(any(test, feature = "testing"))]
pub mod fake;

pub use api::{
    ApiError, Beat, HandoffNote, HandoffRequest, Holder, LeaseInfo, ObjectError, Objects,
    OpenRequest, SessionApi, SessionOpened, SessionOutcome, SnapshotInfo, SyncApi,
};
pub use engine::{Engine, Opened, Outcome, Poll, RestoreChecks, Source, SyncError, new_upload};
pub use job::{
    Job, JobStore, LeaseMode, MemoryJobs, RestoreJob, RestoreState, RestoreTarget, UploadJob,
    UploadState,
};

#[cfg(test)]
mod tests;
