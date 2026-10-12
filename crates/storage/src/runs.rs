//! Process runs, profile run state and the local audit log (milestone 03).
//!
//! - `process_runs` keeps one row per browser launch: pid plus the OS start identity (start time and executable),
//!   so a reused pid is never mistaken for our browser. At most one active (unended) run per profile is enforced by
//!   a partial unique index.
//! - `audit_log` records launches, stops, crashes and recovery actions. It never stores URLs, page titles, cookie
//!   contents or passwords; `detail` is a short machine code.

use crate::{LocalStore, StoreError};
use pb_runtime::{ProfileId, RunState, random_hex};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartIdentity {
    /// OS process start time (seconds since the Unix epoch).
    pub start_time: Option<u64>,
    pub exe: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Clean,
    Crashed,
    EarlyExit,
    Forced,
    /// The manager died while the profile was starting/stopping and the browser is gone.
    Interrupted,
    /// The browser was gone when the manager came back and Chromium left no exit record.
    Lost,
}

impl RunOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Crashed => "crashed",
            Self::EarlyExit => "early_exit",
            Self::Forced => "forced",
            Self::Interrupted => "interrupted",
            Self::Lost => "lost",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessRun {
    pub run_id: String,
    pub profile_id: ProfileId,
    pub pid: u32,
    pub identity: StartIdentity,
    pub runtime_version: Option<String>,
    pub exit_code: Option<i64>,
    pub outcome: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuditEntry {
    pub seq: i64,
    pub at: String,
    pub profile_id: Option<String>,
    pub action: String,
    pub outcome: String,
    pub run_id: Option<String>,
    pub detail: Option<String>,
}

const AUDIT_KEEP: i64 = 5000;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn new_run_id() -> Result<String, StoreError> {
    Ok(format!(
        "run_{}",
        random_hex(12).map_err(|_| StoreError::Corrupt)?
    ))
}

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ProcessRun, StoreError>> {
    let id: String = r.get(1)?;
    let identity: String = r.get(3)?;
    let Ok(profile_id) = ProfileId::parse(&id) else {
        return Ok(Err(StoreError::Corrupt));
    };
    Ok(Ok(ProcessRun {
        run_id: r.get(0)?,
        profile_id,
        pid: r.get(2)?,
        identity: serde_json::from_str(&identity).unwrap_or_default(),
        runtime_version: r.get(4)?,
        exit_code: r.get(5)?,
        outcome: r.get(6)?,
        started_at: r.get(7)?,
        ended_at: r.get(8)?,
    }))
}

const SELECT_RUN: &str =
    "select run_id, profile_id, pid, start_identity, runtime_version, exit_code, outcome,
       started_at, ended_at from process_runs";

impl LocalStore {
    /// Records a new run and moves the profile to `state` (STARTING for a launch, RUNNING for an adoption).
    pub fn begin_run(
        &self,
        id: &ProfileId,
        pid: u32,
        identity: &StartIdentity,
        runtime_version: Option<&str>,
        state: RunState,
    ) -> Result<String, StoreError> {
        let run_id = new_run_id()?;
        let identity = serde_json::to_string(identity).map_err(|_| StoreError::Corrupt)?;
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        tx.execute(
            "insert into process_runs (run_id, profile_id, pid, start_identity, runtime_version)
             values (?1, ?2, ?3, ?4, ?5)",
            params![run_id, id.as_str(), pid, identity, runtime_version],
        )?;
        let n = tx.execute(
            &format!(
                "update profiles set state = ?2, last_started_at = {NOW}, last_error = null,
                   runtime_version = coalesce(?3, runtime_version) where id = ?1"
            ),
            params![id.as_str(), state.as_str(), runtime_version],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit()?;
        Ok(run_id)
    }

    /// Closes a run and sets the profile's resulting state. Clean exits reset the crash counter; crashes raise it.
    pub fn end_run(
        &self,
        run_id: &str,
        outcome: RunOutcome,
        exit_code: Option<i64>,
        state: RunState,
        last_error: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let profile: Option<String> = tx
            .query_row(
                "select profile_id from process_runs where run_id = ?1 and ended_at is null",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(profile) = profile else {
            return Ok(()); // already ended (idempotent)
        };
        tx.execute(
            &format!(
                "update process_runs set ended_at = {NOW}, outcome = ?2, exit_code = ?3 where run_id = ?1"
            ),
            params![run_id, outcome.as_str(), exit_code],
        )?;
        let crash = matches!(outcome, RunOutcome::Crashed | RunOutcome::EarlyExit);
        let clean = outcome == RunOutcome::Clean;
        tx.execute(
            &format!(
                "update profiles set state = ?2, last_error = ?3,
                   crash_count = case when ?4 then crash_count + 1 when ?5 then 0 else crash_count end,
                   last_clean_shutdown_at = case when ?5 then {NOW} else last_clean_shutdown_at end
                 where id = ?1"
            ),
            params![profile, state.as_str(), last_error, crash, clean],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Sets the profile's run state (and optionally its last error) without touching runs.
    pub fn set_run_state(
        &self,
        id: &ProfileId,
        state: RunState,
        last_error: Option<Option<&str>>,
    ) -> Result<(), StoreError> {
        let n = self.w()?.execute(
            "update profiles set state = ?2, last_error = case when ?3 then ?4 else last_error end where id = ?1",
            params![
                id.as_str(),
                state.as_str(),
                last_error.is_some(),
                last_error.flatten()
            ],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// After a successful recovery: STOPPED, no error, crash counter reset.
    pub fn clear_crash_state(&self, id: &ProfileId) -> Result<(), StoreError> {
        let n = self.w()?.execute(
            "update profiles set state = 'stopped', last_error = null, crash_count = 0 where id = ?1",
            params![id.as_str()],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn active_runs(&self) -> Result<Vec<ProcessRun>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT_RUN} where ended_at is null order by started_at limit 1000"
        ))?;
        let rows = stmt.query_map([], row_to_run)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    pub fn runs_for(&self, id: &ProfileId, limit: u32) -> Result<Vec<ProcessRun>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT_RUN} where profile_id = ?1 order by started_at desc, rowid desc limit ?2"
        ))?;
        let rows = stmt.query_map(params![id.as_str(), limit.clamp(1, 200)], row_to_run)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    /// Profiles whose stored state says a process may exist, for start-up reconciliation.
    pub fn profiles_in_states(
        &self,
        states: &[RunState],
    ) -> Result<Vec<(ProfileId, RunState)>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select id, state from profiles where state != 'stopped' limit 10000",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (id, state) = row?;
            let (Ok(id), Some(state)) = (ProfileId::parse(&id), RunState::parse(&state)) else {
                return Err(StoreError::Corrupt);
            };
            if states.contains(&state) {
                out.push((id, state));
            }
        }
        Ok(out)
    }

    pub fn record_backup(
        &self,
        id: &ProfileId,
        runtime_version: Option<&str>,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            &format!(
                "update profiles set last_backup_at = {NOW}, backup_runtime_version = ?2 where id = ?1"
            ),
            params![id.as_str(), runtime_version],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------ audit
    pub fn audit(
        &self,
        profile: Option<&ProfileId>,
        action: &str,
        outcome: &str,
        run_id: Option<&str>,
        detail: Option<&str>,
    ) -> Result<(), StoreError> {
        let conn = self.w()?;
        conn.execute(
            "insert into audit_log (profile_id, action, outcome, run_id, detail) values (?1, ?2, ?3, ?4, ?5)",
            params![profile.map(ProfileId::as_str), action, outcome, run_id, detail],
        )?;
        conn.execute(
            "delete from audit_log where seq <= (select max(seq) from audit_log) - ?1",
            params![AUDIT_KEEP],
        )?;
        Ok(())
    }

    pub fn list_audit(
        &self,
        profile: Option<&ProfileId>,
        limit: u32,
    ) -> Result<Vec<AuditEntry>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select seq, at, profile_id, action, outcome, run_id, detail from audit_log
             where (?1 is null or profile_id = ?1) order by seq desc limit ?2",
        )?;
        let rows = stmt.query_map(
            params![profile.map(ProfileId::as_str), limit.clamp(1, 1000)],
            |r| {
                Ok(AuditEntry {
                    seq: r.get(0)?,
                    at: r.get(1)?,
                    profile_id: r.get(2)?,
                    action: r.get(3)?,
                    outcome: r.get(4)?,
                    run_id: r.get(5)?,
                    detail: r.get(6)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
