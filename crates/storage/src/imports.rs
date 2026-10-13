//! Configuration import jobs (milestone 04): persistent status for long imports and the data needed to detect
//! duplicates and to make a retry idempotent.

use crate::{LocalStore, StoreError};
use pb_runtime::{ClientId, ImportJobId, ProfileId, WorkspaceId};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportJob {
    pub id: ImportJobId,
    pub status: String,
    pub source_name: String,
    pub source_digest: String,
    pub format: String,
    pub settings: Value,
    pub total: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub skipped: u64,
    /// Row-specific errors (capped; the full list is recomputed by a new preview).
    pub errors: Value,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// Identity of an existing profile for duplicate detection: (id, name key, client, version).
pub type ProfileKey = (ProfileId, String, Option<ClientId>, i64);

const COLUMNS: &str =
    "id, status, source_name, source_digest, format, settings_json, total, succeeded, failed,
                       skipped, errors_json, created_at, started_at, finished_at";

fn row_to_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ImportJob, StoreError>> {
    let id: String = r.get(0)?;
    let settings: String = r.get(5)?;
    let errors: String = r.get(10)?;
    let n = |i: usize| -> rusqlite::Result<u64> { Ok(r.get::<_, i64>(i)?.max(0) as u64) };
    Ok((|| {
        Ok(ImportJob {
            id: ImportJobId::parse(&id).map_err(|_| StoreError::Corrupt)?,
            status: r.get(1)?,
            source_name: r.get(2)?,
            source_digest: r.get(3)?,
            format: r.get(4)?,
            settings: serde_json::from_str(&settings).map_err(|_| StoreError::Corrupt)?,
            total: n(6)?,
            succeeded: n(7)?,
            failed: n(8)?,
            skipped: n(9)?,
            errors: serde_json::from_str(&errors).map_err(|_| StoreError::Corrupt)?,
            created_at: r.get(11)?,
            started_at: r.get(12)?,
            finished_at: r.get(13)?,
        })
    })())
}

impl LocalStore {
    pub fn create_import_job(
        &self,
        workspace: &WorkspaceId,
        source_name: &str,
        source_digest: &str,
        format: &str,
        settings: &Value,
        total: u64,
    ) -> Result<ImportJob, StoreError> {
        let id = ImportJobId::generate().map_err(|_| StoreError::Corrupt)?;
        let name: String = source_name.chars().take(255).collect();
        self.w()?.execute(
            "insert into import_jobs (id, workspace_id, status, source_name, source_digest, format, settings_json, total)
             values (?1, ?2, 'previewed', ?3, ?4, ?5, ?6, ?7)",
            params![
                id.as_str(),
                workspace.as_str(),
                name,
                source_digest,
                format,
                settings.to_string(),
                total as i64
            ],
        )?;
        self.get_import_job(&id)?.ok_or(StoreError::Corrupt)
    }

    pub fn get_import_job(&self, id: &ImportJobId) -> Result<Option<ImportJob>, StoreError> {
        self.r()?
            .query_row(
                &format!("select {COLUMNS} from import_jobs where id = ?1"),
                [id.as_str()],
                row_to_job,
            )
            .optional()?
            .transpose()
    }

    pub fn list_import_jobs(&self, workspace: &WorkspaceId) -> Result<Vec<ImportJob>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "select {COLUMNS} from import_jobs where workspace_id = ?1 and status != 'previewed'
              order by created_at desc limit 50"
        ))?;
        let rows = stmt.query_map([workspace.as_str()], row_to_job)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    pub fn start_import_job(&self, id: &ImportJobId) -> Result<(), StoreError> {
        let n = self.w()?.execute(
            "update import_jobs set status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    succeeded = 0, failed = 0, skipped = 0
              where id = ?1 and status in ('previewed', 'cancelled', 'interrupted', 'failed', 'completed_with_errors')",
            [id.as_str()],
        )?;
        if n == 0 {
            return Err(StoreError::Invalid(
                "this import is already running or finished",
            ));
        }
        Ok(())
    }

    pub fn import_progress(
        &self,
        id: &ImportJobId,
        succeeded: u64,
        failed: u64,
        skipped: u64,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            "update import_jobs set succeeded = ?2, failed = ?3, skipped = ?4 where id = ?1",
            params![id.as_str(), succeeded as i64, failed as i64, skipped as i64],
        )?;
        Ok(())
    }

    pub fn finish_import_job(
        &self,
        id: &ImportJobId,
        status: &str,
        counts: (u64, u64, u64),
        errors: &Value,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            "update import_jobs set status = ?2, succeeded = ?3, failed = ?4, skipped = ?5, errors_json = ?6,
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              where id = ?1",
            params![
                id.as_str(),
                status,
                counts.0 as i64,
                counts.1 as i64,
                counts.2 as i64,
                errors.to_string()
            ],
        )?;
        Ok(())
    }

    /// Imports left `running` by a manager that stopped are marked `interrupted` (retry continues safely).
    pub fn mark_interrupted_imports(&self) -> Result<u64, StoreError> {
        Ok(self.w()?.execute(
            "update import_jobs set status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              where status = 'running'",
            [],
        )? as u64)
    }

    /// Existing profiles (not in the trash) for duplicate detection.
    pub fn profile_keys(&self, workspace: &WorkspaceId) -> Result<Vec<ProfileKey>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select p.id, p.search_text, p.client_id, p.version from profiles p
              where p.workspace_id = ?1
                and not exists (select 1 from trash_entries te where te.profile_id = p.id)
              limit 100000",
        )?;
        let rows = stmt.query_map([workspace.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        rows.map(|r| {
            let (id, key, client, version) = r?;
            Ok((
                ProfileId::parse(&id).map_err(|_| StoreError::Corrupt)?,
                key,
                client
                    .map(|c| ClientId::parse(&c).map_err(|_| StoreError::Corrupt))
                    .transpose()?,
                version,
            ))
        })
        .collect()
    }

    /// Which of these import references already created a profile.
    pub fn existing_import_refs(&self, refs: &[String]) -> Result<Vec<String>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached("select 1 from profiles where import_ref = ?1")?;
        let mut out = vec![];
        for r in refs {
            if stmt.query_row([r], |_| Ok(())).optional()?.is_some() {
                out.push(r.clone());
            }
        }
        Ok(out)
    }
}
