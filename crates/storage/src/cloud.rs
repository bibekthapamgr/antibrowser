//! Account state, offline cache and organization links (milestone 06).
//!
//! - `cloud_state`: the configured server, this device's enrolled id and the signed-in account summary (display data
//!   only). No token or secret is ever stored here: the refresh token lives in the OS keychain.
//! - `cloud_cache`: the last organization metadata fetched from the server, so the manager can show it offline. It is
//!   always presented as stale and is never consulted for an authorization decision.
//! - `org_profile_links`: which organization profile a local profile was copied to. Local records are never removed
//!   by a copy; the link only records that the organization's copy exists.

use crate::{LocalStore, StoreError};
use pb_runtime::ProfileId;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

/// Keys of `cloud_state`.
pub const SERVER_URL: &str = "server_url";
pub const DEVICE_ID: &str = "device_id";
pub const ACCOUNT: &str = "account";

/// Cached responses are bounded so a large organization cannot grow the local database without limit.
pub const MAX_CACHE_ENTRIES: u32 = 500;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CachedBody {
    pub body: String,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OrgLink {
    pub local_profile_id: ProfileId,
    pub org_id: String,
    pub org_profile_id: String,
    pub linked_at: String,
}

fn org_id_ok(id: &str) -> bool {
    id.len() == 30 && id.starts_with("org_")
}

impl LocalStore {
    pub fn cloud_state(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                "select value from cloud_state where key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn set_cloud_state(&self, key: &str, value: Option<&str>) -> Result<(), StoreError> {
        let conn = self.w()?;
        match value {
            Some(v) => conn.execute(
                "insert into cloud_state (key, value) values (?1, ?2)
                 on conflict (key) do update set value = excluded.value,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![key, v],
            )?,
            None => conn.execute("delete from cloud_state where key = ?1", params![key])?,
        };
        Ok(())
    }

    /// Stores the latest copy of a server response (`key` is the request path).
    pub fn cache_put(&self, key: &str, body: &str) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        tx.execute(
            "insert into cloud_cache (key, body) values (?1, ?2)
             on conflict (key) do update set body = excluded.body,
               fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![key, body],
        )?;
        // Keep the newest entries only.
        tx.execute(
            "delete from cloud_cache where key not in
               (select key from cloud_cache order by fetched_at desc, key limit ?1)",
            params![MAX_CACHE_ENTRIES],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn cache_get(&self, key: &str) -> Result<Option<CachedBody>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                "select body, fetched_at from cloud_cache where key = ?1",
                params![key],
                |r| {
                    Ok(CachedBody {
                        body: r.get(0)?,
                        fetched_at: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Forgets every cached organization response (sign-out, server change).
    pub fn cache_clear(&self) -> Result<(), StoreError> {
        self.w()?.execute("delete from cloud_cache", [])?;
        Ok(())
    }

    /// Records that local profiles were copied to an organization (after the server committed the copy).
    pub fn link_org_profiles(
        &self,
        org_id: &str,
        links: &[(ProfileId, String)],
    ) -> Result<(), StoreError> {
        if !org_id_ok(org_id) {
            return Err(StoreError::Invalid("organization id"));
        }
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        for (local, remote) in links {
            if remote.len() != 30 || !remote.starts_with("prf_") {
                return Err(StoreError::Invalid("organization profile id"));
            }
            tx.execute(
                "insert into org_profile_links (local_profile_id, org_id, org_profile_id) values (?1, ?2, ?3)
                 on conflict (local_profile_id) do update set org_id = excluded.org_id,
                   org_profile_id = excluded.org_profile_id,
                   linked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![local.as_str(), org_id, remote],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Forgets a local profile's link (the local record and the organization profile both stay). Used when a
    /// device's link table is reset; the server's identity map restores it (R1).
    pub fn unlink_org_profile(&self, local: &ProfileId) -> Result<bool, StoreError> {
        let n = self.w()?.execute(
            "delete from org_profile_links where local_profile_id = ?1",
            [local.as_str()],
        )?;
        Ok(n > 0)
    }

    pub fn org_links(&self, org_id: Option<&str>) -> Result<Vec<OrgLink>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare(
            "select local_profile_id, org_id, org_profile_id, linked_at from org_profile_links
              where ?1 is null or org_id = ?1 order by linked_at, local_profile_id limit 10000",
        )?;
        let rows = stmt
            .query_map(params![org_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(local, org_id, org_profile_id, linked_at)| {
                Ok(OrgLink {
                    local_profile_id: ProfileId::parse(&local).map_err(|_| StoreError::Corrupt)?,
                    org_id,
                    org_profile_id,
                    linked_at,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::{LocalStore, NewProfile};

    fn store() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store =
            LocalStore::open(&dir.path().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
        (dir, store)
    }

    #[test]
    fn state_cache_and_links() -> Result<(), crate::StoreError> {
        let (_dir, store) = store();
        assert_eq!(store.cloud_state(super::SERVER_URL)?, None);
        store.set_cloud_state(super::SERVER_URL, Some("https://api.example.test"))?;
        store.set_cloud_state(super::SERVER_URL, Some("https://api2.example.test"))?;
        assert_eq!(
            store.cloud_state(super::SERVER_URL)?.as_deref(),
            Some("https://api2.example.test")
        );
        store.set_cloud_state(super::SERVER_URL, None)?;
        assert_eq!(store.cloud_state(super::SERVER_URL)?, None);
        // Unknown keys are refused by the schema.
        assert!(store.set_cloud_state("refresh_token", Some("x")).is_err());

        store.cache_put("/v1/me/workspaces", r#"{"items":[]}"#)?;
        assert_eq!(
            store
                .cache_get("/v1/me/workspaces")?
                .map(|c| c.body)
                .as_deref(),
            Some(r#"{"items":[]}"#)
        );
        assert!(store.cache_put("/x", "not json").is_err());
        store.cache_clear()?;
        assert_eq!(store.cache_get("/v1/me/workspaces")?, None);

        let ws = store.create_workspace("Local")?;
        let profile = store.insert_profile(NewProfile::basic(
            pb_runtime::ProfileId::generate().map_err(|_| crate::StoreError::Invalid("rng"))?,
            Some(ws.id),
            "Shop",
            None,
        ))?;
        let org = format!("org_{}", "A".repeat(26));
        let remote = format!("prf_{}", "B".repeat(26));
        store.link_org_profiles(&org, &[(profile.id.clone(), remote.clone())])?;
        let links = store.org_links(Some(&org))?;
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].org_profile_id, remote);
        assert!(store.org_links(Some("org_other"))?.is_empty());
        assert!(store.link_org_profiles("bad", &[]).is_err());
        assert!(
            store
                .link_org_profiles(&org, &[(profile.id.clone(), "prf_short".into())])
                .is_err()
        );
        Ok(())
    }
}
