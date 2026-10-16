//! Proxies, per-profile routing, connectivity checks and gateway sessions (milestone 05).
//!
//! Only metadata is stored here. A proxy's login lives in the OS keychain; `credential_ref` names the keychain entry
//! (`proxy:<id>`), so the database never holds a username or password. A proxy that profiles use cannot be deleted
//! (a profile would otherwise silently lose its proxy): the caller reassigns them first.

use crate::migrations::name_key;
use crate::{LocalStore, StoreError};
use pb_runtime::{NetworkCheckId, ProfileId, ProxyGeo, ProxyId, WorkspaceId};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

/// Diagnostic records (with the observed exit address) are kept this long.
pub const CHECK_RETENTION_DAYS: u32 = 7;
pub const KINDS: &[&str] = &["http", "https", "socks5"];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NetworkCheck {
    pub id: NetworkCheckId,
    pub proxy_id: ProxyId,
    /// `ok` or `error`.
    pub result: String,
    pub error_code: Option<String>,
    pub latency_ms: Option<u64>,
    pub egress_ip: Option<String>,
    pub checked_at: String,
    /// The check service's estimate of where the exit address is (ADR-0027); `None` when it gave none.
    pub geo: Option<ProxyGeo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProxyConfig {
    pub id: ProxyId,
    pub workspace_id: WorkspaceId,
    pub owner_scope: String,
    pub name: String,
    /// `http` | `https` | `socks5`
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// Keychain entry holding the login; `None` = no login.
    pub credential_ref: Option<String>,
    /// `YYYY-MM-DD`, as given by the user or provider.
    pub expires_at: Option<String>,
    pub notes: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Profiles assigned to this proxy (including archived and trashed ones).
    pub profiles: u64,
    pub last_check: Option<NetworkCheck>,
}

pub struct NewProxy<'a> {
    pub id: ProxyId,
    pub workspace_id: &'a WorkspaceId,
    pub name: &'a str,
    pub kind: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub credential_ref: Option<&'a str>,
    pub expires_at: Option<&'a str>,
    pub notes: &'a str,
}

#[derive(Default)]
pub struct ProxyChanges<'a> {
    pub name: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub host: Option<&'a str>,
    pub port: Option<u16>,
    pub credential_ref: Option<Option<&'a str>>,
    pub expires_at: Option<Option<&'a str>>,
    pub notes: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GatewaySession {
    pub port: u16,
    pub proxy_id: ProxyId,
    pub proxy_version: i64,
    /// The routing mode the browser was started with.
    pub fail_closed: bool,
}

/// Where a profile's proxy exited at its last successful open (ADR-0029: the proxy location lock). At least an address
/// or a country is known. `seen_at` is the store's timestamp format (`YYYY-MM-DDTHH:MM:SS.fffZ`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileLocation {
    pub egress_ip: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
    pub seen_at: String,
}

/// `2026-10-16T09:30:00.000Z` (or without fractions): the shape of the store's timestamps.
pub fn valid_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    (20..=30).contains(&b.len())
        && valid_date(s.get(0..10).unwrap_or_default())
        && b[10] == b'T'
        && b[b.len() - 1] == b'Z'
        && s[11..b.len() - 1]
            .bytes()
            .all(|c| c.is_ascii_digit() || c == b':' || c == b'.')
}

/// `YYYY-MM-DD` with a plausible month and day.
pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    matches!((num(0..4), num(5..7), num(8..10)), (Some(y), Some(m), Some(d))
        if (2000..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d))
}

fn check_fields(
    name: Option<&str>,
    kind: Option<&str>,
    expires: Option<Option<&str>>,
    notes: Option<&str>,
) -> Result<(), StoreError> {
    if name.is_some_and(|n| n.trim().is_empty() || n.chars().count() > 80) {
        return Err(StoreError::Invalid("proxy names are 1-80 characters"));
    }
    if kind.is_some_and(|k| !KINDS.contains(&k)) {
        return Err(StoreError::Invalid("unsupported proxy type"));
    }
    if let Some(Some(d)) = expires
        && !valid_date(d)
    {
        return Err(StoreError::Invalid("expiry must be a date (YYYY-MM-DD)"));
    }
    if notes.is_some_and(|n| n.chars().count() > 500) {
        return Err(StoreError::Invalid(
            "proxy notes are at most 500 characters",
        ));
    }
    Ok(())
}

const SELECT_PROXY: &str =
    "select x.id, x.workspace_id, x.owner_scope, x.name, x.type, x.host, x.port,
       x.credential_ref, x.expires_at, x.notes, x.version, x.created_at, x.updated_at,
       (select count(*) from profile_network_settings ns where ns.proxy_id = x.id),
       c.id, c.result, c.error_code, c.latency_ms, c.egress_ip, c.checked_at,
       c.country, c.city, c.timezone, c.language, c.latitude, c.longitude
     from proxy_configs x
     left join network_checks c on c.id = (select id from network_checks where proxy_id = x.id
                                           order by checked_at desc, rowid desc limit 1)";

fn row_to_proxy(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ProxyConfig, StoreError>> {
    let (Ok(id), Ok(ws)) = (
        ProxyId::parse(&r.get::<_, String>(0)?),
        WorkspaceId::parse(&r.get::<_, String>(1)?),
    ) else {
        return Ok(Err(StoreError::Corrupt));
    };
    let last_check = match r.get::<_, Option<String>>(14)? {
        None => None,
        Some(cid) => {
            let Ok(cid) = NetworkCheckId::parse(&cid) else {
                return Ok(Err(StoreError::Corrupt));
            };
            Some(NetworkCheck {
                id: cid,
                proxy_id: id.clone(),
                result: r.get(15)?,
                error_code: r.get(16)?,
                latency_ms: r.get::<_, Option<i64>>(17)?.map(|v| v.max(0) as u64),
                egress_ip: r.get(18)?,
                checked_at: r.get(19)?,
                geo: geo_at(r, 20)?,
            })
        }
    };
    Ok(Ok(ProxyConfig {
        id,
        workspace_id: ws,
        owner_scope: r.get(2)?,
        name: r.get(3)?,
        kind: r.get(4)?,
        host: r.get(5)?,
        port: u16::try_from(r.get::<_, i64>(6)?).unwrap_or(0),
        credential_ref: r.get(7)?,
        expires_at: r.get(8)?,
        notes: r.get(9)?,
        version: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        profiles: r.get::<_, i64>(13)?.max(0) as u64,
        last_check,
    }))
}

fn row_to_check(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<NetworkCheck, StoreError>> {
    let (Ok(id), Ok(proxy)) = (
        NetworkCheckId::parse(&r.get::<_, String>(0)?),
        ProxyId::parse(&r.get::<_, String>(1)?),
    ) else {
        return Ok(Err(StoreError::Corrupt));
    };
    Ok(Ok(NetworkCheck {
        id,
        proxy_id: proxy,
        result: r.get(2)?,
        error_code: r.get(3)?,
        latency_ms: r.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u64),
        egress_ip: r.get(5)?,
        checked_at: r.get(6)?,
        geo: geo_at(r, 7)?,
    }))
}

const CHECK_COLUMNS: &str = "id, proxy_id, result, error_code, latency_ms, egress_ip, checked_at,
       country, city, timezone, language, latitude, longitude";

/// The six location columns starting at `i`; `None` when all are empty.
fn geo_at(r: &rusqlite::Row<'_>, i: usize) -> rusqlite::Result<Option<ProxyGeo>> {
    let geo = ProxyGeo {
        country: r.get(i)?,
        city: r.get(i + 1)?,
        timezone: r.get(i + 2)?,
        language: r.get(i + 3)?,
        latitude: r.get(i + 4)?,
        longitude: r.get(i + 5)?,
    };
    Ok((geo != ProxyGeo::default()).then_some(geo))
}

/// The routing settings of one profile (no row: no proxy, fail-closed on).
pub(crate) fn settings_of(
    tx: &Transaction<'_>,
    id: &ProfileId,
) -> Result<(Option<ProxyId>, bool), StoreError> {
    let row: Option<(Option<String>, i64)> = tx
        .query_row(
            "select proxy_id, fail_closed from profile_network_settings where profile_id = ?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((proxy, fc)) = row else {
        return Ok((None, true));
    };
    let proxy = proxy
        .map(|p| ProxyId::parse(&p).map_err(|_| StoreError::Corrupt))
        .transpose()?;
    Ok((proxy, fc == 1))
}

pub(crate) fn proxy_exists(tx: &Transaction<'_>, id: &ProxyId) -> Result<bool, StoreError> {
    Ok(tx
        .query_row(
            "select 1 from proxy_configs where id = ?1",
            [id.as_str()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Replaces a profile's routing settings; the proxy must belong to the profile's workspace.
pub(crate) fn upsert_settings(
    tx: &Transaction<'_>,
    profile: &ProfileId,
    proxy: Option<&ProxyId>,
    fail_closed: bool,
) -> Result<(), StoreError> {
    if let Some(p) = proxy {
        let same_ws: Option<i64> = tx
            .query_row(
                "select 1 from proxy_configs x join profiles pr on pr.workspace_id = x.workspace_id
                  where x.id = ?1 and pr.id = ?2",
                params![p.as_str(), profile.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        if same_ws.is_none() {
            return Err(StoreError::NotFound);
        }
    }
    tx.execute(
        "insert into profile_network_settings (profile_id, proxy_id, fail_closed, config_version)
              values (?1, ?2, ?3, 1)
         on conflict(profile_id) do update set proxy_id = excluded.proxy_id, fail_closed = excluded.fail_closed,
              config_version = profile_network_settings.config_version + 1",
        params![profile.as_str(), proxy.map(ProxyId::as_str), fail_closed],
    )?;
    Ok(())
}

impl LocalStore {
    pub fn create_proxy(&self, new: NewProxy<'_>) -> Result<ProxyConfig, StoreError> {
        check_fields(
            Some(new.name),
            Some(new.kind),
            Some(new.expires_at),
            Some(new.notes),
        )?;
        let conn = self.w()?;
        let r = conn.execute(
            "insert into proxy_configs (id, workspace_id, name, name_key, type, host, port, credential_ref,
                                        expires_at, notes)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                new.id.as_str(),
                new.workspace_id.as_str(),
                new.name.trim(),
                name_key(new.name),
                new.kind,
                new.host,
                new.port,
                new.credential_ref,
                new.expires_at,
                new.notes,
            ],
        );
        match r {
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation
                    && e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                return Err(StoreError::Duplicate);
            }
            other => {
                other?;
            }
        }
        drop(conn);
        self.get_proxy(&new.id)?.ok_or(StoreError::Corrupt)
    }

    pub fn update_proxy(
        &self,
        id: &ProxyId,
        expected_version: i64,
        c: ProxyChanges<'_>,
    ) -> Result<ProxyConfig, StoreError> {
        check_fields(c.name, c.kind, c.expires_at, c.notes)?;
        let conn = self.w()?;
        let r = conn.execute(
            "update proxy_configs set
               name = coalesce(?3, name), name_key = coalesce(?4, name_key), type = coalesce(?5, type),
               host = coalesce(?6, host), port = coalesce(?7, port),
               credential_ref = case when ?8 then ?9 else credential_ref end,
               expires_at = case when ?10 then ?11 else expires_at end,
               notes = coalesce(?12, notes),
               version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             where id = ?1 and version = ?2",
            params![
                id.as_str(),
                expected_version,
                c.name.map(str::trim),
                c.name.map(name_key),
                c.kind,
                c.host,
                c.port,
                c.credential_ref.is_some(),
                c.credential_ref.flatten(),
                c.expires_at.is_some(),
                c.expires_at.flatten(),
                c.notes,
            ],
        );
        let updated = match r {
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation
                    && e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                return Err(StoreError::Duplicate);
            }
            other => other?,
        };
        drop(conn);
        if updated == 0 {
            return match self.get_proxy(id)? {
                Some(p) => Err(StoreError::VersionConflict { current: p.version }),
                None => Err(StoreError::NotFound),
            };
        }
        self.get_proxy(id)?.ok_or(StoreError::Corrupt)
    }

    /// Deletes a proxy no profile uses (`InUse(n)` otherwise) with its check history.
    pub fn delete_proxy(&self, id: &ProxyId) -> Result<(), StoreError> {
        let mut conn = self.w()?;
        let tx = conn.transaction()?;
        let used: i64 = tx.query_row(
            "select count(*) from profile_network_settings where proxy_id = ?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Err(StoreError::InUse(used as u64));
        }
        if tx.execute("delete from proxy_configs where id = ?1", [id.as_str()])? == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_proxy(&self, id: &ProxyId) -> Result<Option<ProxyConfig>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!("{SELECT_PROXY} where x.id = ?1"))?;
        stmt.query_row([id.as_str()], row_to_proxy)
            .optional()?
            .transpose()
    }

    pub fn list_proxies(&self, workspace: &WorkspaceId) -> Result<Vec<ProxyConfig>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT_PROXY} where x.workspace_id = ?1 order by x.name_key, x.id limit 1000"
        ))?;
        stmt.query_map([workspace.as_str()], row_to_proxy)?
            .map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    /// Records a check. Only an address (validated by the caller), a latency, an error code and the service's
    /// location estimate (validated when the answer was read; the table's checks hold it to the same shapes).
    pub fn record_check(
        &self,
        proxy: &ProxyId,
        error_code: Option<&str>,
        latency_ms: Option<u64>,
        egress_ip: Option<&str>,
        geo: Option<&ProxyGeo>,
    ) -> Result<NetworkCheck, StoreError> {
        let id = NetworkCheckId::generate().map_err(|_| StoreError::Corrupt)?;
        let g = geo.cloned().unwrap_or_default();
        let conn = self.w()?;
        conn.execute(
            "insert into network_checks (id, proxy_id, result, error_code, latency_ms, egress_ip,
                                         country, city, timezone, language, latitude, longitude)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id.as_str(),
                proxy.as_str(),
                if error_code.is_some() { "error" } else { "ok" },
                error_code,
                latency_ms.map(|v| i64::try_from(v).unwrap_or(i64::MAX)),
                egress_ip,
                g.country,
                g.city,
                g.timezone,
                g.language,
                g.latitude,
                g.longitude,
            ],
        )?;
        let mut stmt = conn.prepare_cached(&format!(
            "select {CHECK_COLUMNS} from network_checks where id = ?1"
        ))?;
        stmt.query_row([id.as_str()], row_to_check)?
    }

    pub fn list_checks(
        &self,
        proxy: &ProxyId,
        limit: u32,
    ) -> Result<Vec<NetworkCheck>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(&format!(
            "select {CHECK_COLUMNS}
               from network_checks where proxy_id = ?1 order by checked_at desc, rowid desc limit ?2"
        ))?;
        stmt.query_map(params![proxy.as_str(), limit.clamp(1, 500)], row_to_check)?
            .map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    /// Deletes check records older than [`CHECK_RETENTION_DAYS`].
    pub fn purge_checks(&self) -> Result<usize, StoreError> {
        Ok(self.w()?.execute(
            "delete from network_checks where checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)",
            [format!("-{CHECK_RETENTION_DAYS} days")],
        )?)
    }

    /// Profiles routed through `proxy` (for reassigning before deletion).
    pub fn profiles_using_proxy(&self, proxy: &ProxyId) -> Result<Vec<ProfileId>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id from profile_network_settings where proxy_id = ?1 order by profile_id limit 10000",
        )?;
        stmt.query_map([proxy.as_str()], |r| r.get::<_, String>(0))?
            .map(|r| {
                r.map_err(StoreError::from)
                    .and_then(|s| ProfileId::parse(&s).map_err(|_| StoreError::Corrupt))
            })
            .collect()
    }

    /// The loopback gateway a running profile uses, so it can be restored after a manager restart.
    pub fn set_gateway_session(
        &self,
        profile: &ProfileId,
        session: &GatewaySession,
    ) -> Result<(), StoreError> {
        self.w()?.execute(
            "insert or replace into gateway_sessions (profile_id, port, proxy_id, proxy_version, fail_closed)
             values (?1, ?2, ?3, ?4, ?5)",
            params![
                profile.as_str(),
                session.port,
                session.proxy_id.as_str(),
                session.proxy_version,
                session.fail_closed,
            ],
        )?;
        Ok(())
    }

    pub fn gateway_session(
        &self,
        profile: &ProfileId,
    ) -> Result<Option<GatewaySession>, StoreError> {
        Ok(self
            .gateway_sessions()?
            .into_iter()
            .find(|(p, _)| p == profile)
            .map(|(_, s)| s))
    }

    /// Every recorded gateway session (at most one per profile).
    pub fn gateway_sessions(&self) -> Result<Vec<(ProfileId, GatewaySession)>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select profile_id, port, proxy_id, proxy_version, fail_closed from gateway_sessions
              order by profile_id limit 10000",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(profile, port, proxy, version, fail_closed)| {
                Ok((
                    ProfileId::parse(&profile).map_err(|_| StoreError::Corrupt)?,
                    GatewaySession {
                        port: u16::try_from(port).map_err(|_| StoreError::Corrupt)?,
                        proxy_id: ProxyId::parse(&proxy).map_err(|_| StoreError::Corrupt)?,
                        proxy_version: version,
                        fail_closed: fail_closed == 1,
                    },
                ))
            })
            .collect()
    }

    /// The location a profile's proxy exited from at its last successful open (ADR-0029).
    pub fn profile_location(
        &self,
        profile: &ProfileId,
    ) -> Result<Option<ProfileLocation>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select egress_ip, country, city, timezone, seen_at from profile_locations where profile_id = ?1",
        )?;
        Ok(stmt
            .query_row([profile.as_str()], |r| {
                Ok(ProfileLocation {
                    egress_ip: r.get(0)?,
                    country: r.get(1)?,
                    city: r.get(2)?,
                    timezone: r.get(3)?,
                    seen_at: r.get(4)?,
                })
            })
            .optional()?)
    }

    /// Remembers where a profile's proxy exited (replacing the previous location). An empty `seen_at` means now;
    /// otherwise it must be a store timestamp (a location carried in a backup keeps the time it was seen). The values
    /// are held to the same shapes as a check's by the table.
    pub fn set_profile_location(
        &self,
        profile: &ProfileId,
        location: &ProfileLocation,
    ) -> Result<ProfileLocation, StoreError> {
        if location.egress_ip.is_none() && location.country.is_none() {
            return Err(StoreError::Invalid(
                "a location needs an address or a country",
            ));
        }
        if !location.seen_at.is_empty() && !valid_timestamp(&location.seen_at) {
            return Err(StoreError::Invalid("not a timestamp"));
        }
        self.w()?.execute(
            "insert or replace into profile_locations (profile_id, egress_ip, country, city, timezone, seen_at)
             values (?1, ?2, ?3, ?4, ?5, coalesce(?6, strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
            params![
                profile.as_str(),
                location.egress_ip,
                location.country,
                location.city,
                location.timezone,
                Some(location.seen_at.as_str()).filter(|s| !s.is_empty()),
            ],
        )?;
        self.profile_location(profile)?.ok_or(StoreError::Corrupt)
    }

    pub fn clear_profile_location(&self, profile: &ProfileId) -> Result<(), StoreError> {
        self.w()?.execute(
            "delete from profile_locations where profile_id = ?1",
            [profile.as_str()],
        )?;
        Ok(())
    }

    pub fn clear_gateway_session(&self, profile: &ProfileId) -> Result<(), StoreError> {
        self.w()?.execute(
            "delete from gateway_sessions where profile_id = ?1",
            [profile.as_str()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert!(valid_timestamp("2026-10-16T09:30:00.123Z"));
        assert!(valid_timestamp("2026-10-16T09:30:00Z"));
        for bad in [
            "2026-10-16",
            "2026-10-16 09:30:00Z",
            "2026-10-16T09:30:00",
            "2026-10-16T09:30:0x.1Z",
            "",
        ] {
            assert!(!valid_timestamp(bad), "{bad}");
        }
    }

    #[test]
    fn dates() {
        assert!(valid_date("2026-12-31"));
        for bad in ["2026-13-01", "26-12-31", "2026/12/31", "2026-12-32", "x"] {
            assert!(!valid_date(bad), "{bad}");
        }
    }
}
