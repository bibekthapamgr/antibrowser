//! Local metadata store for the desktop manager.
//!
//! Data ownership (milestone 01): device cache, local profile metadata, queued local-only changes and
//! process tracking. It is never consulted for authorization decisions; the server is authoritative.
//!
//! Concurrency model: one writer connection behind a mutex (SQLite allows one writer) plus a separate
//! reader connection; WAL mode lets reads proceed while a write is in progress. Every list query is bounded.

use pb_runtime::ProfileId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub const MAX_PAGE: u32 = 100;
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("store lock poisoned")]
    Poisoned,
    #[error("stored data is corrupt")]
    Corrupt,
    #[error("database schema {found} is newer than this build supports ({supported})")]
    TooNew { found: i64, supported: i64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalProfile {
    pub id: ProfileId,
    pub name: String,
    pub client_label: Option<String>,
    pub folder_label: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub running_pid: Option<u32>,
}

pub struct NewProfile<'a> {
    pub id: &'a ProfileId,
    pub name: &'a str,
    pub client_label: Option<&'a str>,
    pub folder_label: Option<&'a str>,
}

pub struct LocalStore {
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
}

impl LocalStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let writer = Connection::open(path)?;
        writer.pragma_update(None, "journal_mode", "WAL")?;
        writer.pragma_update(None, "synchronous", "NORMAL")?;
        writer.pragma_update(None, "foreign_keys", "ON")?;
        writer.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&writer)?;

        let reader = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        reader.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
        })
    }

    fn w(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.writer.lock().map_err(|_| StoreError::Poisoned)
    }
    fn r(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.reader.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn insert_profile(&self, p: NewProfile<'_>) -> Result<LocalProfile, StoreError> {
        let conn = self.w()?;
        conn.execute(
            "insert into profiles (id, name, client_label, folder_label, search_text)
             values (?1, ?2, ?3, ?4, lower(?2 || ' ' || coalesce(?3, '') || ' ' || coalesce(?4, '')))",
            params![p.id.as_str(), p.name, p.client_label, p.folder_label],
        )?;
        drop(conn);
        self.get_profile(p.id)?.ok_or(StoreError::Corrupt)
    }

    /// Batch insert in one transaction (imports, fixtures, benchmarks).
    pub fn insert_profiles(&self, rows: &[NewProfile<'_>]) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "insert into profiles (id, name, client_label, folder_label, search_text)
                 values (?1, ?2, ?3, ?4, lower(?2 || ' ' || coalesce(?3, '') || ' ' || coalesce(?4, '')))",
            )?;
            for p in rows {
                stmt.execute(params![
                    p.id.as_str(),
                    p.name,
                    p.client_label,
                    p.folder_label
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_profile(&self, id: &ProfileId) -> Result<Option<LocalProfile>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!("{SELECT_PROFILE} where p.id = ?1"))?;
        stmt.query_row(params![id.as_str()], row_to_profile)
            .optional()?
            .transpose()
    }

    /// Bounded, ordered search over name/client/folder labels. `limit` is clamped to 1..=100.
    pub fn search_profiles(
        &self,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LocalProfile>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let conn = self.r()?;
        let needle = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| format!("%{}%", escape_like(&q.to_lowercase())));
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT_PROFILE} where (?1 is null or p.search_text like ?1 escape '\\') order by p.name, p.id limit ?2"
        ))?;
        let rows = stmt.query_map(params![needle, limit], row_to_profile)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    pub fn record_process(&self, id: &ProfileId, pid: u32) -> Result<(), StoreError> {
        self.w()?.execute(
            "insert into processes (profile_id, pid) values (?1, ?2)
             on conflict (profile_id) do update set pid = excluded.pid, started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![id.as_str(), pid],
        )?;
        Ok(())
    }

    pub fn clear_process(&self, id: &ProfileId) -> Result<(), StoreError> {
        self.w()?.execute(
            "delete from processes where profile_id = ?1",
            params![id.as_str()],
        )?;
        Ok(())
    }

    pub fn profile_count(&self) -> Result<u64, StoreError> {
        Ok(self
            .r()?
            .query_row("select count(*) from profiles", [], |r| r.get::<_, i64>(0))?
            as u64)
    }
}

const SELECT_PROFILE: &str = "select p.id, p.name, p.client_label, p.folder_label, p.version, p.created_at, p.updated_at, pr.pid
     from profiles p left join processes pr on pr.profile_id = p.id";

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<LocalProfile, StoreError>> {
    let id: String = row.get(0)?;
    let Ok(id) = ProfileId::parse(&id) else {
        return Ok(Err(StoreError::Corrupt));
    };
    Ok(Ok(LocalProfile {
        id,
        name: row.get(1)?,
        client_label: row.get(2)?,
        folder_label: row.get(3)?,
        version: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        running_pid: row.get(7)?,
    }))
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let current: i64 = conn.query_row("pragma user_version", [], |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(StoreError::TooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current < 1 {
        conn.execute_batch(
            "begin;
             create table profiles (
               id            text primary key check (id glob 'prf_[0-9A-Z]*' and length(id) = 30),
               org_id        text,
               name          text not null check (length(name) between 1 and 120),
               client_label  text check (client_label is null or length(client_label) between 1 and 120),
               folder_label  text check (folder_label is null or length(folder_label) between 1 and 120),
               search_text   text not null,
               version       integer not null default 1,
               created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ) strict;
             create index profiles_name_idx on profiles (name, id);
             create table processes (
               profile_id  text primary key references profiles(id) on delete cascade,
               pid         integer not null,
               started_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ) strict;
             create table pending_changes (
               seq         integer primary key autoincrement,
               profile_id  text references profiles(id) on delete cascade,
               kind        text not null,
               payload     text not null,
               created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ) strict;
             pragma user_version = 1;
             commit;",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u32) -> ProfileId {
        ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
    }

    #[test]
    fn wal_mode_search_and_process_tracking() -> Result<(), StoreError> {
        let tmp = tempfile::tempdir().map_err(|_| StoreError::Corrupt)?;
        let store = LocalStore::open(&tmp.path().join("local.db"))?;
        let mode: String = store
            .r()?
            .query_row("pragma journal_mode", [], |r| r.get(0))?;
        assert_eq!(mode, "wal");

        let a = id(1);
        store.insert_profile(NewProfile {
            id: &a,
            name: "Shop admin",
            client_label: Some("North"),
            folder_label: None,
        })?;
        store.insert_profile(NewProfile {
            id: &id(2),
            name: "Ads",
            client_label: Some("South_1"),
            folder_label: None,
        })?;
        assert_eq!(store.search_profiles(Some("north"), 10)?.len(), 1);
        assert_eq!(
            store.search_profiles(Some("_"), 10)?.len(),
            1,
            "LIKE wildcards are escaped"
        );
        assert_eq!(store.search_profiles(None, 10)?.len(), 2);

        store.record_process(&a, 4242)?;
        assert_eq!(
            store.get_profile(&a)?.and_then(|p| p.running_pid),
            Some(4242)
        );
        store.clear_process(&a)?;
        assert_eq!(store.get_profile(&a)?.and_then(|p| p.running_pid), None);
        Ok(())
    }

    #[test]
    fn limits_are_clamped() -> Result<(), StoreError> {
        let tmp = tempfile::tempdir().map_err(|_| StoreError::Corrupt)?;
        let store = LocalStore::open(&tmp.path().join("local.db"))?;
        let ids: Vec<ProfileId> = (0..150).map(id).collect();
        let rows: Vec<NewProfile<'_>> = ids
            .iter()
            .map(|i| NewProfile {
                id: i,
                name: "p",
                client_label: None,
                folder_label: None,
            })
            .collect();
        store.insert_profiles(&rows)?;
        assert_eq!(store.search_profiles(None, 10_000)?.len(), 100);
        assert_eq!(store.search_profiles(None, 0)?.len(), 1);
        Ok(())
    }

    #[test]
    fn refuses_a_newer_schema() -> Result<(), StoreError> {
        let tmp = tempfile::tempdir().map_err(|_| StoreError::Corrupt)?;
        let path = tmp.path().join("local.db");
        Connection::open(&path)?.pragma_update(None, "user_version", 99)?;
        assert!(matches!(
            LocalStore::open(&path),
            Err(StoreError::TooNew { .. })
        ));
        Ok(())
    }
}
