//! Shared sessions of organization profiles on this device (milestone 08, ADR-0015).
//!
//! One row per local profile while this device holds (or held and must settle) the profile's session lease: the
//! lease id and fencing token (not secrets: they only work with this device's signed-in session), the phase, the
//! upload that closes the session, the handoff note being left and the one received, and where the copy of a lost
//! session was kept aside. The row goes away once the lease is released.

use crate::{LocalStore, StoreError};
use pb_runtime::ProfileId;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

/// Phases of a shared session on this device.
pub const TEAM_PHASES: &[&str] = &[
    // lease taken; restoring the newest backup and starting the browser
    "opening",
    // the browser runs; heartbeats every 15 s
    "running",
    // the browser is closing (user, request, lost connection)
    "closing",
    // closed; the closing backup uploads under the session's lease, then the lease is released
    "handing_off",
    // the handoff waits for a decision (upload keeps failing, a conflict, or the browser crashed); still leased
    "pending",
    // the connection was lost: the browser was closed before the lease ran out; reconnects by itself
    "lost",
    // an admin took the profile over: this copy was kept aside (and offered as a recovery copy)
    "taken_over",
    // access was removed: the profile was closed, this copy was kept aside
    "revoked",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TeamSession {
    pub local_profile_id: ProfileId,
    pub org_id: String,
    pub org_profile_id: String,
    pub lease_id: Option<String>,
    pub fencing_token: Option<String>,
    /// Idempotency key of the open request (a retried open after a lost answer returns the same lease).
    pub open_key: String,
    pub phase: String,
    pub operation_id: Option<String>,
    pub upload_job_id: Option<String>,
    /// The note this person leaves for the next one (sent with the release).
    pub handoff_note: Option<String>,
    /// The previous holder's note (JSON), shown when the profile opens here.
    pub received_note: Option<String>,
    pub error_code: Option<String>,
    /// Evidence folder name of a copy kept aside (taken over, revoked, unsynced before a restore).
    pub quarantine: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

const COLUMNS: &str = "local_profile_id, org_id, org_profile_id, lease_id, fencing_token, open_key, phase,
  operation_id, upload_job_id, handoff_note, received_note, error_code, quarantine, started_at, updated_at";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TeamSession> {
    let id: String = r.get(0)?;
    let local_profile_id = ProfileId::parse(&id).map_err(|_| {
        rusqlite::Error::InvalidColumnType(
            0,
            "local_profile_id".into(),
            rusqlite::types::Type::Text,
        )
    })?;
    Ok(TeamSession {
        local_profile_id,
        org_id: r.get(1)?,
        org_profile_id: r.get(2)?,
        lease_id: r.get(3)?,
        fencing_token: r.get(4)?,
        open_key: r.get(5)?,
        phase: r.get(6)?,
        operation_id: r.get(7)?,
        upload_job_id: r.get(8)?,
        handoff_note: r.get(9)?,
        received_note: r.get(10)?,
        error_code: r.get(11)?,
        quarantine: r.get(12)?,
        started_at: r.get(13)?,
        updated_at: r.get(14)?,
    })
}

impl LocalStore {
    pub fn team_session(&self, local: &ProfileId) -> Result<Option<TeamSession>, StoreError> {
        self.r()?
            .query_row(
                &format!("select {COLUMNS} from team_sessions where local_profile_id = ?1"),
                params![local.as_str()],
                row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn team_sessions(&self) -> Result<Vec<TeamSession>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare(&format!(
            "select {COLUMNS} from team_sessions order by started_at, local_profile_id limit 1000"
        ))?;
        Ok(stmt.query_map([], row)?.collect::<Result<Vec<_>, _>>()?)
    }

    /// Inserts or replaces the session of `s.local_profile_id`.
    pub fn put_team_session(&self, s: &TeamSession) -> Result<(), StoreError> {
        if !TEAM_PHASES.contains(&s.phase.as_str()) {
            return Err(StoreError::Invalid("phase"));
        }
        self.w()?.execute(
            "insert into team_sessions (local_profile_id, org_id, org_profile_id, lease_id, fencing_token, open_key,
                                        phase, operation_id, upload_job_id, handoff_note, received_note, error_code,
                                        quarantine)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             on conflict (local_profile_id) do update set
               org_id = excluded.org_id, org_profile_id = excluded.org_profile_id, lease_id = excluded.lease_id,
               fencing_token = excluded.fencing_token, open_key = excluded.open_key, phase = excluded.phase,
               operation_id = excluded.operation_id, upload_job_id = excluded.upload_job_id,
               handoff_note = excluded.handoff_note, received_note = excluded.received_note,
               error_code = excluded.error_code, quarantine = excluded.quarantine,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![
                s.local_profile_id.as_str(),
                s.org_id,
                s.org_profile_id,
                s.lease_id,
                s.fencing_token,
                s.open_key,
                s.phase,
                s.operation_id,
                s.upload_job_id,
                s.handoff_note,
                s.received_note,
                s.error_code,
                s.quarantine,
            ],
        )?;
        Ok(())
    }

    pub fn delete_team_session(&self, local: &ProfileId) -> Result<bool, StoreError> {
        Ok(self.w()?.execute(
            "delete from team_sessions where local_profile_id = ?1",
            params![local.as_str()],
        )? == 1)
    }

    /// What the signed-in person may do with a linked profile (from the server: launch, edit, backup_download).
    pub fn set_link_capabilities(
        &self,
        local: &ProfileId,
        capabilities: &[String],
    ) -> Result<(), StoreError> {
        let json = serde_json::to_string(capabilities).map_err(|_| StoreError::Invalid("json"))?;
        self.w()?.execute(
            "update org_profile_links set capabilities = ?2 where local_profile_id = ?1",
            params![local.as_str(), json],
        )?;
        Ok(())
    }

    /// `None` when not linked or not known yet.
    pub fn link_capabilities(&self, local: &ProfileId) -> Result<Option<Vec<String>>, StoreError> {
        let raw: Option<Option<String>> = self
            .r()?
            .query_row(
                "select capabilities from org_profile_links where local_profile_id = ?1",
                params![local.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw
            .flatten()
            .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore, ProfileId) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = LocalStore::open(&dir.path().join("t.db")).unwrap_or_else(|e| panic!("{e:?}"));
        let id = ProfileId::generate().unwrap_or_else(|e| panic!("{e}"));
        store
            .insert_profile(crate::NewProfile::basic(id.clone(), None, "Shared", None))
            .unwrap_or_else(|e| panic!("{e}"));
        (dir, store, id)
    }

    fn session(id: &ProfileId, phase: &str) -> TeamSession {
        TeamSession {
            local_profile_id: id.clone(),
            org_id: "org_01J9ZSEED0ACME000000000000".into(),
            org_profile_id: "prf_01J9ZSEED0A010000000000000".into(),
            lease_id: Some("lse_01J9ZSEED0L000000000000000".into()),
            fencing_token: Some("123".into()),
            open_key: "open-0123456789".into(),
            phase: phase.into(),
            operation_id: None,
            upload_job_id: None,
            handoff_note: Some("Refund half done".into()),
            received_note: None,
            error_code: None,
            quarantine: None,
            started_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn sessions_round_trip_and_reject_unknown_phases_and_bad_tokens() -> Result<(), StoreError> {
        let (_d, store, id) = store();
        store.put_team_session(&session(&id, "opening"))?;
        store.put_team_session(&session(&id, "running"))?;
        let got = store.team_session(&id)?.ok_or(StoreError::Corrupt)?;
        assert_eq!(
            (got.phase.as_str(), got.handoff_note.as_deref()),
            ("running", Some("Refund half done"))
        );
        assert_eq!(store.team_sessions()?.len(), 1);
        assert!(store.put_team_session(&session(&id, "dancing")).is_err());
        let mut bad = session(&id, "running");
        bad.fencing_token = Some("12a".into());
        assert!(store.put_team_session(&bad).is_err());
        assert!(store.delete_team_session(&id)?);
        assert!(store.team_session(&id)?.is_none());
        Ok(())
    }
}
