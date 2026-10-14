//! R1 (ADR-0020): the device's migration toward the unified workspace model: one Profiles view where a linked local
//! profile and its workspace profile are one thing, and a local-only profile is adopted into the workspace only when
//! the person chooses it.
//!
//! What it does and never does:
//!  - **Plan (dry run).** Inventories the local workspace: which profiles are already linked (their workspace id is
//!    authoritative), which the server already mapped for this device (a reinstall), which are local-only and may be
//!    adopted, and which are blocked (running, or not cleanly shut down). The plan is a report of ids and counts,
//!    never cookies or secrets. The server's own dry run (local-import with device_id) is part of it.
//!  - **Run.** Adopts only the profiles the person selected, in bounded batches with a checkpoint after each, so a
//!    crash resumes where it stopped and re-running a finished batch maps to the same workspace profiles (the server's
//!    profile identity map). Metadata only: nothing is uploaded unless the person chose sync, and then only through
//!    the ordinary backup path later. Local records, directories, keys and proxies are untouched.
//!  - **Rollback.** Turns the unified UI off (local setting and the workspace's feature setting). Mappings stay:
//!    they are additive and still correct.
//!
//! A run is identified by the digest of its manifest; the same inventory is the same run.

use crate::account::{self, NoAccess};
use crate::ipc::{self, IpcError};
use crate::state::AppState;
use pb_cloud::Method;
use pb_runtime::{MigrationRunId, ProfileId, RunState, WorkspaceId};
use pb_storage::cloud as cs;
use pb_storage::migration::MigrationRun;
use pb_storage::settings;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Profiles adopted per server request (one checkpoint each).
pub const DEFAULT_BATCH: usize = 100;
const MAX_BATCH: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    /// Already a workspace profile on this device (milestone 07 link); nothing to do.
    Linked,
    /// The server mapped this local profile for this device before (a reinstall, or an interrupted run); the run
    /// restores the link without creating anything.
    MappedOnServer,
    /// Only on this device; may be adopted (explicit opt-in).
    LocalOnly,
    /// Cannot be adopted now: the browser is running it.
    BlockedRunning,
    /// Cannot be adopted now: its last session did not end cleanly (open it and close it first).
    BlockedUnclean,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlanEntry {
    pub local_id: ProfileId,
    /// Stable key for the unified view: the workspace profile id when linked, else `local:<local id>`.
    pub view_key: String,
    pub name: String,
    pub state: EntryState,
    pub cloud_profile_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Counts {
    pub profiles: u32,
    pub linked: u32,
    pub mapped_on_server: u32,
    pub local_only: u32,
    pub blocked: u32,
    pub adopted: u32,
    pub skipped: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Quota {
    pub profiles_used: u32,
    pub profiles_allowed: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationPlan {
    pub org_id: String,
    pub workspace_id: WorkspaceId,
    pub device_id: String,
    pub manifest_digest: String,
    pub entries: Vec<PlanEntry>,
    pub counts: Counts,
    /// What the workspace allows today (adoption beyond it is refused by the server with PLAN_LIMIT_REACHED).
    pub quota: Option<Quota>,
    /// The run for this manifest, if one exists (resume or final report).
    pub run: Option<MigrationRun>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationReport {
    pub run: MigrationRun,
    /// local profile id -> workspace profile id, for every linked profile of the workspace.
    pub mappings: BTreeMap<String, String>,
}

impl AppState {
    pub(crate) fn migration_context(&self, org_id: &str) -> Result<(String, String), IpcError> {
        if org_id.len() != 30 || !org_id.starts_with("org_") {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        let server = store
            .cloud_state(cs::SERVER_URL)?
            .ok_or(ipc::CLOUD_NOT_CONFIGURED)?;
        let device = store
            .cloud_state(cs::DEVICE_ID)?
            .ok_or(ipc::CLOUD_SIGNED_OUT)?;
        if self.cloud_status() != account::SessionStatus::SignedIn {
            return Err(ipc::CLOUD_SIGNED_OUT);
        }
        Ok((server, device))
    }

    /// A signed request to the server (refreshing the token once), as the shell makes it: not through the window's
    /// allow-list.
    pub(crate) fn migration_call(
        &self,
        server: &str,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<(u16, Value), IpcError> {
        let url = account::api_url(server, path)?;
        let mut retried = false;
        loop {
            let token = self.access_token(server, retried).map_err(|e| match e {
                NoAccess::Offline => ipc::CLOUD_OFFLINE,
                NoAccess::SignedOut => ipc::CLOUD_SIGNED_OUT,
                NoAccess::Unavailable => ipc::CLOUD_UNAVAILABLE,
            })?;
            let res = self
                .cloud
                .http
                .request(method, &url, Some(&token), headers, body)
                .map_err(account::http_err)?;
            if res.status == 401 && !retried {
                retried = true;
                continue;
            }
            let body = res.json().ok_or(ipc::CLOUD_BAD_RESPONSE)?;
            return Ok((res.status, body));
        }
    }

    /// Inventories the workspace and asks the server for its plan. Read-only on both sides, except that the plan
    /// itself is recorded (locally and on the server) so a later run is the same run.
    pub fn migration_plan(
        &self,
        workspace: &WorkspaceId,
        org_id: &str,
    ) -> Result<MigrationPlan, IpcError> {
        let (server, device) = self.migration_context(org_id)?;
        let store = self.store()?;
        store
            .get_workspace(workspace)?
            .ok_or(ipc::UNKNOWN_WORKSPACE)?;
        let running: BTreeSet<ProfileId> = self.supervisor.running_ids().into_iter().collect();
        let links: BTreeMap<ProfileId, String> = store
            .org_links(Some(org_id))?
            .into_iter()
            .map(|l| (l.local_profile_id, l.org_profile_id))
            .collect();
        let mut profiles = store.search_profiles(Some(workspace), None, pb_storage::MAX_LIST)?;
        profiles.retain(|p| p.trashed_at.is_none());
        profiles.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));

        let mut entries = Vec::with_capacity(profiles.len());
        let mut unlinked: Vec<&pb_storage::LocalProfile> = Vec::new();
        for p in &profiles {
            if let Some(cloud) = links.get(&p.id) {
                entries.push(PlanEntry {
                    local_id: p.id.clone(),
                    view_key: cloud.clone(),
                    name: p.name.clone(),
                    state: EntryState::Linked,
                    cloud_profile_id: Some(cloud.clone()),
                });
            } else {
                unlinked.push(p);
            }
        }
        // The server's dry run: which unlinked profiles it already mapped for this device.
        let mut mapped: BTreeMap<String, String> = BTreeMap::new();
        if !unlinked.is_empty() {
            let (status, body) = self.migration_call(
                &server,
                Method::Post,
                &format!("/v1/orgs/{org_id}/local-import"),
                &[],
                Some(&import_request(&unlinked, &device, true)),
            )?;
            if status != 200 {
                return Err(server_error(status, &body));
            }
            for r in body["profiles"].as_array().into_iter().flatten() {
                if r["outcome"] == "existing"
                    && let (Some(local), Some(cloud)) =
                        (r["local_id"].as_str(), r["profile_id"].as_str())
                {
                    mapped.insert(local.to_owned(), cloud.to_owned());
                }
            }
        }
        for p in unlinked {
            let (state, cloud) = if let Some(cloud) = mapped.get(p.id.as_str()) {
                (EntryState::MappedOnServer, Some(cloud.clone()))
            } else if running.contains(&p.id) || p.state != RunState::Stopped {
                (EntryState::BlockedRunning, None)
            } else if p.last_started_at.is_some() && p.last_clean_shutdown_at.is_none() {
                (EntryState::BlockedUnclean, None)
            } else {
                (EntryState::LocalOnly, None)
            };
            entries.push(PlanEntry {
                local_id: p.id.clone(),
                view_key: cloud
                    .clone()
                    .unwrap_or_else(|| format!("local:{}", p.id.as_str())),
                name: p.name.clone(),
                state,
                cloud_profile_id: cloud,
            });
        }
        entries.sort_by(|a, b| a.local_id.as_str().cmp(b.local_id.as_str()));
        let mut counts = Counts {
            profiles: entries.len() as u32,
            ..Counts::default()
        };
        for e in &entries {
            match e.state {
                EntryState::Linked => counts.linked += 1,
                EntryState::MappedOnServer => counts.mapped_on_server += 1,
                EntryState::LocalOnly => counts.local_only += 1,
                EntryState::BlockedRunning | EntryState::BlockedUnclean => counts.blocked += 1,
            }
        }
        // The manifest: which local profiles this device migrates into which workspace. Mappings and names are left
        // out on purpose: a run that was interrupted half-way must plan to the same digest afterwards, so its
        // checkpoint is found and it resumes instead of starting a second run.
        let manifest = json!({
            "schema": 1,
            "org_id": org_id,
            "device_id": device,
            "workspace_id": workspace.as_str(),
            "profiles": entries.iter().map(|e| e.local_id.as_str()).collect::<Vec<_>>(),
        });
        let manifest_digest = hex::encode(Sha256::digest(manifest.to_string().as_bytes()));

        let quota = self
            .migration_call(
                &server,
                Method::Get,
                &format!("/v1/orgs/{org_id}/billing/usage"),
                &[],
                None,
            )
            .ok()
            .filter(|(s, _)| *s == 200)
            .map(|(_, b)| Quota {
                profiles_used: b["current"]["profiles"].as_u64().unwrap_or(0) as u32,
                profiles_allowed: b["limits"]["profiles"].as_u64().map(|n| n as u32),
            });

        let run_id = MigrationRunId::generate().map_err(|_| ipc::INTERNAL)?;
        let run = store.migration_run_plan(
            run_id.as_str(),
            org_id,
            workspace,
            &manifest_digest,
            &serde_json::to_value(&counts).unwrap_or(Value::Null),
        )?;
        // The server's record (best effort: a plan is still valid offline from here on).
        let _ = self.record_run_on_server(&server, org_id, &device, &run);
        Ok(MigrationPlan {
            org_id: org_id.to_owned(),
            workspace_id: workspace.clone(),
            device_id: device,
            manifest_digest,
            entries,
            counts,
            quota,
            run: Some(run),
        })
    }

    fn record_run_on_server(
        &self,
        server: &str,
        org_id: &str,
        device: &str,
        run: &MigrationRun,
    ) -> Result<(), IpcError> {
        let body = json!({
            "device_id": device,
            "manifest_digest": run.manifest_digest,
            "state": run.state,
            "checkpoint": run.checkpoint,
            "counts": run.counts,
            "error_code": run.error_code,
        });
        let (status, answer) = self.migration_call(
            server,
            Method::Post,
            &format!("/v1/orgs/{org_id}/migration-runs"),
            &[],
            Some(&body),
        )?;
        if (status == 200 || status == 201)
            && let Some(id) = answer["id"].as_str()
            && run.server_run_id.is_none()
        {
            let store = self.store()?;
            let _ = store.migration_run_update(&run.id, &run.state, None, None, None, Some(id));
        }
        Ok(())
    }

    /// Adopts the selected local-only profiles into the workspace (metadata only), with a checkpoint after each
    /// batch. `sync` turns automatic backup on for the adopted profiles; without it nothing is ever uploaded.
    /// Re-running the same plan resumes after the last finished batch; a completed run is returned as it is.
    pub fn migration_run(
        &self,
        workspace: &WorkspaceId,
        org_id: &str,
        adopt: &[ProfileId],
        sync: bool,
        batch: usize,
    ) -> Result<MigrationReport, IpcError> {
        if adopt.len() > 10_000 || !(1..=MAX_BATCH).contains(&batch) {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let plan = self.migration_plan(workspace, org_id)?;
        let run = plan.run.clone().ok_or(ipc::INTERNAL)?;
        // A completed run is final, unless this device lost links the server still holds (a reinstall): then the
        // run only restores those links; nothing is created.
        if run.state == "completed" && plan.counts.mapped_on_server == 0 {
            return self.migration_report_for(&run);
        }
        let (server, device) = self.migration_context(org_id)?;
        let store = self.store()?;
        let by_id: BTreeMap<&str, &PlanEntry> = plan
            .entries
            .iter()
            .map(|e| (e.local_id.as_str(), e))
            .collect();
        // Everything the run links: what the person selected (local-only only), plus mappings the server already
        // holds for this device (restoring a link costs nothing and asks nothing).
        let mut selected: Vec<ProfileId> = Vec::new();
        let mut seen = BTreeSet::new();
        for id in adopt {
            if !seen.insert(id.clone()) {
                continue;
            }
            match by_id.get(id.as_str()).map(|e| &e.state) {
                Some(EntryState::LocalOnly | EntryState::MappedOnServer) => {
                    selected.push(id.clone())
                }
                Some(EntryState::Linked) => {}
                Some(EntryState::BlockedRunning) => return Err(ipc::PROFILE_RUNNING),
                Some(EntryState::BlockedUnclean) => return Err(ipc::MIGRATION_PROFILE_UNCLEAN),
                None => return Err(ipc::UNKNOWN_PROFILE),
            }
        }
        for e in &plan.entries {
            if e.state == EntryState::MappedOnServer && seen.insert(e.local_id.clone()) {
                selected.push(e.local_id.clone());
            }
        }
        selected.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        let skipped = plan.counts.local_only.saturating_sub(
            selected
                .iter()
                .filter(|id| {
                    matches!(
                        by_id.get(id.as_str()).map(|e| &e.state),
                        Some(EntryState::LocalOnly)
                    )
                })
                .count() as u32,
        );

        // Resume after the last finished batch of the same selection; a different selection starts its batches over
        // (already-mapped profiles come back as "existing", so nothing is duplicated either way).
        let selection_digest = hex::encode(Sha256::digest(
            selected
                .iter()
                .map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        ));
        let mut next_batch = 0usize;
        if (run.state == "running" || run.state == "failed")
            && run.checkpoint["selection"].as_str() == Some(selection_digest.as_str())
            && run.checkpoint["batch_size"].as_u64() == Some(batch as u64)
            && let Some(done) = run.checkpoint["batches_done"].as_u64()
        {
            next_batch = done as usize;
        }
        let mut counts = plan.counts.clone();
        counts.skipped = skipped;
        counts.adopted = run.counts["adopted"].as_u64().unwrap_or(0) as u32;
        let update = |state: &str,
                      checkpoint: Value,
                      counts: &Counts,
                      error: Option<&str>|
         -> Result<MigrationRun, IpcError> {
            let r = store.migration_run_update(
                &run.id,
                state,
                Some(&checkpoint),
                Some(&serde_json::to_value(counts).unwrap_or(Value::Null)),
                error,
                None,
            )?;
            let _ = self.record_run_on_server(&server, org_id, &device, &r);
            Ok(r)
        };
        let checkpoint = |done: usize| json!({ "step": "adopt", "selection": selection_digest, "batch_size": batch, "batches_done": done });
        update("running", checkpoint(next_batch), &counts, None)?;

        let total_batches = selected.len().div_ceil(batch);
        for b in next_batch..total_batches {
            let ids = &selected[b * batch..((b + 1) * batch).min(selected.len())];
            let profiles: Vec<pb_storage::LocalProfile> = ids
                .iter()
                .filter_map(|id| store.get_profile(id).ok().flatten())
                .collect();
            // Re-check right before each batch: a profile opened meanwhile is left for a later run.
            let running = self.supervisor.running_ids();
            let ready: Vec<&pb_storage::LocalProfile> = profiles
                .iter()
                .filter(|p| !running.contains(&p.id) && p.state == RunState::Stopped)
                .collect();
            let key = hex::encode(Sha256::digest(
                format!("{}\n{}\n{b}", run.manifest_digest, selection_digest).as_bytes(),
            ));
            if !ready.is_empty() {
                let (status, body) = match self.migration_call(
                    &server,
                    Method::Post,
                    &format!("/v1/orgs/{org_id}/local-import"),
                    &[("idempotency-key", key.as_str())],
                    Some(&import_request(&ready, &device, false)),
                ) {
                    Ok(r) => r,
                    Err(e) => {
                        update("failed", checkpoint(b), &counts, Some(e.code))?;
                        return Err(e);
                    }
                };
                if status != 200 && status != 201 {
                    let e = server_error(status, &body);
                    update("failed", checkpoint(b), &counts, Some(e.code))?;
                    return Err(e);
                }
                let mut pairs: Vec<(ProfileId, String)> = Vec::new();
                for r in body["profiles"].as_array().into_iter().flatten() {
                    if let (Ok(local), Some(cloud)) = (
                        ProfileId::parse(r["local_id"].as_str().unwrap_or_default()),
                        r["profile_id"].as_str(),
                    ) {
                        pairs.push((local, cloud.to_owned()));
                    }
                }
                store.link_org_profiles(org_id, &pairs)?;
                // Backups (uploads) only when sync was chosen; adoption alone moves metadata.
                for (local, _) in &pairs {
                    store.set_auto_backup(local, sync)?;
                }
                counts.adopted += pairs.len() as u32;
            }
            // Injected fault (tests): the process "crashes" after this batch's checkpoint is written.
            update("running", checkpoint(b + 1), &counts, None)?;
            if self.migration_fault_hit(b + 1) {
                return Err(ipc::MIGRATION_INTERRUPTED);
            }
        }
        // Verify: every selected profile now has its link.
        let links: BTreeSet<ProfileId> = store
            .org_links(Some(org_id))?
            .into_iter()
            .map(|l| l.local_profile_id)
            .collect();
        let running = self.supervisor.running_ids();
        let missing = selected
            .iter()
            .filter(|id| !links.contains(id) && !running.contains(id))
            .count();
        if missing > 0 {
            let r = update(
                "failed",
                checkpoint(total_batches),
                &counts,
                Some("MIGRATION_LINKS_MISSING"),
            )?;
            return self.migration_report_for(&r);
        }
        let r = update(
            "completed",
            json!({ "step": "done", "batches_done": total_batches }),
            &counts,
            None,
        )?;
        self.migration_report_for(&r)
    }

    /// Turns the unified UI off for this workspace (this device's setting and the workspace's feature setting). The
    /// profile mappings stay: they are additive and still true.
    pub fn migration_rollback(&self, org_id: &str) -> Result<MigrationReport, IpcError> {
        let (server, _device) = self.migration_context(org_id)?;
        let store = self.store()?;
        store.set_setting(settings::UNIFIED_PROFILES, &Value::Bool(false), false, None)?;
        let (status, body) = self.migration_call(
            &server,
            Method::Put,
            &format!("/v1/orgs/{org_id}/feature-settings"),
            &[],
            Some(&json!({ "settings": [{ "key": "ui.unified_profiles", "value": false }] })),
        )?;
        if status != 200 {
            return Err(server_error(status, &body));
        }
        let run = store
            .migration_runs(Some(org_id))?
            .into_iter()
            .next()
            .ok_or(ipc::MIGRATION_NO_RUN)?;
        let r = store.migration_run_update(&run.id, "rolled_back", None, None, None, None)?;
        self.migration_report_for(&r)
    }

    /// The newest run of a workspace with the device's current mappings.
    pub fn migration_report(&self, org_id: &str) -> Result<MigrationReport, IpcError> {
        if org_id.len() != 30 || !org_id.starts_with("org_") {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let run = self
            .store()?
            .migration_runs(Some(org_id))?
            .into_iter()
            .next()
            .ok_or(ipc::MIGRATION_NO_RUN)?;
        self.migration_report_for(&run)
    }

    fn migration_report_for(&self, run: &MigrationRun) -> Result<MigrationReport, IpcError> {
        let mappings = self
            .store()?
            .org_links(Some(&run.org_id))?
            .into_iter()
            .map(|l| (l.local_profile_id.as_str().to_owned(), l.org_profile_id))
            .collect();
        Ok(MigrationReport {
            run: run.clone(),
            mappings,
        })
    }
}

fn import_request(profiles: &[&pb_storage::LocalProfile], device: &str, dry_run: bool) -> Value {
    json!({
        "dry_run": dry_run,
        "device_id": device,
        "clients": [],
        "profiles": profiles.iter().map(|p| {
            let mut v = json!({ "local_id": p.id.as_str(), "name": p.name });
            if !p.notes.is_empty() {
                v["notes"] = json!(p.notes);
            }
            v
        }).collect::<Vec<_>>(),
    })
}

fn server_error(status: u16, body: &Value) -> IpcError {
    match body["code"].as_str() {
        Some("PLAN_LIMIT_REACHED") => ipc::MIGRATION_PLAN_LIMIT,
        Some("SUBSCRIPTION_RESTRICTED") => ipc::MIGRATION_PLAN_LIMIT,
        Some("UNAUTHENTICATED") => ipc::CLOUD_SIGNED_OUT,
        _ if status == 404 => ipc::CLOUD_NOT_ALLOWED,
        _ => ipc::CLOUD_BAD_RESPONSE,
    }
}

impl AppState {
    /// Tests: make the next run stop (as a crash would) right after `after_batches` batches were checkpointed.
    pub fn set_migration_fault(&self, after_batches: Option<u32>) {
        if let Ok(mut f) = self.migration_fault.lock() {
            *f = after_batches;
        }
    }

    fn migration_fault_hit(&self, batches_done: usize) -> bool {
        let mut f = match self.migration_fault.lock() {
            Ok(f) => f,
            Err(_) => return false,
        };
        if f.is_some_and(|n| n as usize == batches_done) {
            *f = None;
            return true;
        }
        false
    }
}
