//! Automation on this computer (milestone 10, ADR-0017): which organizations it runs jobs for, and a short record of
//! the jobs it ran (the server keeps the authoritative job; this record is for the person at this computer).

use crate::{LocalStore, StoreError};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/// Runs kept on this computer.
const KEEP_RUNS: i64 = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Enrollment {
    pub org_id: String,
    pub agent_id: String,
    pub accepts: String,
    pub max_jobs: u32,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AutomationRun {
    pub job_id: String,
    pub org_id: String,
    pub org_profile_id: String,
    pub profile_id: Option<String>,
    pub label: Option<String>,
    pub attempt: u32,
    /// Session leases this job took on this computer (a reopen after a released lease uses a new lease key).
    pub opens: u32,
    /// opening, running, holding, closing, done
    pub state: String,
    pub outcome: Option<String>,
    pub error_code: Option<String>,
    pub steps_total: u32,
    pub steps_done: u32,
    pub debug_endpoint: Option<String>,
    pub started_at: String,
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

impl LocalStore {
    pub fn automation_enrollments(&self) -> Result<Vec<Enrollment>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select org_id, agent_id, accepts, max_jobs, created_at from automation_enrollments order by created_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Enrollment {
                    org_id: r.get(0)?,
                    agent_id: r.get(1)?,
                    accepts: r.get(2)?,
                    max_jobs: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn automation_enrollment(&self, org: &str) -> Result<Option<Enrollment>, StoreError> {
        Ok(self
            .automation_enrollments()?
            .into_iter()
            .find(|e| e.org_id == org))
    }

    pub fn set_automation_enrollment(
        &self,
        org: &str,
        agent: &str,
        accepts: &str,
        max_jobs: u32,
    ) -> Result<(), StoreError> {
        if !ok_id("org", org) || !ok_id("agt", agent) || !matches!(accepts, "mine" | "org") {
            return Err(StoreError::Invalid("automation enrollment"));
        }
        self.w()?.execute(
            "insert into automation_enrollments (org_id, agent_id, accepts, max_jobs) values (?1, ?2, ?3, ?4)
             on conflict (org_id) do update set agent_id = excluded.agent_id, accepts = excluded.accepts,
                                                 max_jobs = excluded.max_jobs",
            params![org, agent, accepts, max_jobs.clamp(1, 10)],
        )?;
        Ok(())
    }

    pub fn remove_automation_enrollment(&self, org: &str) -> Result<(), StoreError> {
        self.w()?.execute(
            "delete from automation_enrollments where org_id = ?1",
            params![org],
        )?;
        Ok(())
    }

    /// Records (or updates) a job this computer works on.
    pub fn save_automation_run(&self, run: &AutomationRun) -> Result<(), StoreError> {
        if !ok_id("job", &run.job_id)
            || !ok_id("org", &run.org_id)
            || !ok_id("prf", &run.org_profile_id)
        {
            return Err(StoreError::Invalid("automation run"));
        }
        let conn = self.w()?;
        conn.execute(
            &format!(
                "insert into automation_runs (job_id, org_id, org_profile_id, profile_id, label, attempt, state, outcome,
                                              error_code, steps_total, steps_done, debug_endpoint, opens)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 on conflict (job_id) do update set
                   profile_id = excluded.profile_id, label = excluded.label, attempt = excluded.attempt,
                   opens = excluded.opens, state = excluded.state, outcome = excluded.outcome, error_code = excluded.error_code,
                   steps_total = excluded.steps_total, steps_done = excluded.steps_done,
                   debug_endpoint = excluded.debug_endpoint, updated_at = {NOW}"
            ),
            params![
                run.job_id,
                run.org_id,
                run.org_profile_id,
                run.profile_id,
                run.label.as_deref().map(|l| l.chars().take(120).collect::<String>()),
                run.attempt,
                run.state,
                run.outcome,
                run.error_code,
                run.steps_total,
                run.steps_done,
                run.debug_endpoint,
                run.opens.min(1000),
            ],
        )?;
        conn.execute(
            "delete from automation_runs where job_id in (
               select job_id from automation_runs order by updated_at desc limit -1 offset ?1)",
            params![KEEP_RUNS],
        )?;
        Ok(())
    }

    pub fn automation_runs(&self, limit: u32) -> Result<Vec<AutomationRun>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select job_id, org_id, org_profile_id, profile_id, label, attempt, state, outcome, error_code,
                    steps_total, steps_done, debug_endpoint, started_at, updated_at, opens
               from automation_runs order by updated_at desc, job_id desc limit ?1",
        )?;
        let rows = stmt
            .query_map(params![limit.min(500)], row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn automation_run(&self, job: &str) -> Result<Option<AutomationRun>, StoreError> {
        let conn = self.r()?;
        Ok(conn
            .query_row(
                "select job_id, org_id, org_profile_id, profile_id, label, attempt, state, outcome, error_code,
                        steps_total, steps_done, debug_endpoint, started_at, updated_at, opens
                   from automation_runs where job_id = ?1",
                params![job],
                row,
            )
            .optional()?)
    }
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        job_id: r.get(0)?,
        org_id: r.get(1)?,
        org_profile_id: r.get(2)?,
        profile_id: r.get(3)?,
        label: r.get(4)?,
        attempt: r.get(5)?,
        state: r.get(6)?,
        outcome: r.get(7)?,
        error_code: r.get(8)?,
        steps_total: r.get(9)?,
        steps_done: r.get(10)?,
        debug_endpoint: r.get(11)?,
        started_at: r.get(12)?,
        updated_at: r.get(13)?,
        opens: r.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let s = LocalStore::open(&tmp.path().join("local.db")).unwrap_or_else(|e| panic!("{e:?}"));
        (tmp, s)
    }

    #[test]
    fn enrollments_and_runs_round_trip_and_stay_bounded() {
        let (_tmp, s) = store();
        let org = "org_01J9ZSEED0ACME000000000000";
        let agent = "agt_01J9ZSEED0000000000000AGT1";
        s.set_automation_enrollment(org, agent, "mine", 2)
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert!(
            s.set_automation_enrollment("org_bad", agent, "mine", 1)
                .is_err()
        );
        assert!(
            s.set_automation_enrollment(org, agent, "everyone", 1)
                .is_err()
        );
        let e = s
            .automation_enrollment(org)
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(
            e.map(|e| (e.agent_id, e.max_jobs)),
            Some((agent.to_owned(), 2))
        );
        for i in 0..205u32 {
            let run = AutomationRun {
                job_id: format!("job_01J9ZSEED000000000000{i:05}"),
                org_id: org.into(),
                org_profile_id: "prf_01J9ZSEED0000000000000PRF1".into(),
                profile_id: None,
                label: Some("Smoke".into()),
                attempt: 1,
                opens: 1,
                state: "done".into(),
                outcome: Some("SUCCEEDED".into()),
                error_code: None,
                steps_total: 3,
                steps_done: 3,
                debug_endpoint: None,
                started_at: String::new(),
                updated_at: String::new(),
            };
            s.save_automation_run(&run)
                .unwrap_or_else(|e| panic!("{e:?}"));
        }
        assert_eq!(s.automation_runs(500).map(|r| r.len()).unwrap_or(0), 200);
        s.remove_automation_enrollment(org)
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert!(s.automation_enrollments().unwrap_or_default().is_empty());
    }
}
