//! Browser runtime crate: profile identity and directory layout (01), validated launch specs, the run-state
//! machine, per-profile locks, process-tree discovery, Chromium preference writing and last-good backups (03).
//!
//! Boundary: this crate isolates *stored browser data* by giving each profile its own Chromium
//! user-data directory. It does not, and must not claim to, change device or network signals.

pub mod backup;
pub mod environment;
pub mod extensions;
pub mod id;
pub mod inspect;
pub mod launch;
pub mod layout;
pub mod lock;
pub mod prefs;
pub mod procs;
pub mod state;

pub use environment::{PrivacyConfig, ProxyGeo, ProxyMatch, TextSize, WebRtcPolicy, WindowSize};
pub use id::{
    ClientId, DeviceId, FilterId, ImportJobId, InvalidClientId, InvalidDeviceId, InvalidFilterId,
    InvalidImportJobId, InvalidMigrationRunId, InvalidNetworkCheckId, InvalidProfileId,
    InvalidProxyId, InvalidTagId, InvalidTemplateId, InvalidWorkspaceId, MigrationRunId,
    NetworkCheckId, ProfileId, ProxyId, TagId, TemplateId, WorkspaceId, random_hex,
};
pub use inspect::{ProcRecord, ProcessInfo, ProcessInspector, SystemInspector};
pub use launch::{
    ALLOWED_EXTRA_SWITCHES, BrowserInstall, LaunchError, LaunchRequest, LaunchSpec, Launcher,
    MAX_START_URLS, NetworkLaunch, ProfileState, Spawned, SystemLauncher, apply_proxy_match,
    prepare_launch, valid_start_url,
};
pub use layout::{LayoutError, ProfileDirs, ProfilesRoot, simplify_path};
pub use lock::ProfileLock;
pub use prefs::{BrowserPrefs, PermissionDefault, PrivacyPrefs};
pub use state::{RunEvent, RunState};
