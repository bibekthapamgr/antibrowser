//! Profile and client management (milestone 04): the profile table query, clients (folders), tags, templates,
//! saved filters, bulk actions with per-profile results and undo, the trash and safe permanent deletion.
//!
//! Rules:
//!  - a selection is either explicit ids or "every profile matching this filter"; the latter carries the count the
//!    user saw and is refused if the matching set changed ([`ipc::SELECTION_CHANGED`]);
//!  - bulk work runs in bounded batches and reports each profile; running profiles are never trashed or deleted;
//!  - permanent deletion happens only from the trash, after an explicit confirmation, and only once no process uses
//!    the profile folder: the folder is moved aside before the metadata is removed, so nothing can keep writing
//!    into a directory the manager no longer knows about.

use crate::authz::{self, Action};
use crate::ipc::{self, IpcError, limits};
use crate::state::{AppState, ProfileView};
use pb_runtime::{
    ClientId, FilterId, ProfileId, ProfileLock, ProxyId, TagId, TemplateId, WorkspaceId, procs,
};
use pb_storage::bulk::{self, BulkOp, ItemOutcome, ItemResult};
use pb_storage::catalog::{Client, SavedFilter, Tag, Template, TemplateConfig};
use pb_storage::query::{Counts, ProfileFilter, Sort};
use pb_storage::{LocalStore, NewProfile, settings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

/// Page size limit for the profile table.
pub const MAX_PAGE: u32 = 500;
/// Undo stays available this long (and for the most recent [`UNDO_KEEP`] actions).
pub const UNDO_TTL: Duration = Duration::from_secs(10 * 60);
pub const UNDO_KEEP: usize = 20;

/// Which profiles an action applies to.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Selection {
    Ids {
        ids: Vec<ProfileId>,
    },
    /// Every profile matching `filter` ("select all matching"); `expected_total` is the count the user saw.
    Filter {
        filter: ProfileFilter,
        expected_total: u64,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BulkAction {
    /// An existing tag, or a new one by name.
    AddTag {
        tag_id: Option<TagId>,
        tag_name: Option<String>,
    },
    RemoveTag {
        tag_id: TagId,
    },
    Move {
        client_id: Option<ClientId>,
    },
    Archive,
    Unarchive,
    Favourite {
        value: bool,
    },
    Trash,
    Restore,
    /// Assigns a proxy (`None`: no proxy) and the fail-closed setting (milestone 05). Open profiles keep their
    /// current route until they are reopened.
    SetProxy {
        proxy_id: Option<ProxyId>,
        fail_closed: bool,
    },
}

#[derive(Serialize)]
pub struct ProfilePage {
    pub rows: Vec<ProfileView>,
    pub total: u64,
    /// Pass back to get the next page; `None` on the last page.
    pub next_cursor: Option<String>,
}

#[derive(Serialize)]
pub struct ClientView {
    #[serde(flatten)]
    pub client: Client,
    /// Active profiles of this client.
    pub profiles: u64,
}

#[derive(Serialize)]
pub struct Library {
    pub counts: Counts,
    pub clients: Vec<ClientView>,
    pub tags: Vec<Tag>,
    pub templates: Vec<Template>,
    pub saved_filters: Vec<SavedFilter>,
    pub trash_retention_days: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct ItemFailure {
    pub id: String,
    pub name: Option<String>,
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Serialize, Debug)]
pub struct BulkResult {
    pub action: &'static str,
    pub requested: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub failed: Vec<ItemFailure>,
    /// Present when the action can be undone.
    pub undo_token: Option<String>,
}

#[derive(Serialize)]
pub struct UndoResult {
    pub restored: u64,
    /// Profiles changed again since the action; they were left as they are.
    pub skipped: u64,
}

pub(crate) struct UndoEntry {
    token: String,
    workspace: WorkspaceId,
    op: BulkOp,
    items: Vec<ItemResult>,
    created: Instant,
}

fn op_name(a: &BulkAction) -> &'static str {
    match a {
        BulkAction::AddTag { .. } => "add_tag",
        BulkAction::RemoveTag { .. } => "remove_tag",
        BulkAction::Move { .. } => "move",
        BulkAction::Archive => "archive",
        BulkAction::Unarchive => "unarchive",
        BulkAction::Favourite { .. } => "favourite",
        BulkAction::Trash => "trash",
        BulkAction::Restore => "restore",
        BulkAction::SetProxy { .. } => "set_proxy",
    }
}

fn failure(id: &ProfileId, name: Option<String>, e: IpcError) -> ItemFailure {
    ItemFailure {
        id: id.to_string(),
        name,
        code: e.code,
        message: e.message,
    }
}

/// Opaque page cursor: the offset plus a fingerprint of the filter and sort it belongs to.
fn fingerprint(filter: &ProfileFilter, sort: Sort) -> String {
    let doc =
        json!({ "f": filter, "s": sort, "w": filter.workspace.as_ref().map(|w| w.to_string()) });
    hex::encode(&Sha256::digest(doc.to_string().as_bytes())[..6])
}

impl AppState {
    pub(crate) fn workspace(&self, store: &LocalStore) -> Result<WorkspaceId, IpcError> {
        self.active_workspace(store)?.ok_or(ipc::NO_WORKSPACE)
    }

    pub fn trash_retention_days(&self, store: &LocalStore) -> u32 {
        store
            .get_setting(settings::TRASH_RETENTION)
            .ok()
            .and_then(|v| v.value.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(30)
    }

    // ------------------------------------------------------------------------- reading
    pub fn query_profiles(
        &self,
        filter: Option<ProfileFilter>,
        sort: Option<Sort>,
        cursor: Option<&str>,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<ProfilePage, IpcError> {
        let store = self.store()?;
        let Some(ws) = self.active_workspace(&store)? else {
            return Ok(ProfilePage {
                rows: vec![],
                total: 0,
                next_cursor: None,
            });
        };
        let mut filter = filter.unwrap_or_default();
        filter.workspace = Some(ws);
        filter.validate().map_err(|_| ipc::INVALID_FILTER)?;
        let sort = sort.unwrap_or_default();
        let print = fingerprint(&filter, sort);
        // `cursor` continues from the previous page and is refused if the filter or sort changed; `offset` jumps to
        // a position (the virtualized table loads whichever page scrolls into view).
        let offset = match cursor {
            None => offset.unwrap_or(0).min(pb_storage::MAX_LIST),
            Some(c) => {
                let (o, f) = c.split_once('.').ok_or(ipc::CURSOR_STALE)?;
                if f != print {
                    return Err(ipc::CURSOR_STALE);
                }
                o.parse::<u32>().map_err(|_| ipc::CURSOR_STALE)?
            }
        };
        let limit = limit.unwrap_or(200).clamp(1, MAX_PAGE);
        let page = store.query_profiles(&filter, sort, offset, limit)?;
        let next = u64::from(offset) + page.rows.len() as u64;
        Ok(ProfilePage {
            next_cursor: (next < page.total).then(|| format!("{next}.{print}")),
            total: page.total,
            rows: page.rows.into_iter().map(|p| self.view(p)).collect(),
        })
    }

    pub fn library(&self) -> Result<Library, IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let counts = store.profile_counts(&ws)?;
        let clients = store
            .list_clients(&ws, true)?
            .into_iter()
            .map(|c| ClientView {
                profiles: counts
                    .per_client
                    .iter()
                    .find(|(id, _)| id == &c.id)
                    .map_or(0, |(_, n)| *n),
                client: c,
            })
            .collect();
        Ok(Library {
            clients,
            tags: store.list_tags(&ws)?,
            templates: store.list_templates(&ws)?,
            saved_filters: store.list_saved_filters(&ws)?,
            trash_retention_days: self.trash_retention_days(&store),
            counts,
        })
    }

    // ------------------------------------------------------------------------- clients, tags, filters
    pub fn create_client(&self, name: &str, colour: Option<&str>) -> Result<Client, IpcError> {
        let name = ipc::clean_text(name, limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let colour = colour.map(valid_colour).transpose()?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        Ok(store.create_client(&ws, &name, colour.as_deref())?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_client(
        &self,
        id: &ClientId,
        expected_version: i64,
        name: Option<&str>,
        colour: Option<&str>,
        clear_colour: bool,
        archived: Option<bool>,
    ) -> Result<Client, IpcError> {
        let name = name
            .map(|n| ipc::clean_text(n, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let colour = colour.map(valid_colour).transpose()?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let current = store.get_client(id)?.ok_or(ipc::UNKNOWN_CLIENT)?;
        if current.workspace_id != ws {
            return Err(ipc::UNKNOWN_CLIENT);
        }
        Ok(store.update_client(
            id,
            expected_version,
            name.as_deref(),
            if clear_colour {
                Some(None)
            } else {
                colour.as_deref().map(Some)
            },
            archived,
        )?)
    }

    pub fn create_tag(&self, name: &str) -> Result<pb_storage::catalog::TagRefOwned, IpcError> {
        let name = ipc::clean_text(name, 40, ipc::INVALID_TAG)?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        Ok(store.ensure_tag(&ws, &name)?)
    }

    fn own_tag(&self, store: &LocalStore, id: &TagId) -> Result<WorkspaceId, IpcError> {
        let ws = self.workspace(store)?;
        if store.tag_workspace(id)?.as_ref() != Some(&ws) {
            return Err(ipc::UNKNOWN_TAG);
        }
        Ok(ws)
    }

    pub fn rename_tag(&self, id: &TagId, name: &str) -> Result<(), IpcError> {
        let name = ipc::clean_text(name, 40, ipc::INVALID_TAG)?;
        let store = self.store()?;
        self.own_tag(&store, id)?;
        Ok(store.rename_tag(id, &name)?)
    }

    pub fn delete_tag(&self, id: &TagId) -> Result<(), IpcError> {
        let store = self.store()?;
        self.own_tag(&store, id)?;
        Ok(store.delete_tag(id)?)
    }

    pub fn save_filter(
        &self,
        name: &str,
        filter: ProfileFilter,
        sort: Option<Sort>,
    ) -> Result<SavedFilter, IpcError> {
        let name = ipc::clean_text(name, 60, ipc::INVALID_LABEL)?;
        filter.validate().map_err(|_| ipc::INVALID_FILTER)?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let doc = json!({ "filter": filter, "sort": sort.unwrap_or_default() });
        Ok(store.save_filter(&ws, &name, &doc)?)
    }

    pub fn delete_filter(&self, id: &FilterId) -> Result<(), IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        if !store.list_saved_filters(&ws)?.iter().any(|f| &f.id == id) {
            return Err(ipc::INVALID_FILTER);
        }
        Ok(store.delete_saved_filter(id)?)
    }

    // ------------------------------------------------------------------------- templates
    /// Saves a profile's configuration (start pages, permission defaults, tags) as a template. Browser storage and
    /// sign-ins are never part of a template.
    pub fn save_template_from_profile(
        &self,
        profile_id: &ProfileId,
        name: &str,
    ) -> Result<Template, IpcError> {
        let name = ipc::clean_text(name, limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let p = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if p.workspace_id.as_ref() != Some(&ws) {
            return Err(ipc::UNKNOWN_PROFILE);
        }
        let config = TemplateConfig {
            start_urls: p.start_urls,
            camera: p.camera,
            microphone: p.microphone,
            location: p.location,
            tags: p.tags.into_iter().map(|t| t.name).collect(),
            notes: String::new(),
        };
        Ok(store.save_template(&ws, &name, &config)?)
    }

    pub fn delete_template(&self, id: &TemplateId) -> Result<(), IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        match store.get_template(id)? {
            Some((owner, _)) if owner == ws => Ok(store.delete_template(id)?),
            _ => Err(ipc::UNKNOWN_TEMPLATE),
        }
    }

    /// Fills a new profile's configuration from a template (storage stays empty).
    pub(crate) fn apply_template(
        &self,
        store: &LocalStore,
        ws: &WorkspaceId,
        template: &TemplateId,
        new: &mut NewProfile,
    ) -> Result<(), IpcError> {
        let (owner, t) = store.get_template(template)?.ok_or(ipc::UNKNOWN_TEMPLATE)?;
        if &owner != ws {
            return Err(ipc::UNKNOWN_TEMPLATE);
        }
        new.start_urls = t.config.start_urls;
        new.camera = t.config.camera;
        new.microphone = t.config.microphone;
        new.location = t.config.location;
        if new.notes.is_empty() {
            new.notes = t.config.notes;
        }
        for name in &t.config.tags {
            let tag = store.ensure_tag(ws, name)?;
            if !new.tags.contains(&tag.id) {
                new.tags.push(tag.id);
            }
        }
        new.template_id = Some(t.id);
        Ok(())
    }

    /// A new profile with the same configuration (client, tags, start pages, permission defaults) and EMPTY browser
    /// storage: sign-ins, cookies and history are never copied.
    pub fn duplicate_profile(
        &self,
        profile_id: &ProfileId,
        name: &str,
    ) -> Result<ProfileView, IpcError> {
        let name = ipc::clean_text(name, limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let src = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if src.workspace_id.as_ref() != Some(&ws) {
            return Err(ipc::UNKNOWN_PROFILE);
        }
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let new = NewProfile {
            start_urls: src.start_urls,
            camera: src.camera,
            microphone: src.microphone,
            location: src.location,
            tags: src.tags.into_iter().map(|t| t.id).collect(),
            template_id: src.template_id,
            privacy: src.privacy,
            network: Some((src.proxy_id, src.fail_closed)),
            ..NewProfile::basic(id, Some(ws), &name, src.client_id)
        };
        let p = store.insert_profile(new)?;
        let _ = store.audit(Some(&p.id), "create", "duplicate", None, None);
        Ok(self.view(p))
    }

    // ------------------------------------------------------------------------- selections and bulk actions
    pub(crate) fn resolve_selection(
        &self,
        store: &LocalStore,
        ws: &WorkspaceId,
        selection: Selection,
    ) -> Result<Vec<ProfileId>, IpcError> {
        let ids = match selection {
            Selection::Ids { ids } => {
                if ids.len() > bulk::MAX_BULK {
                    return Err(ipc::SELECTION_TOO_LARGE);
                }
                let mut seen = std::collections::HashSet::new();
                ids.into_iter().filter(|i| seen.insert(i.clone())).collect()
            }
            Selection::Filter {
                mut filter,
                expected_total,
            } => {
                filter.workspace = Some(ws.clone());
                filter.validate().map_err(|_| ipc::INVALID_FILTER)?;
                let total = store.query_profiles(&filter, Sort::default(), 0, 1)?.total;
                if total != expected_total {
                    return Err(ipc::SELECTION_CHANGED);
                }
                if total > bulk::MAX_BULK as u64 {
                    return Err(ipc::SELECTION_TOO_LARGE);
                }
                store.query_ids(&filter, Sort::default(), bulk::MAX_BULK as u32)?
            }
        };
        if ids.is_empty() {
            return Err(ipc::NOTHING_SELECTED);
        }
        Ok(ids)
    }

    pub fn bulk(&self, action: BulkAction, selection: Selection) -> Result<BulkResult, IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let ids = self.resolve_selection(&store, &ws, selection)?;
        authz::authorize(Action::BulkEdit, ids.len())?;
        let name = op_name(&action);
        let op = match action {
            BulkAction::AddTag { tag_id, tag_name } => match (tag_id, tag_name) {
                (Some(id), _) => {
                    self.own_tag(&store, &id)?;
                    BulkOp::AddTag { tag_id: id }
                }
                (None, Some(n)) => {
                    let n = ipc::clean_text(&n, 40, ipc::INVALID_TAG)?;
                    BulkOp::AddTag {
                        tag_id: store.ensure_tag(&ws, &n)?.id,
                    }
                }
                (None, None) => return Err(ipc::INVALID_TAG),
            },
            BulkAction::RemoveTag { tag_id } => {
                self.own_tag(&store, &tag_id)?;
                BulkOp::RemoveTag { tag_id }
            }
            BulkAction::Move { client_id } => {
                if let Some(c) = &client_id {
                    let found = store.get_client(c)?.ok_or(ipc::UNKNOWN_CLIENT)?;
                    if found.workspace_id != ws {
                        return Err(ipc::UNKNOWN_CLIENT);
                    }
                }
                BulkOp::Move { client_id }
            }
            BulkAction::Archive => BulkOp::Archive,
            BulkAction::Unarchive => BulkOp::Unarchive,
            BulkAction::Favourite { value } => BulkOp::Favourite { value },
            BulkAction::Trash => BulkOp::Trash {
                retention_days: self.trash_retention_days(&store),
            },
            BulkAction::Restore => BulkOp::Restore,
            BulkAction::SetProxy {
                proxy_id,
                fail_closed,
            } => {
                if let Some(p) = &proxy_id {
                    let found = store.get_proxy(p)?.ok_or(ipc::UNKNOWN_PROXY)?;
                    if found.workspace_id != ws {
                        return Err(ipc::UNKNOWN_PROXY);
                    }
                }
                BulkOp::SetProxy {
                    proxy_id,
                    fail_closed,
                }
            }
        };
        let mut failed = vec![];
        let mut eligible = Vec::with_capacity(ids.len());
        for id in &ids {
            // Running or busy profiles are never moved to the trash.
            if matches!(op, BulkOp::Trash { .. }) && self.supervisor.is_tracked(id) {
                failed.push(failure(
                    id,
                    self.profile_name(&store, id),
                    ipc::PROFILE_RUNNING,
                ));
            } else if matches!(op, BulkOp::Trash { .. })
                && self.supervisor.is_busy(id)
                && !self.has_backup_job(id)
            {
                // Busy with recovery. (A backup is fine: trashing only changes metadata, and a permanent deletion
                // cancels the backup first.)
                failed.push(failure(
                    id,
                    self.profile_name(&store, id),
                    ipc::PROFILE_BUSY,
                ));
            } else {
                eligible.push(id.clone());
            }
        }
        let results = store.bulk_apply(&ws, &eligible, &op, &|| false)?;
        let (mut changed, mut unchanged) = (0, 0);
        for r in &results {
            match r.outcome {
                ItemOutcome::Changed { .. } => changed += 1,
                ItemOutcome::Unchanged => unchanged += 1,
                ItemOutcome::NotFound => failed.push(failure(&r.id, None, ipc::UNKNOWN_PROFILE)),
            }
        }
        let undo_token = (changed > 0)
            .then(|| self.remember_undo(ws.clone(), op, results))
            .flatten();
        let _ = store.audit(
            None,
            "bulk",
            name,
            None,
            Some(&format!("changed {changed} of {}", ids.len())),
        );
        self.notify_running_changed();
        Ok(BulkResult {
            action: name,
            requested: ids.len(),
            changed,
            unchanged,
            failed,
            undo_token,
        })
    }

    fn profile_name(&self, store: &LocalStore, id: &ProfileId) -> Option<String> {
        store.get_profile(id).ok().flatten().map(|p| p.name)
    }

    fn remember_undo(
        &self,
        workspace: WorkspaceId,
        op: BulkOp,
        items: Vec<ItemResult>,
    ) -> Option<String> {
        let token = pb_runtime::random_hex(16).ok()?;
        let mut undo = self.undo.lock().ok()?;
        undo.retain(|e| e.created.elapsed() < UNDO_TTL);
        if undo.len() >= UNDO_KEEP {
            undo.remove(0);
        }
        undo.push(UndoEntry {
            token: token.clone(),
            workspace,
            op,
            items,
            created: Instant::now(),
        });
        Some(token)
    }

    pub fn undo(&self, token: &str) -> Result<UndoResult, IpcError> {
        let entry = {
            let mut undo = self.undo.lock().map_err(|_| ipc::INTERNAL)?;
            undo.retain(|e| e.created.elapsed() < UNDO_TTL);
            let pos = undo
                .iter()
                .position(|e| e.token == token)
                .ok_or(ipc::UNDO_EXPIRED)?;
            undo.remove(pos)
        };
        let store = self.store()?;
        if self.workspace(&store)? != entry.workspace {
            return Err(ipc::UNDO_EXPIRED);
        }
        // Undoing "restore" puts profiles back in the trash: never while they are open.
        let items: Vec<ItemResult> = entry
            .items
            .into_iter()
            .filter(|i| !(matches!(entry.op, BulkOp::Restore) && self.supervisor.is_tracked(&i.id)))
            .collect();
        let (restored, skipped) = store.bulk_undo(&entry.op, &items)?;
        self.notify_running_changed();
        Ok(UndoResult { restored, skipped })
    }

    // ------------------------------------------------------------------------- permanent deletion
    /// Deletes profiles from the trash for good. `confirm` must be "DELETE" and `expected_count` must equal the
    /// number of selected profiles (what the confirmation dialog showed).
    pub fn delete_permanently(
        self: &std::sync::Arc<Self>,
        selection: Selection,
        confirm: &str,
        expected_count: usize,
    ) -> Result<BulkResult, IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let ids = self.resolve_selection(&store, &ws, selection)?;
        if confirm != "DELETE" || ids.len() != expected_count {
            return Err(ipc::DELETE_CONFIRMATION);
        }
        authz::authorize(Action::DeletePermanently, ids.len())?;
        let failed = self.delete_ids(&store, &ws, &ids, false);
        let deleted = ids.len() - failed.len();
        let _ = store.audit(
            None,
            "bulk",
            "delete",
            None,
            Some(&format!("deleted {deleted} of {}", ids.len())),
        );
        self.notify_running_changed();
        Ok(BulkResult {
            action: "delete",
            requested: ids.len(),
            changed: deleted,
            unchanged: 0,
            failed,
            undo_token: None,
        })
    }

    /// Profiles whose trash retention has ended are deleted (skipping any that are somehow in use).
    pub fn purge_expired_trash(self: &std::sync::Arc<Self>) -> usize {
        let Ok(store) = self.store() else { return 0 };
        let _ = self.root.purge_retired();
        let Ok(due) = store.due_for_purge(500) else {
            return 0;
        };
        if due.is_empty() {
            return 0;
        }
        let mut purged = 0;
        for id in due {
            let Ok(Some(p)) = store.get_profile(&id) else {
                continue;
            };
            let Some(ws) = p.workspace_id else { continue };
            if self
                .delete_ids(&store, &ws, std::slice::from_ref(&id), true)
                .is_empty()
            {
                purged += 1;
            }
        }
        if purged > 0 {
            self.notify_running_changed();
        }
        purged
    }

    /// Safe deletion of trashed profiles; returns the failures.
    fn delete_ids(
        self: &std::sync::Arc<Self>,
        store: &LocalStore,
        ws: &WorkspaceId,
        ids: &[ProfileId],
        purge: bool,
    ) -> Vec<ItemFailure> {
        let mut failed = vec![];
        // No launch can start while deletions run (launches take this lock too).
        let Ok(_launches) = self.launch_lock.lock() else {
            return ids
                .iter()
                .map(|i| failure(i, None, ipc::INTERNAL))
                .collect();
        };
        let snapshot = self.supervisor.inspector().snapshot();
        for id in ids {
            let Ok(Some(p)) = store.get_profile(id) else {
                failed.push(failure(id, None, ipc::UNKNOWN_PROFILE));
                continue;
            };
            let name = Some(p.name.clone());
            if p.workspace_id.as_ref() != Some(ws) {
                failed.push(failure(id, None, ipc::UNKNOWN_PROFILE));
                continue;
            }
            if p.trashed_at.is_none() {
                failed.push(failure(id, name, ipc::NOT_IN_TRASH));
                continue;
            }
            if self.supervisor.is_tracked(id) {
                failed.push(failure(id, name, ipc::PROFILE_RUNNING));
                continue;
            }
            // Claim the profile for the whole deletion so no routine backup (started automatically after a clean
            // close) or recovery can begin and open its files halfway; a routine backup already running is
            // cancelled first.
            let mut claimed = self.supervisor.try_busy(id);
            if !claimed && self.cancel_backup(id) {
                claimed = self.supervisor.try_busy(id);
            }
            if !claimed {
                failed.push(failure(id, name, ipc::PROFILE_BUSY));
                continue;
            }
            let outcome = self.delete_claimed(store, id, &snapshot, purge);
            self.supervisor.clear_busy(id);
            if let Err(e) = outcome {
                failed.push(failure(id, name, e));
            }
        }
        let _ = self.root.purge_retired();
        failed
    }

    /// Deletes one trashed profile that the caller has claimed (busy) under the launch lock.
    fn delete_claimed(
        &self,
        store: &LocalStore,
        id: &ProfileId,
        snapshot: &[pb_runtime::ProcRecord],
        purge: bool,
    ) -> Result<(), IpcError> {
        let dirs = self.root.dirs(id);
        if !procs::browser_mains(snapshot, &dirs.user_data).is_empty() {
            return Err(ipc::PROFILE_RUNNING);
        }
        match ProfileLock::try_acquire(&dirs.root) {
            Ok(Some(lock)) => drop(lock), // nobody else holds it; released before the folder moves
            Ok(None) => return Err(ipc::PROFILE_IN_USE),
            Err(_) if !dirs.root.exists() => {}
            Err(_) => return Err(ipc::INTERNAL),
        }
        // 1. Move the folder aside (atomic): a browser can no longer open it under this profile's path.
        self.root.retire(id).map_err(|_| ipc::PROFILE_IN_USE)?;
        // 2. Remove the metadata, then the moved folder, backups and evidence.
        store
            .delete_profile_metadata(id)
            .map_err(|_| ipc::INTERNAL)?;
        let _ = self.backups.remove_profile(id.as_str());
        let _ = store.audit(
            Some(id),
            if purge { "purge" } else { "delete" },
            "ok",
            None,
            None,
        );
        Ok(())
    }
}

fn valid_colour(v: &str) -> Result<String, IpcError> {
    let ok = v.len() == 7
        && v.starts_with('#')
        && v[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ok.then(|| v.to_owned()).ok_or(ipc::INVALID_COLOUR)
}

/// Re-exported for the import code: the same JSON shape the UI sends.
pub fn filter_from_value(v: &Value) -> Result<ProfileFilter, IpcError> {
    serde_json::from_value(v.clone()).map_err(|_| ipc::INVALID_FILTER)
}
