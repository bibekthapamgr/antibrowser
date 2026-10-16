//! R3 (ADR-0022): the unified Profiles view of an account workspace. Rows come from the workspace's profile list (the
//! API); this module adds what only this computer knows — its local copy of each profile (by the R1 identity
//! mapping, `org_profile_links`), that copy's run state, shared-session phase and backup/restore status — and opens
//! a workspace profile through the one existing path: restore when there is a backup, the session lease, then the
//! browser (`launch_profile` → `launch_shared`). Nothing here starts a browser by itself or skips the lease.

use crate::ipc::{self, IpcError};
use crate::state::{AppState, ProfileView};
use crate::sync::SyncStatus;
use pb_cloud::Method;
use pb_runtime::{ProfileId, ProxyId};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// This computer's copy of a workspace profile.
#[derive(Serialize)]
pub struct WorkspaceCopy {
    pub org_profile_id: String,
    pub profile: ProfileView,
    pub sync: SyncStatus,
}

/// What opening a workspace profile did.
#[derive(Serialize)]
pub struct WorkspaceOpen {
    pub local_profile_id: String,
    /// The launch (or `None` while its newest backup downloads first; the launch follows by itself).
    pub operation_id: Option<String>,
    pub restoring: bool,
}

fn id_ok(prefix: &str, s: &str) -> bool {
    s.len() == prefix.len() + 27 && s.starts_with(prefix) && s.as_bytes()[prefix.len()] == b'_'
}

/// How long an open waits for the first download of a profile before giving up on starting it (the download goes on).
const RESTORE_WAIT: Duration = Duration::from_secs(60 * 60);

impl AppState {
    /// Every copy of this workspace's profiles on this computer, including ones still downloading.
    pub fn workspace_copies(&self, org_id: &str) -> Result<Vec<WorkspaceCopy>, IpcError> {
        if !id_ok("org", org_id) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for link in store.org_links(Some(org_id))? {
            let Some(p) = store.get_profile(&link.local_profile_id)? else {
                continue;
            };
            if p.trashed_at.is_some() || !seen.insert(link.org_profile_id.clone()) {
                continue;
            }
            let sync = self.sync_status(&p.id)?;
            out.push(WorkspaceCopy {
                org_profile_id: link.org_profile_id,
                profile: self.view(p),
                sync,
            });
        }
        // First downloads ("restore here"): the copy exists, its link follows when the data is in place.
        for (org_profile_id, local) in crate::sync::restoring_here_of(&store, org_id) {
            if !seen.insert(org_profile_id.clone()) {
                continue;
            }
            if let Some(p) = store.get_profile(&local)? {
                let sync = self.sync_status(&p.id)?;
                out.push(WorkspaceCopy {
                    org_profile_id,
                    profile: self.view(p),
                    sync,
                });
            }
        }
        Ok(out)
    }

    /// Makes sure this computer has a copy of a workspace profile: the existing one; or its newest backup restored
    /// into a new local profile; or, for a profile that was never backed up (just created), an empty local profile
    /// linked to it at once. `proxy` (this computer only) is set on a new copy; with it, `match_proxy` (default on,
    /// ADR-0027) makes the copy take its time zone and language from the proxy's location.
    pub fn workspace_profile_prepare(
        &self,
        org_id: &str,
        org_profile_id: &str,
        name: &str,
        proxy: Option<&ProxyId>,
        match_proxy: bool,
    ) -> Result<ProfileView, IpcError> {
        if !id_ok("org", org_id) || !id_ok("prf", org_profile_id) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        if let Some(local) = self.local_copy(org_id, org_profile_id)? {
            let p = store.get_profile(&local)?.ok_or(ipc::UNKNOWN_PROFILE)?;
            return Ok(self.view(p));
        }
        let made = match self.sync_restore_here(org_id, org_profile_id, name) {
            Ok(view) => view,
            Err(e) if e.code == ipc::SYNC_NO_BACKUP.code => {
                self.link_empty_copy(org_id, org_profile_id, name)?
            }
            Err(e) => return Err(e),
        };
        match proxy {
            Some(proxy) => {
                let id = ProfileId::parse(&made.id).map_err(|_| ipc::INTERNAL)?;
                // A copy that was never opened here also gets the IP check page (ADR-0029) from the Settings default.
                let assigned = self.assign_proxy(&id, Some(proxy), true, made.version)?;
                if !match_proxy || assigned.privacy.match_proxy {
                    return Ok(assigned);
                }
                let privacy = pb_runtime::PrivacyConfig {
                    match_proxy: true,
                    ..assigned.privacy.clone()
                };
                self.update_profile(
                    &id,
                    assigned.version,
                    crate::state::ProfileChanges {
                        privacy: Some(&privacy),
                        ..Default::default()
                    },
                )
            }
            None => Ok(made),
        }
    }

    /// Opens a workspace profile on this computer through the usual path (lease first). A profile that is not here yet
    /// is downloaded first and starts when the download finishes.
    pub fn workspace_profile_open(
        self: &Arc<Self>,
        org_id: &str,
        org_profile_id: &str,
        name: &str,
    ) -> Result<WorkspaceOpen, IpcError> {
        let view = self.workspace_profile_prepare(org_id, org_profile_id, name, None, false)?;
        let local = ProfileId::parse(&view.id).map_err(|_| ipc::INTERNAL)?;
        let store = self.store()?;
        if !self.sync_restoring(&store, &local) {
            let started = self.launch_profile(&local, None)?;
            return Ok(WorkspaceOpen {
                local_profile_id: view.id,
                operation_id: Some(started.operation_id),
                restoring: false,
            });
        }
        // Downloading: start it when the copy is complete (the link is made by then). A failed or very long download
        // leaves the profile closed; its status says why.
        let this = self.clone();
        let id = local.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + RESTORE_WAIT;
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let Ok(store) = this.store() else { return };
                if !this.sync_restoring(&store, &id) {
                    break;
                }
                if Instant::now() > deadline {
                    return;
                }
            }
            let linked = this
                .store()
                .ok()
                .and_then(|s| s.sync_link(&id).ok().flatten())
                .is_some();
            if linked {
                let _ = this.launch_profile(&id, None);
            }
        });
        Ok(WorkspaceOpen {
            local_profile_id: view.id,
            operation_id: None,
            restoring: true,
        })
    }

    fn local_copy(
        &self,
        org_id: &str,
        org_profile_id: &str,
    ) -> Result<Option<ProfileId>, IpcError> {
        let store = self.store()?;
        if let Some(l) = store
            .org_links(Some(org_id))?
            .into_iter()
            .find(|l| l.org_profile_id == org_profile_id)
            && store
                .get_profile(&l.local_profile_id)?
                .is_some_and(|p| p.trashed_at.is_none())
        {
            return Ok(Some(l.local_profile_id));
        }
        Ok(crate::sync::restoring_here(&store, org_profile_id))
    }

    /// A workspace profile without any backup: an empty local profile, linked at once (after checking the caller can
    /// reach the profile at all). Its first close uploads its first backup.
    fn link_empty_copy(
        &self,
        org_id: &str,
        org_profile_id: &str,
        name: &str,
    ) -> Result<ProfileView, IpcError> {
        let (server, _device) = self.migration_context(org_id)?;
        let (status, _) = self.migration_call(
            &server,
            Method::Get,
            &format!("/v1/orgs/{org_id}/profiles/{org_profile_id}"),
            &[],
            None,
        )?;
        if status == 404 || status == 403 {
            return Err(ipc::SYNC_FORBIDDEN);
        }
        if status != 200 {
            return Err(ipc::CLOUD_UNAVAILABLE);
        }
        let name = ipc::clean_text(name, ipc::limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let store = self.store()?;
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let p = store.insert_profile(pb_storage::NewProfile::basic(id, Some(ws), &name, None))?;
        store.link_org_profiles(org_id, &[(p.id.clone(), org_profile_id.to_owned())])?;
        let _ = store.audit(Some(&p.id), "create", "workspace_copy", None, None);
        Ok(self.view(p))
    }
}
