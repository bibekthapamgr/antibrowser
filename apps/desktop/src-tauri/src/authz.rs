//! Authorization placeholder (milestone 04).
//!
//! Every profile-management action that will need a permission check once workspaces are shared passes through
//! [`authorize`]. In the local, single-user workspace of this milestone the device owner may do everything, so the
//! check only enforces the size limits. Milestone 06 (organizations and roles) and milestone 08 (team access and
//! leases) replace the body; the call sites already pass what such a check needs.

use crate::ipc::{self, IpcError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    BulkEdit,
    DeletePermanently,
    ImportConfiguration,
    /// Exported files leave the device; in 06/08 this needs an explicit permission.
    ExportConfiguration,
}

pub fn authorize(action: Action, profiles: usize) -> Result<(), IpcError> {
    let _ = action; // local owner: allowed (see module docs)
    if profiles > pb_storage::bulk::MAX_BULK {
        return Err(ipc::SELECTION_TOO_LARGE);
    }
    Ok(())
}
