//! Milestone 05: proxies, per-profile routing, connectivity checks, gateway sessions, privacy settings.

use super::*;
use crate::bulk::BulkOp;
use crate::network::{GatewaySession, NewProxy, ProxyChanges};
use crate::query::{ProfileFilter, Sort};
use pb_runtime::{PrivacyConfig, ProxyGeo, ProxyId, WebRtcPolicy};

fn pid(n: u32) -> ProfileId {
    ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
}

fn xid(n: u32) -> ProxyId {
    ProxyId::parse(&format!("prx_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
}

fn open() -> Result<(tempfile::TempDir, LocalStore, Workspace), StoreError> {
    let dir = tempfile::tempdir()?;
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let ws = store.create_workspace("Agency")?;
    Ok((dir, store, ws))
}

fn proxy<'a>(ws: &'a Workspace, n: u32, name: &'a str, login: bool) -> NewProxy<'a> {
    NewProxy {
        id: xid(n),
        workspace_id: &ws.id,
        name,
        kind: "socks5",
        host: "proxy.example",
        port: 1080,
        credential_ref: login.then_some(if n == 1 {
            "proxy:prx_01J9ZSEED00000000000000001"
        } else {
            "proxy:prx_01J9ZSEED00000000000000002"
        }),
        expires_at: Some("2026-12-31"),
        notes: "",
    }
}

#[test]
fn upgrade_from_v4_keeps_profiles_and_defaults_routing() -> Result<(), StoreError> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("local.db");
    {
        let mut conn = Connection::open(&path)?;
        let tx = conn.transaction()?;
        for (_, _, step) in &migrations::MIGRATIONS[..4] {
            step(&tx)?;
        }
        tx.pragma_update(None, "user_version", 4)?;
        tx.execute(
            "insert into workspaces (id, name) values ('wsp_01J9ZSEED0A010000000000000', 'W')",
            [],
        )?;
        tx.execute(
            "insert into profiles (id, workspace_id, name, search_text, data_dir_ref)
             values (?1, 'wsp_01J9ZSEED0A010000000000000', 'Old', 'old', ?1)",
            [pid(1).as_str()],
        )?;
        tx.execute(
            "insert into audit_log (profile_id, action, outcome) values (?1, 'start', 'ok')",
            [pid(1).as_str()],
        )?;
        tx.commit()?;
    }
    let store = LocalStore::open(&path)?;
    let p = store.get_profile(&pid(1))?.ok_or(StoreError::NotFound)?;
    assert_eq!(
        (p.proxy_id, p.proxy_label, p.fail_closed),
        (None, None, true)
    );
    assert_eq!(p.privacy, PrivacyConfig::default());
    assert_eq!(store.list_audit(None, 10)?.len(), 1, "audit history kept");
    store.audit(None, "proxy", "created", None, None)?;
    Ok(())
}

#[test]
fn proxies_keep_metadata_only_and_cannot_vanish_from_under_a_profile() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let p = store.create_proxy(proxy(&ws, 1, "Residential DE", true))?;
    assert_eq!((p.kind.as_str(), p.port, p.profiles), ("socks5", 1080, 0));
    assert_eq!(
        p.credential_ref.as_deref(),
        Some("proxy:prx_01J9ZSEED00000000000000001")
    );
    assert!(matches!(
        store.create_proxy(proxy(&ws, 2, "residential de ", false)),
        Err(StoreError::Duplicate)
    ));
    for bad in [
        NewProxy {
            kind: "socks4",
            ..proxy(&ws, 3, "x", false)
        },
        NewProxy {
            expires_at: Some("31.12.2026"),
            ..proxy(&ws, 3, "y", false)
        },
        NewProxy {
            name: " ",
            ..proxy(&ws, 3, "z", false)
        },
    ] {
        assert!(matches!(
            store.create_proxy(bad),
            Err(StoreError::Invalid(_))
        ));
    }
    // Assign it to a profile through the profile's own optimistic version.
    store.insert_profile(NewProfile::basic(pid(1), Some(ws.id.clone()), "Shop", None))?;
    let before = store.get_profile(&pid(1))?.ok_or(StoreError::NotFound)?;
    let after = store.update_profile(
        &pid(1),
        ProfileUpdate {
            network: Some((Some(&xid(1)), true)),
            ..Default::default()
        },
        before.version,
    )?;
    assert_eq!(after.proxy_id, Some(xid(1)));
    assert_eq!(after.proxy_label.as_deref(), Some("Residential DE"));
    assert!(after.network_config_version > before.network_config_version);
    assert!(matches!(
        store.delete_proxy(&xid(1)),
        Err(StoreError::InUse(1))
    ));
    assert_eq!(store.profiles_using_proxy(&xid(1))?, vec![pid(1)]);
    // Renaming shows through, and the version guards concurrent edits.
    let renamed = store.update_proxy(
        &xid(1),
        p.version,
        ProxyChanges {
            name: Some("DE · residential"),
            credential_ref: Some(None),
            ..Default::default()
        },
    )?;
    assert_eq!(renamed.credential_ref, None);
    assert!(matches!(
        store.update_proxy(&xid(1), p.version, ProxyChanges::default()),
        Err(StoreError::VersionConflict { .. })
    ));
    assert_eq!(
        store
            .get_profile(&pid(1))?
            .and_then(|p| p.proxy_label)
            .as_deref(),
        Some("DE · residential")
    );
    // Filter by proxy, then unassign and delete.
    let page = store.query_profiles(
        &ProfileFilter {
            workspace: Some(ws.id.clone()),
            proxy: Some(xid(1)),
            ..Default::default()
        },
        Sort::default(),
        0,
        10,
    )?;
    assert_eq!(page.total, 1);
    store.update_profile(
        &pid(1),
        ProfileUpdate {
            network: Some((None, true)),
            ..Default::default()
        },
        after.version,
    )?;
    store.delete_proxy(&xid(1))?;
    assert!(store.get_proxy(&xid(1))?.is_none());
    Ok(())
}

#[test]
fn a_proxy_of_another_workspace_cannot_be_assigned() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let other = store.create_workspace("Other")?;
    store.create_proxy(proxy(&other, 1, "Elsewhere", false))?;
    store.insert_profile(NewProfile::basic(pid(1), Some(ws.id.clone()), "Shop", None))?;
    let r = store.update_profile(
        &pid(1),
        ProfileUpdate {
            network: Some((Some(&xid(1)), true)),
            ..Default::default()
        },
        1,
    );
    assert!(matches!(r, Err(StoreError::NotFound)));
    assert_eq!(
        store.get_profile(&pid(1))?.map(|p| p.version),
        Some(1),
        "nothing was written"
    );
    Ok(())
}

#[test]
fn bulk_proxy_assignment_reports_and_undoes() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    store.create_proxy(proxy(&ws, 1, "A", false))?;
    for n in 1..=3 {
        store.insert_profile(NewProfile::basic(
            pid(n),
            Some(ws.id.clone()),
            &format!("P{n}"),
            None,
        ))?;
    }
    let op = BulkOp::SetProxy {
        proxy_id: Some(xid(1)),
        fail_closed: true,
    };
    let ids = [pid(1), pid(2), pid(3)];
    let results = store.bulk_apply(&ws.id, &ids, &op, &|| false)?;
    assert!(
        results
            .iter()
            .all(|r| matches!(r.outcome, bulk::ItemOutcome::Changed { .. }))
    );
    assert_eq!(store.get_proxy(&xid(1))?.map(|p| p.profiles), Some(3));
    let again = store.bulk_apply(&ws.id, &ids, &op, &|| false)?;
    assert!(
        again
            .iter()
            .all(|r| r.outcome == bulk::ItemOutcome::Unchanged)
    );
    assert_eq!(store.bulk_undo(&op, &results)?, (3, 0));
    assert_eq!(store.get_proxy(&xid(1))?.map(|p| p.profiles), Some(0));
    Ok(())
}

#[test]
fn checks_are_recorded_listed_and_expire_after_seven_days() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    store.create_proxy(proxy(&ws, 1, "A", false))?;
    let berlin = ProxyGeo {
        country: Some("DE".into()),
        city: Some("Berlin".into()),
        timezone: Some("Europe/Berlin".into()),
        language: Some("de-DE".into()),
        latitude: Some(52.52),
        longitude: Some(13.41),
    };
    let good = store.record_check(
        &xid(1),
        None,
        Some(120),
        Some("198.51.100.7"),
        Some(&berlin),
    )?;
    assert_eq!(good.geo.as_ref(), Some(&berlin));
    assert_eq!(
        store
            .get_proxy(&xid(1))?
            .and_then(|p| p.last_check)
            .and_then(|c| c.geo),
        Some(berlin.clone())
    );
    let failed = store.record_check(&xid(1), Some("PROXY_AUTH_FAILED"), None, None, None)?;
    assert_eq!(failed.geo, None);
    // The table holds location values to the same shapes the check parser accepts.
    for bad in [
        ProxyGeo {
            timezone: Some("Europe/Berlin; rm".into()),
            ..Default::default()
        },
        ProxyGeo {
            language: Some("de-DE --x".into()),
            ..Default::default()
        },
        ProxyGeo {
            country: Some("de".into()),
            ..Default::default()
        },
        ProxyGeo {
            latitude: Some(91.0),
            ..Default::default()
        },
    ] {
        assert!(
            store
                .record_check(&xid(1), None, Some(1), None, Some(&bad))
                .is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(
        (failed.result.as_str(), failed.error_code.as_deref()),
        ("error", Some("PROXY_AUTH_FAILED"))
    );
    let p = store.get_proxy(&xid(1))?.ok_or(StoreError::NotFound)?;
    assert_eq!(p.last_check.map(|c| c.id), Some(failed.id));
    assert_eq!(store.list_checks(&xid(1), 10)?.len(), 2);
    store.w()?.execute(
        "update network_checks set checked_at = '2000-01-01T00:00:00.000Z' where result = 'ok'",
        [],
    )?;
    assert_eq!(store.purge_checks()?, 1);
    let left = store.list_checks(&xid(1), 10)?;
    assert_eq!(left.len(), 1);
    assert!(
        left.iter().all(|c| c.egress_ip.is_none()),
        "the old exit address is gone"
    );
    Ok(())
}

#[test]
fn gateway_sessions_and_privacy_settings_persist() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    store.create_proxy(proxy(&ws, 1, "A", false))?;
    store.insert_profile(NewProfile::basic(pid(1), Some(ws.id.clone()), "Shop", None))?;
    let s = GatewaySession {
        port: 41000,
        proxy_id: xid(1),
        proxy_version: 1,
        fail_closed: false,
    };
    store.set_gateway_session(&pid(1), &s)?;
    assert_eq!(store.gateway_session(&pid(1))?, Some(s.clone()));
    assert_eq!(store.gateway_sessions()?, vec![(pid(1), s)]);
    store.clear_gateway_session(&pid(1))?;
    assert_eq!(store.gateway_session(&pid(1))?, None);
    let privacy = PrivacyConfig {
        webrtc: WebRtcPolicy::PublicInterfaceOnly,
        language: Some("ne-NP".into()),
        timezone: Some("Asia/Kathmandu".into()),
        ..Default::default()
    };
    let p = store.update_profile(
        &pid(1),
        ProfileUpdate {
            privacy: Some(&privacy),
            ..Default::default()
        },
        1,
    )?;
    assert_eq!(p.privacy, privacy);
    // Unknown keys in the stored document are treated as damage, not silently dropped.
    store.w()?.execute(
        "update profiles set privacy_json = '{\"canvas_noise\":true}'",
        [],
    )?;
    assert!(matches!(
        store.get_profile(&pid(1)),
        Err(StoreError::Corrupt)
    ));
    Ok(())
}

#[test]
fn upgrade_from_v12_keeps_checks_without_a_location() -> Result<(), StoreError> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("local.db");
    {
        let mut conn = Connection::open(&path)?;
        let tx = conn.transaction()?;
        for (_, _, step) in &migrations::MIGRATIONS[..12] {
            step(&tx)?;
        }
        tx.pragma_update(None, "user_version", 12)?;
        tx.execute(
            "insert into workspaces (id, name) values ('wsp_01J9ZSEED0A010000000000000', 'W')",
            [],
        )?;
        tx.execute(
            "insert into proxy_configs (id, workspace_id, name, name_key, type, host, port)
             values (?1, 'wsp_01J9ZSEED0A010000000000000', 'P', 'p', 'http', 'proxy.example', 3128)",
            [xid(1).as_str()],
        )?;
        tx.execute(
            "insert into network_checks (id, proxy_id, result, latency_ms, egress_ip)
             values ('nck_01J9ZSEED0A010000000000000', ?1, 'ok', 50, '198.51.100.7')",
            [xid(1).as_str()],
        )?;
        tx.commit()?;
    }
    let store = LocalStore::open(&path)?;
    assert_eq!(store.schema_version()?, migrations::SCHEMA_VERSION);
    let checks = store.list_checks(&xid(1), 10)?;
    assert_eq!(checks.len(), 1);
    assert_eq!(
        (checks[0].egress_ip.as_deref(), checks[0].geo.as_ref()),
        (Some("198.51.100.7"), None)
    );
    Ok(())
}

#[test]
fn upgrade_from_v13_adds_remembered_locations_with_the_check_shapes() -> Result<(), StoreError> {
    use crate::network::ProfileLocation;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("local.db");
    {
        let mut conn = Connection::open(&path)?;
        let tx = conn.transaction()?;
        for (_, _, step) in &migrations::MIGRATIONS[..13] {
            step(&tx)?;
        }
        tx.pragma_update(None, "user_version", 13)?;
        tx.execute(
            "insert into workspaces (id, name) values ('wsp_01J9ZSEED0A010000000000000', 'W')",
            [],
        )?;
        tx.execute(
            "insert into profiles (id, workspace_id, name, search_text, data_dir_ref)
             values (?1, 'wsp_01J9ZSEED0A010000000000000', 'Old', 'old', ?1)",
            [pid(1).as_str()],
        )?;
        tx.commit()?;
    }
    let store = LocalStore::open(&path)?;
    assert_eq!(store.schema_version()?, migrations::SCHEMA_VERSION);
    // Existing profiles have no remembered location: their next open records one.
    assert_eq!(store.profile_location(&pid(1))?, None);
    let ny = ProfileLocation {
        egress_ip: Some("198.51.100.7".into()),
        country: Some("US".into()),
        city: Some("New York".into()),
        timezone: Some("America/New_York".into()),
        seen_at: String::new(),
    };
    let saved = store.set_profile_location(&pid(1), &ny)?;
    assert!(crate::network::valid_timestamp(&saved.seen_at), "{saved:?}");
    assert_eq!(
        ProfileLocation {
            seen_at: String::new(),
            ..saved.clone()
        },
        ny
    );
    // Replaced, never duplicated; a carried location keeps the time it was seen.
    let berlin = ProfileLocation {
        egress_ip: Some("203.0.113.9".into()),
        country: Some("DE".into()),
        city: Some("Berlin".into()),
        timezone: Some("Europe/Berlin".into()),
        seen_at: "2026-10-01T08:00:00.000Z".into(),
    };
    assert_eq!(store.set_profile_location(&pid(1), &berlin)?, berlin);
    // The table holds the values to the check's shapes; nothing else gets in.
    for bad in [
        ProfileLocation {
            country: Some("us".into()),
            ..berlin.clone()
        },
        ProfileLocation {
            timezone: Some("../../etc".into()),
            ..berlin.clone()
        },
        ProfileLocation {
            egress_ip: None,
            country: None,
            ..berlin.clone()
        },
        ProfileLocation {
            seen_at: "yesterday".into(),
            ..berlin.clone()
        },
    ] {
        assert!(
            store.set_profile_location(&pid(1), &bad).is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(store.profile_location(&pid(1))?, Some(berlin));
    // Deleted with the profile.
    store
        .w()?
        .execute("delete from profiles where id = ?1", [pid(1).as_str()])?;
    assert_eq!(store.profile_location(&pid(1))?, None);
    store.clear_profile_location(&pid(1))?;
    Ok(())
}
