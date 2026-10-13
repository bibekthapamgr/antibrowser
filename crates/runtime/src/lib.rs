//! Browser runtime crate: profile identity and directory layout (01), validated launch specs, the run-state
//! machine, per-profile locks, process-tree discovery, Chromium preference writing and last-good backups (03).
//!
//! Boundary: this crate isolates *stored browser data* by giving each profile its own Chromium
//! user-data directory. It does not, and must not claim to, change device or network signals.

pub mod backup;
pub mod id;
pub mod inspect;
pub mod launch;
pub mod layout;
pub mod lock;
pub mod prefs;
pub mod procs;
pub mod state;

pub use id::{
    ClientId, DeviceId, FilterId, ImportJobId, InvalidClientId, InvalidDeviceId, InvalidFilterId,
    InvalidImportJobId, InvalidProfileId, InvalidTagId, InvalidTemplateId, InvalidWorkspaceId,
    ProfileId, TagId, TemplateId, WorkspaceId, random_hex,
};
pub use inspect::{ProcRecord, ProcessInfo, ProcessInspector, SystemInspector};
pub use launch::{
    ALLOWED_EXTRA_SWITCHES, BrowserInstall, LaunchError, LaunchRequest, LaunchSpec, Launcher,
    MAX_START_URLS, ProfileState, Spawned, SystemLauncher, prepare_launch, valid_start_url,
};
pub use layout::{LayoutError, ProfileDirs, ProfilesRoot, simplify_path};
pub use lock::ProfileLock;
pub use prefs::{BrowserPrefs, PermissionDefault};
pub use state::{RunEvent, RunState};
