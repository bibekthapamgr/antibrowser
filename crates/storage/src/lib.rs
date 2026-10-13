//! Local metadata store for the desktop manager (SQLite, WAL, foreign keys, single writer).
//!
//! Data ownership (milestone 01): device cache, local profile metadata, queued local-only changes and process
//! tracking. It is never consulted for authorization decisions; the server is authoritative.
//! Milestone 02 adds: workspaces, devices, allow-listed settings, runtime installations, timings and one-time
//! auth transactions for deep links.
//!
//! Concurrency: one writer connection behind a mutex plus a separate reader connection; WAL lets reads proceed
//! during writes. Every list query is bounded.

pub mod bulk;
pub mod catalog;
pub mod cloud;
pub mod imports;
pub mod migrations;
pub mod network;
pub mod query;
pub mod runs;
pub mod settings;
pub mod sync;
pub mod team;

use migrations::{MigrationFailure, SCHEMA_VERSION};
use pb_runtime::{
    ClientId, DeviceId, PermissionDefault, PrivacyConfig, ProfileId, ProxyId, RunState, TagId,
    TemplateId, WorkspaceId, random_hex,
};
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
    #[error("an entry with this name or reference already exists")]
    Duplicate,
    #[error("still used by {0} profile(s)")]
    InUse(u64),
    #[error("invalid value: {0}")]
    Invalid(&'static str),
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct TagRef {
    pub id: TagId,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalProfile {
    pub id: ProfileId,
    pub workspace_id: Option<WorkspaceId>,
    pub name: String,
    pub client_id: Option<ClientId>,
    pub client_name: Option<String>,
    /// The client's colour, `#rrggbb`.
    pub client_colour: Option<String>,
    pub tags: Vec<TagRef>,
    pub notes: String,
    pub favourite: bool,
    pub archived_at: Option<String>,
    /// Set while the profile is in the trash.
    pub trashed_at: Option<String>,
    pub purge_after: Option<String>,
    pub template_id: Option<TemplateId>,
    /// Name of the assigned proxy (milestone 05).
    pub proxy_label: Option<String>,
    pub proxy_id: Option<ProxyId>,
    /// With a proxy: block traffic (incl. UDP/WebRTC) that cannot go through it. On by default.
    pub fail_closed: bool,
    /// Bumped whenever routing settings change (a running profile shows "restart to apply").
    pub network_config_version: i64,
    pub privacy: PrivacyConfig,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub running_pid: Option<u32>,
    pub active_run_id: Option<String>,
    pub start_urls: Vec<String>,
    pub download_dir: Option<String>,
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
    /// Browser version that last ran this profile (forward upgrades only).
    pub runtime_version: Option<String>,
    /// Profile directory relative to the profiles root; must equal the id (verified on use).
    pub data_dir_ref: String,
    pub state: RunState,
    pub last_started_at: Option<String>,
    pub last_clean_shutdown_at: Option<String>,
    pub schema_version: i64,
    pub crash_count: u32,
    pub last_error: Option<String>,
    pub last_backup_at: Option<String>,
    pub backup_runtime_version: Option<String>,
}

/// A profile to create. Browser storage always starts empty: only configuration is ever copied.
#[derive(Clone, Debug)]
pub struct NewProfile {
    pub id: ProfileId,
    pub workspace_id: Option<WorkspaceId>,
    pub name: String,
    pub client_id: Option<ClientId>,
    pub notes: String,
    pub start_urls: Vec<String>,
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
    pub tags: Vec<TagId>,
    pub favourite: bool,
    pub template_id: Option<TemplateId>,
    /// Stable reference of the import row that created this profile (makes an import retry idempotent).
    pub import_ref: Option<String>,
    pub privacy: PrivacyConfig,
    /// (proxy, fail-closed); `None` = no routing settings yet (no proxy, fail-closed on).
    pub network: Option<(Option<ProxyId>, bool)>,
}

impl NewProfile {
    pub fn basic(
        id: ProfileId,
        workspace_id: Option<WorkspaceId>,
        name: &str,
        client_id: Option<ClientId>,
    ) -> Self {
        Self {
            id,
            workspace_id,
            name: name.to_owned(),
            client_id,
            notes: String::new(),
            start_urls: vec![],
            camera: PermissionDefault::Ask,
            microphone: PermissionDefault::Ask,
            location: PermissionDefault::Ask,
            tags: vec![],
            favourite: false,
            template_id: None,
            import_ref: None,
            privacy: PrivacyConfig::default(),
            network: None,
        }
    }
}

/// Fields to change; `None` leaves a field unchanged. `client_id: Some(None)` removes the client.
#[derive(Default)]
pub struct ProfileUpdate<'a> {
    pub name: Option<&'a str>,
    pub client_id: Option<Option<&'a ClientId>>,
    pub notes: Option<&'a str>,
    pub start_urls: Option<&'a [String]>,
    pub download_dir: Option<Option<&'a str>>,
    pub camera: Option<PermissionDefault>,
    pub microphone: Option<PermissionDefault>,
    pub location: Option<PermissionDefault>,
    pub favourite: Option<bool>,
    /// Replaces the profile's tags.
    pub tags: Option<&'a [TagId]>,
    /// (proxy, fail-closed): replaces the routing settings and bumps their config version.
    pub network: Option<(Option<&'a ProxyId>, bool)>,
    pub privacy: Option<&'a PrivacyConfig>,
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
    pub distribution: Option<String>,
    /// Executable path relative to `path`.
    pub executable: Option<String>,
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
    pub fn insert_profile(&self, p: NewProfile) -> Result<LocalProfile, StoreError> {
        let id = p.id.clone();
        let inserted = self.insert_profiles(std::slice::from_ref(&p))?;
        if inserted.first() != Some(&true) {
            return Err(StoreError::Duplicate);
        }
        self.get_profile(&id)?.ok_or(StoreError::Corrupt)
    }

    /// Inserts profiles in one transaction. Returns, per row, whether it was inserted: a row whose `import_ref`
    /// already exists is skipped (an import retry never duplicates completed rows).
    pub fn insert_profiles(&self, rows: &[NewProfile]) -> Result<Vec<bool>, StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let mut out = Vec::with_capacity(rows.len());
        {
            let mut insert = tx.prepare_cached(
                "insert into profiles (id, workspace_id, name, search_text, data_dir_ref, client_id, notes, start_urls,
                                       perm_camera, perm_microphone, perm_location, favourite, template_id, import_ref,
                                       privacy_json)
                 values (?1, ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 on conflict (import_ref) where import_ref is not null do nothing",
            )?;
            let mut tag = tx.prepare_cached(
                "insert or ignore into profile_tags (profile_id, tag_id) values (?1, ?2)",
            )?;
            for p in rows {
                let urls = serde_json::to_string(&p.start_urls).map_err(|_| StoreError::Corrupt)?;
                let n = insert.execute(params![
                    p.id.as_str(),
                    p.workspace_id.as_ref().map(WorkspaceId::as_str),
                    p.name,
                    migrations::name_key(&p.name),
                    p.client_id.as_ref().map(ClientId::as_str),
                    p.notes,
                    urls,
                    p.camera.as_str(),
                    p.microphone.as_str(),
                    p.location.as_str(),
                    p.favourite,
                    p.template_id.as_ref().map(TemplateId::as_str),
                    p.import_ref,
                    serde_json::to_string(&p.privacy).map_err(|_| StoreError::Corrupt)?,
                ])?;
                if n == 1 {
                    for t in &p.tags {
                        tag.execute(params![p.id.as_str(), t.as_str()])?;
                    }
                    if let Some((proxy, fail_closed)) = &p.network {
                        network::upsert_settings(&tx, &p.id, proxy.as_ref(), *fail_closed)?;
                    }
                }
                out.push(n == 1);
            }
        }
        tx.commit()?;
        Ok(out)
    }

    pub fn get_profile(&self, id: &ProfileId) -> Result<Option<LocalProfile>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!("{SELECT_PROFILE} where p.id = ?1"))?;
        stmt.query_row(params![id.as_str()], row_to_profile)
            .optional()?
            .transpose()
    }

    /// Bounded search over active (not archived, not trashed) profiles by name, client and tag. `limit` is clamped
    /// to 1..=[`MAX_LIST`]. The profile table uses [`LocalStore::query_profiles`].
    pub fn search_profiles(
        &self,
        workspace: Option<&WorkspaceId>,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LocalProfile>, StoreError> {
        let filter = query::ProfileFilter {
            workspace: workspace.cloned(),
            text: query.map(str::to_owned),
            ..Default::default()
        };
        Ok(self
            .query_profiles(&filter, query::Sort::default(), 0, limit.clamp(1, MAX_LIST))?
            .rows)
    }

    pub fn update_profile(
        &self,
        id: &ProfileId,
        changes: ProfileUpdate<'_>,
        expected_version: i64,
    ) -> Result<LocalProfile, StoreError> {
        let start_urls = changes
            .start_urls
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?;
        let privacy = changes
            .privacy
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?;
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "update profiles set
               name = coalesce(?3, name),
               search_text = coalesce(?4, search_text),
               client_id = case when ?5 then ?6 else client_id end,
               notes = coalesce(?7, notes),
               start_urls = coalesce(?8, start_urls),
               download_dir = case when ?9 then ?10 else download_dir end,
               perm_camera = coalesce(?11, perm_camera),
               perm_microphone = coalesce(?12, perm_microphone),
               perm_location = coalesce(?13, perm_location),
               favourite = coalesce(?14, favourite),
               privacy_json = coalesce(?15, privacy_json),
               version = version + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             where id = ?1 and version = ?2",
            params![
                id.as_str(),
                expected_version,
                changes.name,
                changes.name.map(migrations::name_key),
                changes.client_id.is_some(),
                changes.client_id.flatten().map(ClientId::as_str),
                changes.notes,
                start_urls,
                changes.download_dir.is_some(),
                changes.download_dir.flatten(),
                changes.camera.map(PermissionDefault::as_str),
                changes.microphone.map(PermissionDefault::as_str),
                changes.location.map(PermissionDefault::as_str),
                changes.favourite,
                privacy,
            ],
        )?;
        if updated == 0 {
            drop(tx);
            drop(conn);
            return match self.get_profile(id)? {
                Some(p) => Err(StoreError::VersionConflict { current: p.version }),
                None => Err(StoreError::NotFound),
            };
        }
        if let Some((proxy, fail_closed)) = changes.network {
            network::upsert_settings(&tx, id, proxy, fail_closed)?;
        }
        if let Some(tags) = changes.tags {
            tx.execute(
                "delete from profile_tags where profile_id = ?1",
                params![id.as_str()],
            )?;
            let mut stmt = tx.prepare_cached(
                "insert or ignore into profile_tags (profile_id, tag_id) values (?1, ?2)",
            )?;
            for t in tags {
                stmt.execute(params![id.as_str(), t.as_str()])?;
            }
        }
        tx.commit()?;
        drop(conn);
        self.get_profile(id)?.ok_or(StoreError::Corrupt)
    }

    /// Profiles that are not in the trash (`workspace` = None: all workspaces).
    pub fn profile_count(&self, workspace: Option<&WorkspaceId>) -> Result<u64, StoreError> {
        Ok(self.r()?.query_row(
            "select count(*) from profiles p
              where (?1 is null or p.workspace_id = ?1)
                and not exists (select 1 from trash_entries te where te.profile_id = p.id)",
            params![workspace.map(WorkspaceId::as_str)],
            |r| r.get::<_, i64>(0),
        )? as u64)
    }

    /// Removes a profile's metadata (runs, tags and trash entry cascade). The caller has already made sure no
    /// process uses the profile directory and has moved the directory aside.
    pub fn delete_profile_metadata(&self, id: &ProfileId) -> Result<bool, StoreError> {
        Ok(self
            .w()?
            .execute("delete from profiles where id = ?1", params![id.as_str()])?
            == 1)
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
            "insert into runtime_installations (version, platform, digest, verified_at, path, status, distribution, executable)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             on conflict (version, platform) do update set digest = excluded.digest, verified_at = excluded.verified_at,
               path = excluded.path, status = excluded.status, distribution = excluded.distribution,
               executable = excluded.executable, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![r.version, r.platform, r.digest, r.verified_at, r.path, r.status, r.distribution, r.executable],
        )?;
        Ok(())
    }

    pub fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select version, platform, digest, verified_at, path, status, distribution, executable
             from runtime_installations order by updated_at desc limit 50",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RuntimeInstallation {
                version: r.get(0)?,
                platform: r.get(1)?,
                digest: r.get(2)?,
                verified_at: r.get(3)?,
                path: r.get(4)?,
                status: r.get(5)?,
                distribution: r.get(6)?,
                executable: r.get(7)?,
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

pub(crate) const SELECT_PROFILE: &str =
    "select p.id, p.workspace_id, p.name, p.client_id, c.name, c.colour, p.notes, p.version,
       p.created_at, p.updated_at, r.pid, r.run_id,
       p.start_urls, p.download_dir, p.perm_camera, p.perm_microphone, p.perm_location,
       p.runtime_version, p.data_dir_ref, p.state, p.last_started_at, p.last_clean_shutdown_at, p.schema_version,
       p.crash_count, p.last_error, p.last_backup_at, p.backup_runtime_version,
       p.favourite, p.archived_at, te.trashed_at, te.purge_after, p.template_id, px.name,
       (select json_group_array(json_array(t.id, t.name)) from profile_tags pt join tags t on t.id = pt.tag_id
          where pt.profile_id = p.id) as tags,
       ns.proxy_id, coalesce(ns.fail_closed, 1), p.privacy_json, coalesce(ns.config_version, 0)
     from profiles p
     left join clients_local c on c.id = p.client_id
     left join trash_entries te on te.profile_id = p.id
     left join profile_network_settings ns on ns.profile_id = p.id
     left join proxy_configs px on px.id = ns.proxy_id
     left join process_runs r on r.profile_id = p.id and r.ended_at is null";

pub(crate) fn row_to_profile(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<LocalProfile, StoreError>> {
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
    let client_id = match row
        .get::<_, Option<String>>(3)?
        .map(|c| ClientId::parse(&c))
    {
        None => None,
        Some(Ok(c)) => Some(c),
        Some(Err(_)) => return Ok(Err(StoreError::Corrupt)),
    };
    let template_id = match row
        .get::<_, Option<String>>(31)?
        .map(|t| TemplateId::parse(&t))
    {
        None => None,
        Some(Ok(t)) => Some(t),
        Some(Err(_)) => return Ok(Err(StoreError::Corrupt)),
    };
    let perm = |i: usize| -> rusqlite::Result<Option<PermissionDefault>> {
        Ok(PermissionDefault::parse(&row.get::<_, String>(i)?))
    };
    let (Some(camera), Some(microphone), Some(location)) = (perm(14)?, perm(15)?, perm(16)?) else {
        return Ok(Err(StoreError::Corrupt));
    };
    let Some(state) = RunState::parse(&row.get::<_, String>(19)?) else {
        return Ok(Err(StoreError::Corrupt));
    };
    let Ok(start_urls) = serde_json::from_str::<Vec<String>>(&row.get::<_, String>(12)?) else {
        return Ok(Err(StoreError::Corrupt));
    };
    let tags_json: Option<String> = row.get(33)?;
    let Ok(raw_tags) =
        serde_json::from_str::<Vec<(String, String)>>(tags_json.as_deref().unwrap_or("[]"))
    else {
        return Ok(Err(StoreError::Corrupt));
    };
    let mut tags = Vec::with_capacity(raw_tags.len());
    for (tid, name) in raw_tags {
        let Ok(tid) = TagId::parse(&tid) else {
            return Ok(Err(StoreError::Corrupt));
        };
        tags.push(TagRef { id: tid, name });
    }
    tags.sort_by_key(|t| migrations::name_key(&t.name));
    let data_dir_ref: Option<String> = row.get(18)?;
    let proxy_id = match row
        .get::<_, Option<String>>(34)?
        .map(|t| ProxyId::parse(&t))
    {
        None => None,
        Some(Ok(t)) => Some(t),
        Some(Err(_)) => return Ok(Err(StoreError::Corrupt)),
    };
    let Ok(privacy) = serde_json::from_str::<PrivacyConfig>(&row.get::<_, String>(36)?) else {
        return Ok(Err(StoreError::Corrupt));
    };
    Ok(Ok(LocalProfile {
        data_dir_ref: data_dir_ref.unwrap_or_else(|| id.to_string()),
        id,
        workspace_id,
        name: row.get(2)?,
        client_id,
        client_name: row.get(4)?,
        client_colour: row.get(5)?,
        tags,
        notes: row.get(6)?,
        favourite: row.get::<_, i64>(27)? == 1,
        archived_at: row.get(28)?,
        trashed_at: row.get(29)?,
        purge_after: row.get(30)?,
        template_id,
        proxy_label: row.get(32)?,
        proxy_id,
        fail_closed: row.get::<_, i64>(35)? == 1,
        network_config_version: row.get(37)?,
        privacy,
        version: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        running_pid: row.get(10)?,
        active_run_id: row.get(11)?,
        start_urls,
        download_dir: row.get(13)?,
        camera,
        microphone,
        location,
        runtime_version: row.get(17)?,
        state,
        last_started_at: row.get(20)?,
        last_clean_shutdown_at: row.get(21)?,
        schema_version: row.get(22)?,
        crash_count: row.get::<_, i64>(23)?.max(0) as u32,
        last_error: row.get(24)?,
        last_backup_at: row.get(25)?,
        backup_runtime_version: row.get(26)?,
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

pub(crate) fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_m04;
#[cfg(test)]
mod tests_m05;
