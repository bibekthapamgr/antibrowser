//! Browser runtime crate (milestone 01 foundation; full lifecycle in milestone 03).
//!
//! Boundary: this crate isolates *stored browser data* by giving each profile its own Chromium
//! user-data directory. It does not, and must not claim to, change device or network signals.

pub mod id;
pub mod inspect;
pub mod launch;
pub mod layout;

pub use id::{
    DeviceId, InvalidDeviceId, InvalidProfileId, InvalidWorkspaceId, ProfileId, WorkspaceId,
    random_hex,
};
pub use inspect::{ProcessInfo, ProcessInspector, SystemInspector};
pub use launch::{
    BrowserInstall, LaunchError, LaunchRequest, LaunchSpec, Launcher, ProfileState, Spawned,
    SystemLauncher, prepare_launch,
};
pub use layout::{LayoutError, ProfileDirs, ProfilesRoot};
