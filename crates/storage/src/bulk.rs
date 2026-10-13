//! Bulk metadata actions and the trash (milestone 04).
//!
//! - Work happens in bounded batches ([`BATCH`] profiles per transaction) and reports a result per profile.
//! - Every change bumps the profile's version; the prior value is returned so the caller can offer undo, and an
//!   undo only touches profiles whose version is still the one this action produced.
//! - Whether a profile is running is decided by the caller (the process supervisor), never here.

use crate::{LocalStore, StoreError};
use pb_runtime::{ClientId, ProfileId, ProxyId, TagId, WorkspaceId};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

/// Profiles changed per transaction.
pub const BATCH: usize = 250;
/// Most profiles one bulk request may name.
pub const MAX_BULK: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum BulkOp {
    AddTag {
        tag_id: TagId,
    },
    RemoveTag {
        tag_id: TagId,
    },
    /// `client_id: None` removes the client.
    Move {
        client_id: Option<ClientId>,
    },
    Archive,
    Unarchive,
    Favourite {
        value: bool,
    },
    /// Moves to the trash; purged after `retention_days`.
    Trash {
        retention_days: u32,
    },
    Restore,
    /// Assigns a proxy (`None`: no proxy) and the fail-closed setting (milestone 05). Takes effect at next launch.
    SetProxy {
        proxy_id: Option<ProxyId>,
        fail_closed: bool,
    },
}

/// What a profile looked like before an action (enough to undo it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum Prior {
    HadTag(bool),
    Client(Option<ClientId>),
    ArchivedAt(Option<String>),
    Favourite(bool),
    Trash(Option<(String, String)>),
    Network(Option<ProxyId>, bool),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum ItemOutcome {
    Changed {
        prior: Prior,
        version: i64,
    },
    /// Already in the requested state (nothing written).
    Unchanged,
    NotFound,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ItemResult {
    pub id: ProfileId,
    #[serde(flatten)]
    pub outcome: ItemOutcome,
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn bump(tx: &Transaction<'_>, id: &ProfileId) -> rusqlite::Result<i64> {
    tx.query_row(
        &format!("update profiles set version = version + 1, updated_at = {NOW} where id = ?1 returning version"),
        [id.as_str()],
        |r| r.get(0),
    )
}

fn apply_one(
    tx: &Transaction<'_>,
    workspace: &WorkspaceId,
    id: &ProfileId,
    op: &BulkOp,
) -> Result<ItemOutcome, StoreError> {
    // Profiles of another workspace are treated as missing.
    let exists: Option<(Option<String>, Option<String>, i64)> = tx
        .query_row(
            "select client_id, archived_at, favourite from profiles where id = ?1 and workspace_id = ?2",
            [id.as_str(), workspace.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((client, archived_at, favourite)) = exists else {
        return Ok(ItemOutcome::NotFound);
    };
    let trash: Option<(String, String)> = tx
        .query_row(
            "select trashed_at, purge_after from trash_entries where profile_id = ?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let prior = match op {
        BulkOp::AddTag { tag_id } | BulkOp::RemoveTag { tag_id } => {
            let had = tx
                .query_row(
                    "select 1 from profile_tags where profile_id = ?1 and tag_id = ?2",
                    params![id.as_str(), tag_id.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let add = matches!(op, BulkOp::AddTag { .. });
            if had == add {
                return Ok(ItemOutcome::Unchanged);
            }
            if add {
                tx.execute(
                    "insert into profile_tags (profile_id, tag_id) values (?1, ?2)",
                    params![id.as_str(), tag_id.as_str()],
                )?;
            } else {
                tx.execute(
                    "delete from profile_tags where profile_id = ?1 and tag_id = ?2",
                    params![id.as_str(), tag_id.as_str()],
                )?;
            }
            Prior::HadTag(had)
        }
        BulkOp::Move { client_id } => {
            let target = client_id.as_ref().map(ClientId::to_string);
            if client == target {
                return Ok(ItemOutcome::Unchanged);
            }
            tx.execute(
                "update profiles set client_id = ?2 where id = ?1",
                params![id.as_str(), target],
            )?;
            Prior::Client(
                client
                    .map(|c| ClientId::parse(&c).map_err(|_| StoreError::Corrupt))
                    .transpose()?,
            )
        }
        BulkOp::Archive | BulkOp::Unarchive => {
            let archive = matches!(op, BulkOp::Archive);
            if archived_at.is_some() == archive {
                return Ok(ItemOutcome::Unchanged);
            }
            tx.execute(
                &format!(
                    "update profiles set archived_at = case when ?2 then {NOW} else null end where id = ?1"
                ),
                params![id.as_str(), archive],
            )?;
            Prior::ArchivedAt(archived_at)
        }
        BulkOp::Favourite { value } => {
            if (favourite == 1) == *value {
                return Ok(ItemOutcome::Unchanged);
            }
            tx.execute(
                "update profiles set favourite = ?2 where id = ?1",
                params![id.as_str(), value],
            )?;
            Prior::Favourite(favourite == 1)
        }
        BulkOp::Trash { retention_days } => {
            if trash.is_some() {
                return Ok(ItemOutcome::Unchanged);
            }
            tx.execute(
                &format!(
                    "insert into trash_entries (profile_id, trashed_at, purge_after)
                     values (?1, {NOW}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2))"
                ),
                params![
                    id.as_str(),
                    format!("+{} days", (*retention_days).clamp(1, 365))
                ],
            )?;
            Prior::Trash(None)
        }
        BulkOp::Restore => {
            if trash.is_none() {
                return Ok(ItemOutcome::Unchanged);
            }
            tx.execute(
                "delete from trash_entries where profile_id = ?1",
                [id.as_str()],
            )?;
            Prior::Trash(trash)
        }
        BulkOp::SetProxy {
            proxy_id,
            fail_closed,
        } => {
            let (current, current_fc) = crate::network::settings_of(tx, id)?;
            if current.as_ref() == proxy_id.as_ref() && current_fc == *fail_closed {
                return Ok(ItemOutcome::Unchanged);
            }
            crate::network::upsert_settings(tx, id, proxy_id.as_ref(), *fail_closed)?;
            Prior::Network(current, current_fc)
        }
    };
    Ok(ItemOutcome::Changed {
        prior,
        version: bump(tx, id)?,
    })
}

/// Restores one profile's prior value if its version is still `expected_version`.
fn undo_one(
    tx: &Transaction<'_>,
    id: &ProfileId,
    op: &BulkOp,
    prior: &Prior,
    expected_version: i64,
) -> Result<bool, StoreError> {
    let current: Option<i64> = tx
        .query_row(
            "select version from profiles where id = ?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if current != Some(expected_version) {
        return Ok(false);
    }
    match (op, prior) {
        (BulkOp::AddTag { tag_id } | BulkOp::RemoveTag { tag_id }, Prior::HadTag(had)) => {
            if *had {
                tx.execute(
                    "insert or ignore into profile_tags (profile_id, tag_id) values (?1, ?2)",
                    params![id.as_str(), tag_id.as_str()],
                )?;
            } else {
                tx.execute(
                    "delete from profile_tags where profile_id = ?1 and tag_id = ?2",
                    params![id.as_str(), tag_id.as_str()],
                )?;
            }
        }
        (BulkOp::Move { .. }, Prior::Client(client)) => {
            // The original client may have been deleted meanwhile; then the profile stays without one.
            tx.execute(
                "update profiles set client_id = (select id from clients_local where id = ?2) where id = ?1",
                params![id.as_str(), client.as_ref().map(ClientId::as_str)],
            )?;
        }
        (BulkOp::Archive | BulkOp::Unarchive, Prior::ArchivedAt(at)) => {
            tx.execute(
                "update profiles set archived_at = ?2 where id = ?1",
                params![id.as_str(), at],
            )?;
        }
        (BulkOp::Favourite { .. }, Prior::Favourite(f)) => {
            tx.execute(
                "update profiles set favourite = ?2 where id = ?1",
                params![id.as_str(), f],
            )?;
        }
        (BulkOp::SetProxy { .. }, Prior::Network(proxy, fail_closed)) => {
            // A proxy deleted meanwhile cannot come back; the profile then keeps its current routing.
            if proxy
                .as_ref()
                .is_none_or(|p| crate::network::proxy_exists(tx, p).unwrap_or(false))
            {
                crate::network::upsert_settings(tx, id, proxy.as_ref(), *fail_closed)?;
            }
        }
        (BulkOp::Trash { .. } | BulkOp::Restore, Prior::Trash(entry)) => match entry {
            None => {
                tx.execute(
                    "delete from trash_entries where profile_id = ?1",
                    [id.as_str()],
                )?;
            }
            Some((trashed_at, purge_after)) => {
                tx.execute(
                    "insert or replace into trash_entries (profile_id, trashed_at, purge_after) values (?1, ?2, ?3)",
                    params![id.as_str(), trashed_at, purge_after],
                )?;
            }
        },
        _ => return Err(StoreError::Invalid("undo does not match the action")),
    }
    bump(tx, id)?;
    Ok(true)
}

impl LocalStore {
    /// Applies `op` to every id, [`BATCH`] per transaction, and reports each profile's outcome.
    /// `cancel` is checked between batches; profiles after a cancellation are not reported.
    pub fn bulk_apply(
        &self,
        workspace: &WorkspaceId,
        ids: &[ProfileId],
        op: &BulkOp,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Vec<ItemResult>, StoreError> {
        if ids.len() > MAX_BULK {
            return Err(StoreError::Invalid("too many profiles in one request"));
        }
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(BATCH) {
            if cancel() {
                break;
            }
            let mut conn = self.w()?;
            let tx = conn.transaction()?;
            for id in chunk {
                let outcome = apply_one(&tx, workspace, id, op)?;
                out.push(ItemResult {
                    id: id.clone(),
                    outcome,
                });
            }
            tx.commit()?;
        }
        Ok(out)
    }

    /// Undoes [`LocalStore::bulk_apply`] results. Returns (restored, skipped because changed since).
    pub fn bulk_undo(&self, op: &BulkOp, items: &[ItemResult]) -> Result<(u64, u64), StoreError> {
        let (mut restored, mut skipped) = (0u64, 0u64);
        for chunk in items.chunks(BATCH) {
            let mut conn = self.w()?;
            let tx = conn.transaction()?;
            for item in chunk {
                if let ItemOutcome::Changed { prior, version } = &item.outcome {
                    if undo_one(&tx, &item.id, op, prior, *version)? {
                        restored += 1;
                    } else {
                        skipped += 1;
                    }
                }
            }
            tx.commit()?;
        }
        Ok((restored, skipped))
    }

    /// Trashed profiles whose retention has ended (oldest first, at most `limit`).
    pub fn due_for_purge(&self, limit: u32) -> Result<Vec<ProfileId>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id from trash_entries
              where purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
              order by purge_after limit ?1",
        )?;
        let ids = stmt
            .query_map([limit], |r| r.get::<_, String>(0))?
            .map(|r| {
                r.map_err(StoreError::from)
                    .and_then(|s| ProfileId::parse(&s).map_err(|_| StoreError::Corrupt))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        Ok(ids)
    }

    pub fn is_trashed(&self, id: &ProfileId) -> Result<bool, StoreError> {
        Ok(self
            .r()?
            .query_row(
                "select 1 from trash_entries where profile_id = ?1",
                [id.as_str()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}
