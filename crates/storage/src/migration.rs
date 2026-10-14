//! R1 (ADR-0020): this device's migration runs toward the unified workspace model. A run is identified by the
//! digest of its manifest (the inventory it was planned from); the same manifest is the same run, so planning or
//! running it again resumes or returns it instead of starting over. The profile identity map itself is
//! `org_profile_links` (milestone 07): nothing here duplicates it.

use crate::{LocalStore, StoreError};
use pb_runtime::WorkspaceId;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
pub const STATES: &[&str] = &["planned", "running", "completed", "failed", "rolled_back"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationRun {
    pub id: String,
    pub org_id: String,
    pub workspace_id: WorkspaceId,
    pub manifest_digest: String,
    pub state: String,
    /// Where to resume: `{"step": "adopt", "batch": 3}` (device-defined).
    pub checkpoint: serde_json::Value,
    /// Counts only; never names, cookies or secrets.
    pub counts: serde_json::Value,
    pub error_code: Option<String>,
    pub server_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn ok_id(prefix: &str, s: &str) -> bool {
    s.len() == prefix.len() + 27
        && s.starts_with(prefix)
        && s.as_bytes()[prefix.len()] == b'_'
        && s.as_bytes()[prefix.len() + 1..]
            .iter()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(b))
}

const COLUMNS: &str =
    "id, org_id, workspace_id, manifest_digest, state, checkpoint_json, counts_json, error_code,
    server_run_id, created_at, updated_at";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MigrationRun> {
    let ws: String = r.get(2)?;
    let checkpoint: String = r.get(5)?;
    let counts: String = r.get(6)?;
    Ok(MigrationRun {
        id: r.get(0)?,
        org_id: r.get(1)?,
        workspace_id: WorkspaceId::parse(&ws).map_err(|_| rusqlite::Error::InvalidQuery)?,
        manifest_digest: r.get(3)?,
        state: r.get(4)?,
        checkpoint: serde_json::from_str(&checkpoint).unwrap_or(serde_json::Value::Null),
        counts: serde_json::from_str(&counts).unwrap_or(serde_json::Value::Null),
        error_code: r.get(7)?,
        server_run_id: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

impl LocalStore {
    /// The run for this manifest, if any.
    pub fn migration_run_by_digest(
        &self,
        digest: &str,
    ) -> Result<Option<MigrationRun>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                &format!("select {COLUMNS} from migration_runs where manifest_digest = ?1"),
                [digest],
                row,
            )
            .optional()?)
    }

    pub fn migration_run(&self, id: &str) -> Result<Option<MigrationRun>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                &format!("select {COLUMNS} from migration_runs where id = ?1"),
                [id],
                row,
            )
            .optional()?)
    }

    /// Runs of an organization (or all), newest first.
    pub fn migration_runs(&self, org_id: Option<&str>) -> Result<Vec<MigrationRun>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare(&format!(
            "select {COLUMNS} from migration_runs where ?1 is null or org_id = ?1 order by updated_at desc limit 100"
        ))?;
        let rows = stmt
            .query_map([org_id], row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Creates a planned run for a manifest, or returns the existing run for it unchanged.
    pub fn migration_run_plan(
        &self,
        id: &str,
        org_id: &str,
        workspace: &WorkspaceId,
        digest: &str,
        counts: &serde_json::Value,
    ) -> Result<MigrationRun, StoreError> {
        if !ok_id("mgr", id) || !ok_id("org", org_id) || digest.len() != 64 {
            return Err(StoreError::Invalid("migration run"));
        }
        if let Some(existing) = self.migration_run_by_digest(digest)? {
            return Ok(existing);
        }
        self.w()?.execute(
            "insert into migration_runs (id, org_id, workspace_id, manifest_digest, state, counts_json)
             values (?1, ?2, ?3, ?4, 'planned', ?5)",
            params![id, org_id, workspace.as_str(), digest, counts.to_string()],
        )?;
        self.migration_run(id)?
            .ok_or(StoreError::Invalid("migration run"))
    }

    /// Advances a run: state, checkpoint and counts. A completed run is final.
    pub fn migration_run_update(
        &self,
        id: &str,
        state: &str,
        checkpoint: Option<&serde_json::Value>,
        counts: Option<&serde_json::Value>,
        error_code: Option<&str>,
        server_run_id: Option<&str>,
    ) -> Result<MigrationRun, StoreError> {
        if !STATES.contains(&state) {
            return Err(StoreError::Invalid("migration state"));
        }
        let changed = self.w()?.execute(
            &format!(
                "update migration_runs set state = ?2, checkpoint_json = coalesce(?3, checkpoint_json),
                   counts_json = coalesce(?4, counts_json), error_code = ?5,
                   server_run_id = coalesce(?6, server_run_id), updated_at = {NOW}
                 where id = ?1 and state <> 'completed'"
            ),
            params![
                id,
                state,
                checkpoint.map(ToString::to_string),
                counts.map(ToString::to_string),
                error_code,
                server_run_id
            ],
        )?;
        let run = self
            .migration_run(id)?
            .ok_or(StoreError::Invalid("migration run"))?;
        if changed == 0
            && run.state == "completed"
            && state != "completed"
            && state != "rolled_back"
        {
            return Ok(run);
        }
        if changed == 0 && state == "rolled_back" {
            // A completed run may be rolled back (the UI switch); its mapping stays.
            self.w()?.execute(
                &format!("update migration_runs set state = 'rolled_back', updated_at = {NOW} where id = ?1"),
                [id],
            )?;
            return self
                .migration_run(id)?
                .ok_or(StoreError::Invalid("migration run"));
        }
        Ok(run)
    }
}
