//! Local metadata store for the desktop manager (SQLite, WAL, foreign keys, single writer).
//!
//! Data ownership (milestone 01): device cache, local profile metadata, queued local-only changes and process
//! tracking. It is never consulted for authorization decisions; the server is authoritative.
//! Milestone 02 adds: workspaces, devices, allow-listed settings, runtime installations, timings and one-time
//! auth transactions for deep links.
//!
//! Concurrency: one writer connection behind a mutex plus a separate reader connection; WAL lets reads proceed
//! during writes. Every list query is bounded.

pub mod migrations;
pub mod settings;

use migrations::{MigrationFailure, SCHEMA_VERSION};
use pb_runtime::{DeviceId, ProfileId, WorkspaceId, random_hex};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use settings::{SettingError, SettingValue};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Upper bound for one local profile listing. The manager renders the list virtualized, so a whole workspace
/// (target: 10,000 profiles) fits in one bounded query; cloud APIs keep their own smaller page size.
pub const MAX_LIST: u32 = 10_000;

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
    #[error("migration from v{} failed at v{}", .0.from, .0.to)]
    MigrationFailed(MigrationFailure),
    #[error("not found")]
    NotFound,
    #[error("version conflict (current {current})")]
    VersionConflict { current: i64 },
    #[error("setting rejected: {0:?}")]
    Setting(SettingError),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub kind: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalProfile {
    pub id: ProfileId,
    pub workspace_id: Option<WorkspaceId>,
    pub name: String,
    pub client_label: Option<String>,
    pub folder_label: Option<String>,
    pub notes: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub running_pid: Option<u32>,
}

pub struct NewProfile<'a> {
    pub id: &'a ProfileId,
    pub workspace_id: Option<&'a WorkspaceId>,
    pub name: &'a str,
    pub client_label: Option<&'a str>,
    pub folder_label: Option<&'a str>,
}

/// Fields to change; `None` leaves a field unchanged. `client_label: Some(None)` clears it.
#[derive(Default)]
pub struct ProfileUpdate<'a> {
    pub name: Option<&'a str>,
    pub client_label: Option<Option<&'a str>>,
    pub notes: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TrackedProcess {
    pub profile_id: ProfileId,
    pub pid: u32,
    /// OS process start time (seconds since epoch) used to detect PID reuse.
    pub process_start_time: Option<u64>,
    pub executable: Option<String>,
    pub started_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Device {
    pub id: DeviceId,
    pub installation_id: String,
    pub platform: String,
    pub architecture: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RuntimeInstallation {
    pub version: String,
    pub platform: String,
    pub digest: String,
    pub verified_at: Option<String>,
    pub path: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TimingSummary {
    pub kind: String,
    pub count: u32,
    pub last_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthTxError {
    Unknown,
    Expired,
    Replayed,
}

pub struct LocalStore {
    path: PathBuf,
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
}

impl LocalStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::open_inner(path, None)
    }

    /// Test hook: behaves like `open` but makes the migration to `fail_at` fail, as a crash would.
    #[doc(hidden)]
    pub fn open_simulating_failure(path: &Path, fail_at: i64) -> Result<Self, StoreError> {
        Self::open_inner(path, Some(fail_at))
    }

    fn open_inner(path: &Path, fail_at: Option<i64>) -> Result<Self, StoreError> {
        let mut writer = Connection::open(path)?;
        writer.pragma_update(None, "journal_mode", "WAL")?;
        writer.pragma_update(None, "synchronous", "NORMAL")?;
        writer.pragma_update(None, "foreign_keys", "ON")?;
        writer.busy_timeout(std::time::Duration::from_secs(5))?;

        let from = migrations::current_version(&writer)?;
        if from > SCHEMA_VERSION {
            return Err(StoreError::TooNew {
                found: from,
                supported: SCHEMA_VERSION,
            });
        }
        if from < SCHEMA_VERSION {
            let backup = migrations::backup_before_upgrade(&writer, path, from)?;
            if let Err((to, step)) = migrations::apply(&mut writer, from, fail_at) {
                return Err(StoreError::MigrationFailed(MigrationFailure {
                    from,
                    to,
                    step,
                    backup,
                }));
            }
        }

        let reader = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        reader.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
        })
    }

    /// Replaces the database with a backup written before a failed upgrade. Only call while no store is open.
    pub fn restore_backup(db_path: &Path, backup: &Path) -> Result<(), StoreError> {
        if !backup.is_file() {
            return Err(StoreError::NotFound);
        }
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{suffix}", db_path.display()));
            if side.exists() {
                std::fs::remove_file(side)?;
            }
        }
        std::fs::copy(backup, db_path)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn w(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.writer.lock().map_err(|_| StoreError::Poisoned)
    }
    fn r(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.reader.lock().map_err(|_| StoreError::Poisoned)
    }

    // ------------------------------------------------------------------ health
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(migrations::current_version(&*self.r()?)?)
    }
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        Ok(self
            .r()?
            .query_row("pragma journal_mode", [], |r| r.get(0))?)
    }
    pub fn foreign_keys_enabled(&self) -> Result<bool, StoreError> {
        Ok(self
            .w()?
            .query_row("pragma foreign_keys", [], |r| r.get::<_, i64>(0))?
            == 1)
    }
    pub fn integrity_ok(&self) -> Result<bool, StoreError> {
        Ok(self
            .r()?
            .query_row("pragma quick_check", [], |r| r.get::<_, String>(0))?
            == "ok")
    }

    // ------------------------------------------------------------------ workspaces
    pub fn create_workspace(&self, name: &str) -> Result<Workspace, StoreError> {
        let id = WorkspaceId::generate().map_err(|_| StoreError::Corrupt)?;
        self.w()?.execute(
            "insert into workspaces (id, name) values (?1, ?2)",
            params![id.as_str(), name],
        )?;
        self.get_workspace(&id)?.ok_or(StoreError::Corrupt)
    }

    pub fn get_workspace(&self, id: &WorkspaceId) -> Result<Option<Workspace>, StoreError> {
        self.r()?
            .query_row(
                "select id, name, kind, created_at from workspaces where id = ?1",
                params![id.as_str()],
                row_to_workspace,
            )
            .optional()?
            .transpose()
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select id, name, kind, created_at from workspaces order by created_at, id limit 100",
        )?;
        let rows = stmt.query_map([], row_to_workspace)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    // ------------------------------------------------------------------ profiles
    pub fn insert_profile(&self, p: NewProfile<'_>) -> Result<LocalProfile, StoreError> {
        self.w()?.execute(
            "insert into profiles (id, workspace_id, name, client_label, folder_label, search_text)
             values (?1, ?2, ?3, ?4, ?5, lower(?3 || ' ' || coalesce(?4, '') || ' ' || coalesce(?5, '')))",
            params![p.id.as_str(), p.workspace_id.map(WorkspaceId::as_str), p.name, p.client_label, p.folder_label],
        )?;
        self.get_profile(p.id)?.ok_or(StoreError::Corrupt)
    }

    /// Batch insert in one transaction (imports, fixtures, benchmarks).
    pub fn insert_profiles(&self, rows: &[NewProfile<'_>]) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "insert into profiles (id, workspace_id, name, client_label, folder_label, search_text)
                 values (?1, ?2, ?3, ?4, ?5, lower(?3 || ' ' || coalesce(?4, '') || ' ' || coalesce(?5, '')))",
            )?;
            for p in rows {
                stmt.execute(params![
                    p.id.as_str(),
                    p.workspace_id.map(WorkspaceId::as_str),
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

    /// Bounded, ordered search over name/client/folder labels within a workspace. `limit` is clamped to 1..=[`MAX_LIST`].
    pub fn search_profiles(
        &self,
        workspace: Option<&WorkspaceId>,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LocalProfile>, StoreError> {
        let limit = limit.clamp(1, MAX_LIST);
        let conn = self.r()?;
        let needle = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| format!("%{}%", escape_like(&q.to_lowercase())));
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT_PROFILE}
             where (?1 is null or p.workspace_id = ?1)
               and (?2 is null or p.search_text like ?2 escape '\\')
             order by p.name, p.id limit ?3"
        ))?;
        let rows = stmt.query_map(
            params![workspace.map(WorkspaceId::as_str), needle, limit],
            row_to_profile,
        )?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    pub fn update_profile(
        &self,
        id: &ProfileId,
        changes: ProfileUpdate<'_>,
        expected_version: i64,
    ) -> Result<LocalProfile, StoreError> {
        let updated = self.w()?.execute(
            "update profiles set
               name = coalesce(?3, name),
               client_label = case when ?4 then ?5 else client_label end,
               notes = coalesce(?6, notes),
               search_text = lower(coalesce(?3, name) || ' ' || coalesce(case when ?4 then ?5 else client_label end, '')
                                   || ' ' || coalesce(folder_label, '')),
               version = version + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             where id = ?1 and version = ?2",
            params![
                id.as_str(),
                expected_version,
                changes.name,
                changes.client_label.is_some(),
                changes.client_label.flatten(),
                changes.notes
            ],
        )?;
        if updated == 0 {
            return match self.get_profile(id)? {
                Some(p) => Err(StoreError::VersionConflict { current: p.version }),
                None => Err(StoreError::NotFound),
            };
        }
        self.get_profile(id)?.ok_or(StoreError::Corrupt)
    }

    pub fn profile_count(&self, workspace: Option<&WorkspaceId>) -> Result<u64, StoreError> {
        Ok(self.r()?.query_row(
            "select count(*) from profiles where (?1 is null or workspace_id = ?1)",
            params![workspace.map(WorkspaceId::as_str)],
            |r| r.get::<_, i64>(0),
        )? as u64)
    }

    // ------------------------------------------------------------------ processes
    pub fn record_process(
        &self,
        id: &ProfileId,
        pid: u32,
        process_start_time: Option<u64>,
        executable: Option<&str>,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            "insert into processes (profile_id, pid, process_start_time, executable) values (?1, ?2, ?3, ?4)
             on conflict (profile_id) do update set pid = excluded.pid, process_start_time = excluded.process_start_time,
               executable = excluded.executable, started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![id.as_str(), pid, process_start_time.map(|t| t as i64), executable],
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

    pub fn list_processes(&self) -> Result<Vec<TrackedProcess>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id, pid, process_start_time, executable, started_at from processes order by started_at limit 1000",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(ProfileId::parse(&id).map(|profile_id| TrackedProcess {
                profile_id,
                pid: r.get(1).unwrap_or_default(),
                process_start_time: r.get::<_, Option<i64>>(2).ok().flatten().map(|t| t as u64),
                executable: r.get(3).ok().flatten(),
                started_at: r.get(4).unwrap_or_default(),
            }))
        })?;
        rows.map(|r| {
            r.map_err(StoreError::from)
                .and_then(|x| x.map_err(|_| StoreError::Corrupt))
        })
        .collect()
    }

    // ------------------------------------------------------------------ device
    /// Returns this installation's device record, creating it on first run.
    pub fn ensure_device(&self, platform: &str, architecture: &str) -> Result<Device, StoreError> {
        if let Some(d) = self.device()? {
            return Ok(d);
        }
        let id = DeviceId::generate().map_err(|_| StoreError::Corrupt)?;
        let installation_id = random_hex(16).map_err(|_| StoreError::Corrupt)?;
        self.w()?.execute(
            "insert into devices (id, installation_id, platform, architecture) values (?1, ?2, ?3, ?4)",
            params![id.as_str(), installation_id, platform, architecture],
        )?;
        self.device()?.ok_or(StoreError::Corrupt)
    }

    pub fn device(&self) -> Result<Option<Device>, StoreError> {
        self.r()?
            .query_row(
                "select id, installation_id, platform, architecture, created_at from devices order by created_at limit 1",
                [],
                |r| {
                    let id: String = r.get(0)?;
                    Ok(DeviceId::parse(&id).map(|id| Device {
                        id,
                        installation_id: r.get(1).unwrap_or_default(),
                        platform: r.get(2).unwrap_or_default(),
                        architecture: r.get(3).unwrap_or_default(),
                        created_at: r.get(4).unwrap_or_default(),
                    }))
                },
            )
            .optional()?
            .map(|d| d.map_err(|_| StoreError::Corrupt))
            .transpose()
    }

    // ------------------------------------------------------------------ settings
    pub fn get_settings(&self) -> Result<Vec<SettingValue>, StoreError> {
        settings::SETTINGS
            .iter()
            .map(|s| self.get_setting(s.key))
            .collect()
    }

    pub fn get_setting(&self, key: &str) -> Result<SettingValue, StoreError> {
        let spec = settings::spec(key).ok_or(StoreError::Setting(SettingError::UnknownKey))?;
        let row: Option<(String, i64)> = self
            .r()?
            .query_row(
                "select value_json, version from settings where key = ?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((json, version)) => SettingValue {
                key: spec.key,
                value: serde_json::from_str(&json).map_err(|_| StoreError::Corrupt)?,
                version,
                ui_settable: spec.ui_settable,
            },
            None => SettingValue {
                key: spec.key,
                value: (spec.default)(),
                version: 0,
                ui_settable: spec.ui_settable,
            },
        })
    }

    /// `from_ui` enforces the allow-list's `ui_settable` flag. `expected_version` (0 = never written) gives
    /// optimistic concurrency; `None` skips the check (native commands that own the value).
    pub fn set_setting(
        &self,
        key: &str,
        value: &Value,
        from_ui: bool,
        expected_version: Option<i64>,
    ) -> Result<SettingValue, StoreError> {
        let spec = settings::validate(key, value, from_ui).map_err(StoreError::Setting)?;
        let json = serde_json::to_string(value).map_err(|_| StoreError::Corrupt)?;
        {
            let mut conn = self.w()?;
            let tx = conn.transaction()?;
            let current: i64 = tx
                .query_row(
                    "select version from settings where key = ?1",
                    params![spec.key],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if let Some(expected) = expected_version
                && expected != current
            {
                return Err(StoreError::VersionConflict { current });
            }
            tx.execute(
                "insert into settings (key, value_json) values (?1, ?2)
                 on conflict (key) do update set value_json = excluded.value_json, version = settings.version + 1,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![spec.key, json],
            )?;
            tx.commit()?;
        }
        self.get_setting(spec.key)
    }

    // ------------------------------------------------------------------ runtime installations
    pub fn upsert_runtime(&self, r: &RuntimeInstallation) -> Result<(), StoreError> {
        self.w()?.execute(
            "insert into runtime_installations (version, platform, digest, verified_at, path, status)
             values (?1, ?2, ?3, ?4, ?5, ?6)
             on conflict (version, platform) do update set digest = excluded.digest, verified_at = excluded.verified_at,
               path = excluded.path, status = excluded.status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![r.version, r.platform, r.digest, r.verified_at, r.path, r.status],
        )?;
        Ok(())
    }

    pub fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select version, platform, digest, verified_at, path, status from runtime_installations
             order by updated_at desc limit 50",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RuntimeInstallation {
                version: r.get(0)?,
                platform: r.get(1)?,
                digest: r.get(2)?,
                verified_at: r.get(3)?,
                path: r.get(4)?,
                status: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ------------------------------------------------------------------ timings
    pub fn record_timing(&self, kind: &str, millis: f64) -> Result<(), StoreError> {
        let conn = self.w()?;
        conn.execute(
            "insert into timings (kind, millis) values (?1, ?2)",
            params![kind, millis.max(0.0)],
        )?;
        // Keep the newest 200 samples per kind.
        conn.execute(
            "delete from timings where kind = ?1 and seq not in
               (select seq from timings where kind = ?1 order by seq desc limit 200)",
            params![kind],
        )?;
        Ok(())
    }

    pub fn timing_summary(&self, kind: &str) -> Result<TimingSummary, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select millis from timings where kind = ?1 order by seq desc limit 200",
        )?;
        let mut samples: Vec<f64> = stmt
            .query_map(params![kind], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let last = samples.first().copied();
        samples.sort_by(f64::total_cmp);
        let pct =
            |p: usize| (!samples.is_empty()).then(|| samples[((samples.len() - 1) * p) / 100]);
        Ok(TimingSummary {
            kind: kind.to_owned(),
            count: samples.len() as u32,
            last_ms: last,
            p50_ms: pct(50),
            p95_ms: pct(95),
        })
    }

    // ------------------------------------------------------------------ one-time auth transactions (deep links)
    /// Stores only a hash of `state`. Used by milestone 06 when a browser login starts.
    pub fn begin_auth_transaction(&self, state: &str, ttl_secs: u32) -> Result<(), StoreError> {
        self.w()?.execute(
            "insert into auth_transactions (state_hash, expires_at)
             values (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?2 || ' seconds'))",
            params![sha256_hex(state), ttl_secs],
        )?;
        Ok(())
    }

    /// Accepts a state exactly once, before it expires.
    pub fn consume_auth_transaction(
        &self,
        state: &str,
    ) -> Result<Result<(), AuthTxError>, StoreError> {
        let hash = sha256_hex(state);
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let row: Option<(bool, bool)> = tx
            .query_row(
                "select consumed_at is not null, expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   from auth_transactions where state_hash = ?1",
                params![hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let outcome = match row {
            None => Err(AuthTxError::Unknown),
            Some((true, _)) => Err(AuthTxError::Replayed),
            Some((false, true)) => Err(AuthTxError::Expired),
            Some((false, false)) => {
                tx.execute(
                    "update auth_transactions set consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where state_hash = ?1",
                    params![hash],
                )?;
                Ok(())
            }
        };
        tx.commit()?;
        Ok(outcome)
    }
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const SELECT_PROFILE: &str =
    "select p.id, p.workspace_id, p.name, p.client_label, p.folder_label, p.notes, p.version,
       p.created_at, p.updated_at, pr.pid
     from profiles p left join processes pr on pr.profile_id = p.id";

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<LocalProfile, StoreError>> {
    let id: String = row.get(0)?;
    let ws: Option<String> = row.get(1)?;
    let Ok(id) = ProfileId::parse(&id) else {
        return Ok(Err(StoreError::Corrupt));
    };
    let workspace_id = match ws.map(|w| WorkspaceId::parse(&w)) {
        None => None,
        Some(Ok(w)) => Some(w),
        Some(Err(_)) => return Ok(Err(StoreError::Corrupt)),
    };
    Ok(Ok(LocalProfile {
        id,
        workspace_id,
        name: row.get(2)?,
        client_label: row.get(3)?,
        folder_label: row.get(4)?,
        notes: row.get(5)?,
        version: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        running_pid: row.get(9)?,
    }))
}

fn row_to_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Workspace, StoreError>> {
    let id: String = row.get(0)?;
    let Ok(id) = WorkspaceId::parse(&id) else {
        return Ok(Err(StoreError::Corrupt));
    };
    Ok(Ok(Workspace {
        id,
        name: row.get(1)?,
        kind: row.get(2)?,
        created_at: row.get(3)?,
    }))
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests;
