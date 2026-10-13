//! Synchronization state of linked profiles and resumable sync jobs (milestone 07).
//!
//! - `org_profile_links` gains the version each linked profile last synchronized (the base of its next upload),
//!   whether it changed since (`dirty`), whether it is backed up automatically after a clean close, and the newer
//!   version found when an upload hit a conflict.
//! - `sync_jobs` holds each upload/restore job as JSON exactly as the engine saved it. Jobs hold no secret: no data
//!   key, no signed URL, no access token.

use crate::{LocalStore, StoreError};
use pb_runtime::ProfileId;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

/// Finished jobs kept per profile (for the status line and diagnostics).
pub const KEEP_FINISHED_JOBS: u32 = 5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncLink {
    pub local_profile_id: ProfileId,
    pub org_id: String,
    pub org_profile_id: String,
    pub synced_version: i64,
    pub synced_snapshot_id: Option<String>,
    pub synced_at: Option<String>,
    pub dirty: bool,
    pub auto_backup: bool,
    pub conflict_head: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoredJob {
    pub id: String,
    pub kind: String,
    pub local_profile_id: ProfileId,
    pub state: String,
    pub payload: String,
    pub updated_at: String,
}

const LINK_COLUMNS: &str =
    "local_profile_id, org_id, org_profile_id, synced_version, synced_snapshot_id, synced_at,
  dirty, auto_backup, conflict_head";

type RawLink = (
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

fn link_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawLink> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
    ))
}

fn to_link(raw: RawLink) -> Result<SyncLink, StoreError> {
    let (
        local,
        org_id,
        org_profile_id,
        synced_version,
        synced_snapshot_id,
        synced_at,
        dirty,
        auto,
        conflict,
    ) = raw;
    Ok(SyncLink {
        local_profile_id: ProfileId::parse(&local).map_err(|_| StoreError::Corrupt)?,
        org_id,
        org_profile_id,
        synced_version,
        synced_snapshot_id,
        synced_at,
        dirty: dirty == 1,
        auto_backup: auto == 1,
        conflict_head: conflict,
    })
}

fn snapshot_id_ok(id: &str) -> bool {
    id.len() == 30 && id.starts_with("snp_")
}

impl LocalStore {
    pub fn sync_link(&self, local: &ProfileId) -> Result<Option<SyncLink>, StoreError> {
        self.r()?
            .query_row(
                &format!(
                    "select {LINK_COLUMNS} from org_profile_links where local_profile_id = ?1"
                ),
                params![local.as_str()],
                link_row,
            )
            .optional()?
            .map(to_link)
            .transpose()
    }

    /// Every link of an organization (or all), for the sync status of a list.
    pub fn sync_links(&self, org_id: Option<&str>) -> Result<Vec<SyncLink>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare(&format!(
            "select {LINK_COLUMNS} from org_profile_links where ?1 is null or org_id = ?1
              order by linked_at, local_profile_id limit 10000"
        ))?;
        let rows = stmt
            .query_map(params![org_id], link_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(to_link).collect()
    }

    /// The local profile changed (it ran): its next backup is due.
    pub fn mark_sync_dirty(&self, local: &ProfileId) -> Result<bool, StoreError> {
        Ok(self.w()?.execute(
            "update org_profile_links set dirty = 1 where local_profile_id = ?1",
            params![local.as_str()],
        )? == 1)
    }

    /// A snapshot of this profile became `version`: it is the base of the next upload.
    /// `dirty`: `None` leaves it as it is (the profile may have run since its snapshot was sealed).
    pub fn set_synced(
        &self,
        local: &ProfileId,
        version: i64,
        snapshot_id: &str,
        dirty: Option<bool>,
    ) -> Result<(), StoreError> {
        if version < 0 || !snapshot_id_ok(snapshot_id) {
            return Err(StoreError::Invalid("snapshot"));
        }
        self.w()?.execute(
            "update org_profile_links set synced_version = ?2, synced_snapshot_id = ?3,
                    synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), dirty = coalesce(?4, dirty),
                    conflict_head = null
              where local_profile_id = ?1",
            params![local.as_str(), version, snapshot_id, dirty.map(i64::from)],
        )?;
        Ok(())
    }

    pub fn set_sync_dirty(&self, local: &ProfileId, dirty: bool) -> Result<(), StoreError> {
        self.w()?.execute(
            "update org_profile_links set dirty = ?2 where local_profile_id = ?1",
            params![local.as_str(), i64::from(dirty)],
        )?;
        Ok(())
    }

    /// An upload found a newer version (`head`, when known). Nothing else changes until the user decides.
    pub fn set_sync_conflict(
        &self,
        local: &ProfileId,
        head: Option<i64>,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            "update org_profile_links set conflict_head = coalesce(?2, synced_version + 1) where local_profile_id = ?1",
            params![local.as_str(), head],
        )?;
        Ok(())
    }

    /// "Upload mine as the newest": the next upload is based on the newer version the user chose to replace.
    pub fn accept_conflict_base(&self, local: &ProfileId) -> Result<Option<i64>, StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let head: Option<i64> = tx
            .query_row(
                "select conflict_head from org_profile_links where local_profile_id = ?1",
                params![local.as_str()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let Some(h) = head {
            tx.execute(
                "update org_profile_links set synced_version = ?2, conflict_head = null, dirty = 1
                  where local_profile_id = ?1",
                params![local.as_str(), h],
            )?;
        }
        tx.commit()?;
        Ok(head)
    }

    pub fn set_auto_backup(&self, local: &ProfileId, on: bool) -> Result<bool, StoreError> {
        Ok(self.w()?.execute(
            "update org_profile_links set auto_backup = ?2 where local_profile_id = ?1",
            params![local.as_str(), i64::from(on)],
        )? == 1)
    }

    /// Links a local profile restored from an organization profile (first restore on this computer, or a copy).
    pub fn link_restored(
        &self,
        local: &ProfileId,
        org_id: &str,
        org_profile_id: &str,
        version: i64,
        snapshot_id: &str,
    ) -> Result<(), StoreError> {
        self.link_org_profiles(org_id, &[(local.clone(), org_profile_id.to_owned())])?;
        self.set_synced(local, version, snapshot_id, Some(false))
    }

    // ------------------------------------------------------------------------------------------------- jobs

    pub fn save_sync_job(
        &self,
        id: &str,
        kind: &str,
        local: &ProfileId,
        state: &str,
        payload: &str,
    ) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        tx.execute(
            "insert into sync_jobs (id, kind, local_profile_id, state, payload) values (?1, ?2, ?3, ?4, ?5)
             on conflict (id) do update set state = excluded.state, payload = excluded.payload,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![id, kind, local.as_str(), state, payload],
        )?;
        // Keep the newest finished jobs per profile; unfinished ones are never pruned.
        tx.execute(
            "delete from sync_jobs where local_profile_id = ?1
               and state in ('committed', 'conflict', 'failed', 'canceled', 'done')
               and id not in (select id from sync_jobs where local_profile_id = ?1
                                and state in ('committed', 'conflict', 'failed', 'canceled', 'done')
                              order by updated_at desc, id desc limit ?2)",
            params![local.as_str(), KEEP_FINISHED_JOBS],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn sync_job(&self, id: &str) -> Result<Option<StoredJob>, StoreError> {
        self.query_jobs("where id = ?1", params![id])
            .map(|mut v| v.pop())
    }

    /// Unfinished jobs (resumed at start-up and when the network returns), oldest first.
    pub fn open_sync_jobs(&self) -> Result<Vec<StoredJob>, StoreError> {
        self.query_jobs(
            "where state not in ('committed', 'conflict', 'failed', 'canceled', 'done')
              order by updated_at, id limit 1000",
            [],
        )
    }

    /// The newest job of a profile (any state).
    pub fn latest_sync_job(&self, local: &ProfileId) -> Result<Option<StoredJob>, StoreError> {
        self.query_jobs(
            "where local_profile_id = ?1 order by updated_at desc, id desc limit 1",
            params![local.as_str()],
        )
        .map(|mut v| v.pop())
    }

    fn query_jobs(
        &self,
        tail: &str,
        p: impl rusqlite::Params,
    ) -> Result<Vec<StoredJob>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare(&format!(
            "select id, kind, local_profile_id, state, payload, updated_at from sync_jobs {tail}"
        ))?;
        let rows = stmt
            .query_map(p, |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, kind, local, state, payload, updated_at)| {
                Ok(StoredJob {
                    id,
                    kind,
                    local_profile_id: ProfileId::parse(&local).map_err(|_| StoreError::Corrupt)?,
                    state,
                    payload,
                    updated_at,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::{LocalStore, NewProfile, StoreError};
    use pb_runtime::ProfileId;

    fn setup() -> Result<(tempfile::TempDir, LocalStore, ProfileId), StoreError> {
        let dir = tempfile::tempdir().map_err(|_| StoreError::Invalid("tmp"))?;
        let store = LocalStore::open(&dir.path().join("local.db"))?;
        let ws = store.create_workspace("Local")?;
        let p = store.insert_profile(NewProfile::basic(
            ProfileId::generate().map_err(|_| StoreError::Invalid("rng"))?,
            Some(ws.id),
            "Shop",
            None,
        ))?;
        Ok((dir, store, p.id))
    }

    const ORG: &str = "org_01J9ZSEED0ACME000000000000";
    const PRF: &str = "prf_01J9ZSEED0A010000000000000";
    const SNP: &str = "snp_01M4T7R0Q4FN6G53AWPJQ3CBMK";

    #[test]
    fn links_track_the_synced_version_dirty_state_and_conflicts() -> Result<(), StoreError> {
        let (_d, store, local) = setup()?;
        assert_eq!(store.sync_link(&local)?, None);
        assert!(
            !store.mark_sync_dirty(&local)?,
            "unlinked profiles have no sync state"
        );
        store.link_org_profiles(ORG, &[(local.clone(), PRF.into())])?;
        let link = store.sync_link(&local)?.ok_or(StoreError::Corrupt)?;
        assert_eq!(
            (link.synced_version, link.dirty, link.auto_backup),
            (0, true, true)
        );
        store.set_synced(&local, 3, SNP, Some(false))?;
        let link = store.sync_link(&local)?.ok_or(StoreError::Corrupt)?;
        assert_eq!(link.synced_version, 3);
        assert!(!link.dirty && link.synced_at.is_some());
        assert!(store.set_synced(&local, 4, "snp_bad", None).is_err());
        store.mark_sync_dirty(&local)?;
        store.set_sync_conflict(&local, Some(5))?;
        let link = store.sync_link(&local)?.ok_or(StoreError::Corrupt)?;
        assert_eq!((link.dirty, link.conflict_head), (true, Some(5)));
        assert_eq!(store.accept_conflict_base(&local)?, Some(5));
        let link = store.sync_link(&local)?.ok_or(StoreError::Corrupt)?;
        assert_eq!((link.synced_version, link.conflict_head), (5, None));
        store.set_auto_backup(&local, false)?;
        assert!(
            !store
                .sync_link(&local)?
                .ok_or(StoreError::Corrupt)?
                .auto_backup
        );
        assert_eq!(store.sync_links(Some(ORG))?.len(), 1);
        Ok(())
    }

    #[test]
    fn jobs_are_resumable_and_finished_ones_are_pruned() -> Result<(), StoreError> {
        let (_d, store, local) = setup()?;
        store.save_sync_job("sj_open", "upload", &local, "uploading", r#"{"a":1}"#)?;
        for i in 0..8 {
            store.save_sync_job(&format!("sj_done{i}"), "upload", &local, "committed", "{}")?;
        }
        assert!(
            store
                .save_sync_job("sj_bad", "upload", &local, "x", "not json")
                .is_err()
        );
        let open = store.open_sync_jobs()?;
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].payload, r#"{"a":1}"#);
        let all: Vec<_> = (0..8)
            .filter_map(|i| store.sync_job(&format!("sj_done{i}")).ok().flatten())
            .collect();
        assert_eq!(all.len() as u32, super::KEEP_FINISHED_JOBS);
        assert!(
            store.sync_job("sj_open")?.is_some(),
            "unfinished jobs are kept"
        );
        store.save_sync_job("sj_open", "upload", &local, "committed", "{}")?;
        assert!(store.open_sync_jobs()?.is_empty());
        assert_eq!(
            store.latest_sync_job(&local)?.map(|j| j.id).as_deref(),
            Some("sj_open")
        );
        Ok(())
    }
}
