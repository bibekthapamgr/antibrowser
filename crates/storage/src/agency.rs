//! Agency workspace on this computer (milestone 09, ADR-0016): per-client downloads folders, health observations,
//! the extensions installed in each profile and each organization's extension policy as last downloaded.
//!
//! Health observations are results of checks that take time or the network (the server, proxies, browser updates);
//! each one says when it was checked and until when it counts. An expired observation is shown as "unknown", never
//! as the last result: a proxy check from last week is not "currently connected".

use crate::{LocalStore, StoreError};
use pb_runtime::extensions::{InstalledExtension, is_sensitive_permission};
use pb_runtime::{ClientId, ProfileId};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

pub const HEALTH_CHECKS: &[&str] = &["server", "proxy", "runtime_update"];
pub const HEALTH_RESULTS: &[&str] = &["ok", "warning", "problem", "unknown"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HealthObservation {
    pub check_type: String,
    pub subject: String,
    pub profile_id: Option<String>,
    pub result: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub checked_at: String,
    pub expires_at: String,
    /// Past `expires_at`: the result no longer describes the present.
    pub expired: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoredExtension {
    pub profile_id: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub enabled: bool,
    pub permissions: Vec<String>,
    /// The version before the last update seen on this computer.
    pub previous_version: Option<String>,
    /// Sensitive permissions the last update added, until someone reviews them (local profiles) or the
    /// organization's policy approves them.
    pub added_sensitive: Vec<String>,
    pub first_seen_at: String,
    pub changed_at: String,
}

/// What a scan found compared with the previous one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanChanges {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// (extension id, previous version, new version)
    pub updated: Vec<(String, String, String)>,
    /// (extension id, sensitive permissions it gained)
    pub expanded: Vec<(String, Vec<String>)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExtensionScan {
    pub profile_id: String,
    pub status: String,
    pub scanned_at: String,
    pub reported_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CachedPolicy {
    pub org_id: String,
    pub mode: String,
    pub version: i64,
    /// JSON array of the organization's rules.
    pub rules: String,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClientProfileRow {
    pub id: String,
    pub name: String,
    pub state: String,
    pub last_started_at: Option<String>,
    pub last_backup_at: Option<String>,
    pub shared: bool,
    pub running: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClientOverview {
    pub total: u64,
    pub running: u64,
    pub never_opened: u64,
    pub crashed: u64,
    pub shared: u64,
    pub archived: u64,
    pub items: Vec<ClientProfileRow>,
    pub more: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SelectionRow {
    pub id: String,
    pub name: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub running: bool,
    pub shared: bool,
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn json_list(text: Option<String>) -> Vec<String> {
    text.and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

impl LocalStore {
    // ------------------------------------------------------------------ client downloads
    /// Sets (or clears) the folder a client's profiles download into. Takes effect the next time each profile
    /// opens; nothing is moved.
    pub fn set_client_download_dir(
        &self,
        id: &ClientId,
        dir: Option<&str>,
    ) -> Result<(), StoreError> {
        let n = self.w()?.execute(
            &format!(
                "update clients_local set download_dir = ?2, version = version + 1, updated_at = {NOW}
                  where id = ?1"
            ),
            params![id.as_str(), dir],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn client_download_dir(&self, id: &ClientId) -> Result<Option<String>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                "select download_dir from clients_local where id = ?1",
                [id.as_str()],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    // ------------------------------------------------------------------ client overview and selections
    /// One client's profiles on this computer (not in the trash): counts and the first `limit`, open ones first,
    /// then most recently opened.
    pub fn client_overview(
        &self,
        client: &ClientId,
        limit: u32,
    ) -> Result<ClientOverview, StoreError> {
        let conn = self.r()?;
        let counts = conn.query_row(
            "select count(*), count(r.run_id), count(*) filter (where p.last_started_at is null),
                    count(*) filter (where p.state = 'crashed'), count(ol.local_profile_id),
                    count(*) filter (where p.archived_at is not null)
               from profiles p
               left join trash_entries te on te.profile_id = p.id
               left join process_runs r on r.profile_id = p.id and r.ended_at is null
               left join org_profile_links ol on ol.local_profile_id = p.id
              where p.client_id = ?1 and te.profile_id is null",
            [client.as_str()],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?.max(0) as u64,
                    r.get::<_, i64>(1)?.max(0) as u64,
                    r.get::<_, i64>(2)?.max(0) as u64,
                    r.get::<_, i64>(3)?.max(0) as u64,
                    r.get::<_, i64>(4)?.max(0) as u64,
                    r.get::<_, i64>(5)?.max(0) as u64,
                ))
            },
        )?;
        let mut stmt = conn.prepare_cached(
            "select p.id, p.name, p.state, p.last_started_at, p.last_backup_at, ol.local_profile_id is not null,
                    r.run_id is not null, p.archived_at is not null
               from profiles p
               left join trash_entries te on te.profile_id = p.id
               left join process_runs r on r.profile_id = p.id and r.ended_at is null
               left join org_profile_links ol on ol.local_profile_id = p.id
              where p.client_id = ?1 and te.profile_id is null
              order by r.run_id is null, p.last_started_at is null, p.last_started_at desc, p.id
              limit ?2",
        )?;
        let items = stmt
            .query_map(params![client.as_str(), limit.clamp(1, 500) + 1], |r| {
                Ok(ClientProfileRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    state: r.get(2)?,
                    last_started_at: r.get(3)?,
                    last_backup_at: r.get(4)?,
                    shared: r.get(5)?,
                    running: r.get(6)?,
                    archived: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > limit.clamp(1, 500) as usize;
        Ok(ClientOverview {
            total: counts.0,
            running: counts.1,
            never_opened: counts.2,
            crashed: counts.3,
            shared: counts.4,
            archived: counts.5,
            items: items
                .into_iter()
                .take(limit.clamp(1, 500) as usize)
                .collect(),
            more,
        })
    }

    /// Recent app activity (local audit log) of a client's profiles: what the app did, never website activity.
    pub fn client_activity(
        &self,
        client: &ClientId,
        limit: u32,
    ) -> Result<Vec<(crate::runs::AuditEntry, String)>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select a.seq, a.at, a.profile_id, a.action, a.outcome, a.run_id, a.detail, p.name
               from audit_log a join profiles p on p.id = a.profile_id
              where p.client_id = ?1
              order by a.seq desc limit ?2",
        )?;
        let rows = stmt.query_map(params![client.as_str(), limit.clamp(1, 200)], |r| {
            Ok((
                crate::runs::AuditEntry {
                    seq: r.get(0)?,
                    at: r.get(1)?,
                    profile_id: r.get(2)?,
                    action: r.get(3)?,
                    outcome: r.get(4)?,
                    run_id: r.get(5)?,
                    detail: r.get(6)?,
                },
                r.get::<_, String>(7)?,
            ))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Name, client, running and shared state of each selected profile (unknown ids are left out).
    pub fn selection_rows(&self, ids: &[ProfileId]) -> Result<Vec<SelectionRow>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select p.id, p.name, p.client_id, c.name, r.run_id is not null, ol.local_profile_id is not null
               from profiles p
               left join clients_local c on c.id = p.client_id
               left join process_runs r on r.profile_id = p.id and r.ended_at is null
               left join org_profile_links ol on ol.local_profile_id = p.id
              where p.id = ?1",
        )?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(row) = stmt
                .query_row([id.as_str()], |r| {
                    Ok(SelectionRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        client_id: r.get(2)?,
                        client_name: r.get(3)?,
                        running: r.get(4)?,
                        shared: r.get(5)?,
                    })
                })
                .optional()?
            {
                out.push(row);
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ health
    #[allow(clippy::too_many_arguments)]
    pub fn record_health(
        &self,
        check_type: &str,
        subject: &str,
        profile_id: Option<&ProfileId>,
        result: &str,
        code: Option<&str>,
        detail: Option<&str>,
        valid_for_seconds: u32,
    ) -> Result<(), StoreError> {
        if !HEALTH_CHECKS.contains(&check_type) || !HEALTH_RESULTS.contains(&result) {
            return Err(StoreError::Invalid("health observation"));
        }
        self.w()?.execute(
            &format!(
                "insert into health_observations (check_type, subject, profile_id, result, code, detail, checked_at,
                                                  expires_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, {NOW},
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?7 || ' seconds'))
                 on conflict (check_type, subject) do update set
                   profile_id = excluded.profile_id, result = excluded.result, code = excluded.code,
                   detail = excluded.detail, checked_at = excluded.checked_at, expires_at = excluded.expires_at"
            ),
            params![
                check_type,
                subject,
                profile_id.map(ProfileId::as_str),
                result,
                code,
                detail.map(|d| d.chars().take(300).collect::<String>()),
                valid_for_seconds,
            ],
        )?;
        Ok(())
    }

    pub fn list_health(&self) -> Result<Vec<HealthObservation>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "select check_type, subject, profile_id, result, code, detail, checked_at, expires_at,
                    expires_at <= {NOW}
               from health_observations order by check_type, subject limit 2000"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(HealthObservation {
                check_type: r.get(0)?,
                subject: r.get(1)?,
                profile_id: r.get(2)?,
                result: r.get(3)?,
                code: r.get(4)?,
                detail: r.get(5)?,
                checked_at: r.get(6)?,
                expires_at: r.get(7)?,
                expired: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn clear_health(&self, check_type: &str, subject: &str) -> Result<(), StoreError> {
        self.w()?.execute(
            "delete from health_observations where check_type = ?1 and subject = ?2",
            params![check_type, subject],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------ extensions
    /// Stores what a scan of the profile found and reports what changed since the previous scan. An update that adds
    /// sensitive permissions keeps them in `added_sensitive` until reviewed; a later update adds to that list.
    pub fn record_extension_scan(
        &self,
        profile: &ProfileId,
        found: &[InstalledExtension],
    ) -> Result<ScanChanges, StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let mut before: HashMap<String, (String, Vec<String>, Vec<String>)> = HashMap::new();
        {
            let mut stmt = tx.prepare(
                "select extension_id, version, permissions, added_sensitive from extension_inventory
                  where profile_id = ?1",
            )?;
            let rows = stmt.query_map([profile.as_str()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            for row in rows {
                let (id, version, permissions, added) = row?;
                before.insert(
                    id,
                    (version, json_list(Some(permissions)), json_list(added)),
                );
            }
        }
        let first_scan = tx
            .query_row(
                "select 1 from extension_scans where profile_id = ?1",
                [profile.as_str()],
                |_| Ok(()),
            )
            .optional()?
            .is_none();
        let mut changes = ScanChanges::default();
        for e in found {
            let permissions = serde_json::to_string(&e.permissions)
                .map_err(|_| StoreError::Invalid("permissions"))?;
            match before.remove(&e.id) {
                None => {
                    // Installed since the last scan: anything sensitive it asks for is new to this profile (except on
                    // the very first scan, which only takes stock).
                    let sensitive: Vec<String> = if first_scan {
                        vec![]
                    } else {
                        e.permissions
                            .iter()
                            .filter(|p| is_sensitive_permission(p))
                            .cloned()
                            .collect()
                    };
                    tx.execute(
                        "insert into extension_inventory (profile_id, extension_id, name, version, source, enabled,
                                                          permissions, added_sensitive)
                         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            profile.as_str(),
                            e.id,
                            e.name,
                            e.version,
                            e.source.as_str(),
                            e.enabled,
                            permissions,
                            (!sensitive.is_empty())
                                .then(|| serde_json::to_string(&sensitive).unwrap_or_default()),
                        ],
                    )?;
                    if !first_scan {
                        changes.added.push(e.id.clone());
                    }
                }
                Some((old_version, old_permissions, mut pending)) => {
                    let old: BTreeSet<&String> = old_permissions.iter().collect();
                    let gained: Vec<String> = e
                        .permissions
                        .iter()
                        .filter(|p| is_sensitive_permission(p) && !old.contains(p))
                        .cloned()
                        .collect();
                    // Pending ones the extension no longer asks for are dropped.
                    pending.retain(|p| e.permissions.contains(p));
                    for g in &gained {
                        if !pending.contains(g) {
                            pending.push(g.clone());
                        }
                    }
                    let version_changed = old_version != e.version;
                    let changed = version_changed || old_permissions != e.permissions;
                    tx.execute(
                        &format!(
                            "update extension_inventory set name = ?3, version = ?4, source = ?5, enabled = ?6,
                                    permissions = ?7, added_sensitive = ?8,
                                    previous_version = case when ?9 then ?10 else previous_version end,
                                    changed_at = case when ?11 then {NOW} else changed_at end
                              where profile_id = ?1 and extension_id = ?2"
                        ),
                        params![
                            profile.as_str(),
                            e.id,
                            e.name,
                            e.version,
                            e.source.as_str(),
                            e.enabled,
                            permissions,
                            (!pending.is_empty())
                                .then(|| serde_json::to_string(&pending).unwrap_or_default()),
                            version_changed,
                            old_version,
                            changed,
                        ],
                    )?;
                    if version_changed {
                        changes
                            .updated
                            .push((e.id.clone(), old_version, e.version.clone()));
                    }
                    if !gained.is_empty() {
                        changes.expanded.push((e.id.clone(), gained));
                    }
                }
            }
        }
        for id in before.into_keys() {
            tx.execute(
                "delete from extension_inventory where profile_id = ?1 and extension_id = ?2",
                params![profile.as_str(), id],
            )?;
            changes.removed.push(id);
        }
        tx.execute(
            &format!(
                "insert into extension_scans (profile_id, status, scanned_at) values (?1, 'ok', {NOW})
                 on conflict (profile_id) do update set status = 'ok', scanned_at = excluded.scanned_at"
            ),
            [profile.as_str()],
        )?;
        tx.commit()?;
        changes.removed.sort();
        Ok(changes)
    }

    /// The profile's settings file could not be read: the previous inventory stays, marked as not current.
    pub fn record_extension_scan_failed(&self, profile: &ProfileId) -> Result<(), StoreError> {
        self.w()?.execute(
            &format!(
                "insert into extension_scans (profile_id, status, scanned_at) values (?1, 'unreadable', {NOW})
                 on conflict (profile_id) do update set status = 'unreadable', scanned_at = excluded.scanned_at"
            ),
            [profile.as_str()],
        )?;
        Ok(())
    }

    pub fn mark_extensions_reported(&self, profile: &ProfileId) -> Result<(), StoreError> {
        self.w()?.execute(
            &format!("update extension_scans set reported_at = {NOW} where profile_id = ?1"),
            [profile.as_str()],
        )?;
        Ok(())
    }

    pub fn extension_scans(&self) -> Result<Vec<ExtensionScan>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id, status, scanned_at, reported_at from extension_scans order by profile_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ExtensionScan {
                profile_id: r.get(0)?,
                status: r.get(1)?,
                scanned_at: r.get(2)?,
                reported_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Installed extensions of one profile, or of every profile.
    pub fn list_extensions(
        &self,
        profile: Option<&ProfileId>,
    ) -> Result<Vec<StoredExtension>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id, extension_id, name, version, source, enabled, permissions, previous_version,
                    added_sensitive, first_seen_at, changed_at
               from extension_inventory where (?1 is null or profile_id = ?1)
              order by profile_id, lower(name), extension_id limit 20000",
        )?;
        let rows = stmt.query_map([profile.map(ProfileId::as_str)], |r| {
            Ok(StoredExtension {
                profile_id: r.get(0)?,
                id: r.get(1)?,
                name: r.get(2)?,
                version: r.get(3)?,
                source: r.get(4)?,
                enabled: r.get(5)?,
                permissions: json_list(r.get(6)?),
                previous_version: r.get(7)?,
                added_sensitive: json_list(r.get(8)?),
                first_seen_at: r.get(9)?,
                changed_at: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The person reviewed the added permissions (local profiles): the warning goes away until the next increase.
    pub fn acknowledge_extension(
        &self,
        profile: &ProfileId,
        extension_id: &str,
    ) -> Result<(), StoreError> {
        let n = self.w()?.execute(
            "update extension_inventory set added_sensitive = null where profile_id = ?1 and extension_id = ?2",
            params![profile.as_str(), extension_id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    // ------------------------------------------------------------------ extension policy cache
    pub fn save_extension_policy(
        &self,
        org_id: &str,
        mode: &str,
        version: i64,
        rules: &str,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            &format!(
                "insert into extension_policy_cache (org_id, mode, version, rules, fetched_at)
                 values (?1, ?2, ?3, ?4, {NOW})
                 on conflict (org_id) do update set mode = excluded.mode, version = excluded.version,
                   rules = excluded.rules, fetched_at = excluded.fetched_at"
            ),
            params![org_id, mode, version, rules],
        )?;
        Ok(())
    }

    pub fn extension_policy(&self, org_id: &str) -> Result<Option<CachedPolicy>, StoreError> {
        Ok(self
            .r()?
            .query_row(
                "select org_id, mode, version, rules, fetched_at from extension_policy_cache where org_id = ?1",
                [org_id],
                |r| {
                    Ok(CachedPolicy {
                        org_id: r.get(0)?,
                        mode: r.get(1)?,
                        version: r.get(2)?,
                        rules: r.get(3)?,
                        fetched_at: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewProfile;
    use pb_runtime::extensions::ExtensionSource;

    fn store_with_profile() -> Result<(tempfile::TempDir, LocalStore, ProfileId), StoreError> {
        let dir = tempfile::tempdir()?;
        let store = LocalStore::open(&dir.path().join("local.db"))?;
        let id =
            ProfileId::parse("prf_01J9ZSEED00000000000000001").map_err(|_| StoreError::Corrupt)?;
        store.insert_profile(NewProfile::basic(id.clone(), None, "p", None))?;
        Ok((dir, store, id))
    }

    fn ext(id: char, version: &str, permissions: &[&str]) -> InstalledExtension {
        InstalledExtension {
            id: id.to_string().repeat(32),
            name: format!("Extension {id}"),
            version: version.into(),
            source: ExtensionSource::WebStore,
            enabled: true,
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        }
    }

    #[test]
    fn scans_record_updates_and_new_sensitive_permissions_until_reviewed() -> Result<(), StoreError>
    {
        let (_dir, store, id) = store_with_profile()?;

        // The first scan only takes stock.
        let first =
            store.record_extension_scan(&id, &[ext('a', "1.0", &["storage", "cookies"])])?;
        assert_eq!(first, ScanChanges::default());
        assert!(
            store.list_extensions(Some(&id))?[0]
                .added_sensitive
                .is_empty()
        );

        // An update that asks for every site; a newly installed extension that asks for tabs.
        let second = store.record_extension_scan(
            &id,
            &[
                ext('a', "1.1", &["storage", "cookies", "<all_urls>"]),
                ext('b', "3.0", &["tabs", "alarms"]),
            ],
        )?;
        assert_eq!(
            second.updated,
            [("a".repeat(32), "1.0".into(), "1.1".into())]
        );
        assert_eq!(
            second.expanded,
            [("a".repeat(32), vec!["<all_urls>".to_owned()])]
        );
        assert_eq!(second.added, ["b".repeat(32)]);
        let list = store.list_extensions(Some(&id))?;
        assert_eq!(list[0].previous_version.as_deref(), Some("1.0"));
        assert_eq!(list[0].added_sensitive, ["<all_urls>"]);
        assert_eq!(list[1].added_sensitive, ["tabs"]);

        // Reviewed: the warning goes away; the next scan without changes keeps it away.
        store.acknowledge_extension(&id, &"a".repeat(32))?;
        let third = store.record_extension_scan(
            &id,
            &[ext('a', "1.1", &["storage", "cookies", "<all_urls>"])],
        )?;
        assert_eq!(third.removed, ["b".repeat(32)]);
        assert!(third.updated.is_empty() && third.expanded.is_empty());
        let list = store.list_extensions(None)?;
        assert_eq!(list.len(), 1);
        assert!(list[0].added_sensitive.is_empty());
        assert_eq!(store.extension_scans()?[0].status, "ok");
        Ok(())
    }

    #[test]
    fn health_observations_expire() -> Result<(), StoreError> {
        let (_dir, store, _id) = store_with_profile()?;
        store.record_health("server", "", None, "ok", None, None, 300)?;
        store.record_health("proxy", "prx_x", None, "ok", None, Some("checked"), 0)?;
        assert!(
            store
                .record_health("ban_risk", "", None, "ok", None, None, 1)
                .is_err()
        );
        let list = store.list_health()?;
        let server = list.iter().find(|h| h.check_type == "server");
        let proxy = list.iter().find(|h| h.check_type == "proxy");
        assert_eq!(server.map(|h| h.expired), Some(false));
        assert_eq!(proxy.map(|h| h.expired), Some(true));
        store.clear_health("proxy", "prx_x")?;
        assert_eq!(store.list_health()?.len(), 1);
        Ok(())
    }
}
