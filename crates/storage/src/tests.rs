use super::*;
use serde_json::json;

fn id(n: u32) -> ProfileId {
    ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn wal_foreign_keys_search_and_process_tracking() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    assert_eq!(store.journal_mode()?, "wal");
    assert!(store.foreign_keys_enabled()?);
    assert_eq!(store.schema_version()?, SCHEMA_VERSION);
    assert!(store.integrity_ok()?);

    let ws = store.create_workspace("Agency")?;
    let other = store.create_workspace("Other")?;
    let a = id(1);
    store.insert_profile(NewProfile {
        id: &a,
        workspace_id: Some(&ws.id),
        name: "Shop admin",
        client_label: Some("North"),
        folder_label: None,
    })?;
    store.insert_profile(NewProfile {
        id: &id(2),
        workspace_id: Some(&ws.id),
        name: "Ads",
        client_label: Some("South_1"),
        folder_label: None,
    })?;
    store.insert_profile(NewProfile {
        id: &id(3),
        workspace_id: Some(&other.id),
        name: "Elsewhere north",
        client_label: None,
        folder_label: None,
    })?;
    assert_eq!(
        store
            .search_profiles(Some(&ws.id), Some("north"), 10)?
            .len(),
        1
    );
    assert_eq!(store.search_profiles(None, Some("north"), 10)?.len(), 2);
    assert_eq!(
        store.search_profiles(Some(&ws.id), Some("_"), 10)?.len(),
        1,
        "LIKE wildcards are escaped"
    );
    assert_eq!(store.profile_count(Some(&ws.id))?, 2);

    store.record_process(&a, 4242, Some(1_700_000_000), Some("/opt/rt/chromium"))?;
    assert_eq!(
        store.get_profile(&a)?.and_then(|p| p.running_pid),
        Some(4242)
    );
    let tracked = store.list_processes()?;
    assert_eq!(tracked.len(), 1);
    assert_eq!(tracked[0].process_start_time, Some(1_700_000_000));
    store.clear_process(&a)?;
    assert_eq!(store.get_profile(&a)?.and_then(|p| p.running_pid), None);
    Ok(())
}

#[test]
fn foreign_keys_are_enforced() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let bogus = WorkspaceId::generate().map_err(|_| StoreError::Corrupt)?;
    let result = store.insert_profile(NewProfile {
        id: &id(9),
        workspace_id: Some(&bogus),
        name: "x",
        client_label: None,
        folder_label: None,
    });
    assert!(
        matches!(result, Err(StoreError::Sql(_))),
        "profile in a missing workspace must be rejected"
    );
    Ok(())
}

#[test]
fn profile_update_uses_versions() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let ws = store.create_workspace("W")?;
    let p = store.insert_profile(NewProfile {
        id: &id(1),
        workspace_id: Some(&ws.id),
        name: "Old",
        client_label: Some("C"),
        folder_label: None,
    })?;
    let updated = store.update_profile(
        &p.id,
        ProfileUpdate {
            name: Some("New"),
            client_label: Some(None),
            notes: Some("hello"),
        },
        1,
    )?;
    assert_eq!(
        (updated.name.as_str(), updated.client_label, updated.version),
        ("New", None, 2)
    );
    assert_eq!(
        store.search_profiles(None, Some("new"), 5)?.len(),
        1,
        "search text follows renames"
    );
    let stale = store.update_profile(
        &p.id,
        ProfileUpdate {
            notes: Some("late"),
            ..Default::default()
        },
        1,
    );
    assert!(matches!(
        stale,
        Err(StoreError::VersionConflict { current: 2 })
    ));
    Ok(())
}

#[test]
fn limits_are_clamped() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let ids: Vec<ProfileId> = (0..150).map(id).collect();
    let rows: Vec<NewProfile<'_>> = ids
        .iter()
        .map(|i| NewProfile {
            id: i,
            workspace_id: None,
            name: "p",
            client_label: None,
            folder_label: None,
        })
        .collect();
    store.insert_profiles(&rows)?;
    assert_eq!(store.search_profiles(None, None, 10_000)?.len(), 100);
    assert_eq!(store.search_profiles(None, None, 0)?.len(), 1);
    Ok(())
}

#[test]
fn refuses_a_newer_schema() -> Result<(), StoreError> {
    let dir = tmp();
    let path = dir.path().join("local.db");
    Connection::open(&path)?.pragma_update(None, "user_version", 99)?;
    assert!(matches!(
        LocalStore::open(&path),
        Err(StoreError::TooNew { .. })
    ));
    Ok(())
}

/// Builds a v1 database exactly as milestone 01 shipped it, with one profile and one tracked process.
fn make_v1(path: &Path) -> Result<(), StoreError> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    let tx = conn.transaction()?;
    (migrations::MIGRATIONS[0].2)(&tx)?;
    tx.execute(
        "insert into profiles (id, name, search_text) values ('prf_01J9ZSEED0A010000000000000', 'Legacy', 'legacy')",
        [],
    )?;
    tx.pragma_update(None, "user_version", 1)?;
    tx.commit()?;
    Ok(())
}

#[test]
fn upgrade_from_v1_backs_up_and_moves_profiles_into_a_workspace() -> Result<(), StoreError> {
    let dir = tmp();
    let path = dir.path().join("local.db");
    make_v1(&path)?;
    let store = LocalStore::open(&path)?;
    assert_eq!(store.schema_version()?, 2);
    assert!(
        dir.path().join("local.db.v1.bak").is_file(),
        "backup written before upgrading"
    );
    let workspaces = store.list_workspaces()?;
    assert_eq!(workspaces.len(), 1);
    let legacy = store.search_profiles(None, Some("legacy"), 5)?;
    assert_eq!(
        legacy.first().and_then(|p| p.workspace_id.clone()),
        Some(workspaces[0].id.clone())
    );
    Ok(())
}

#[test]
fn failed_migration_keeps_the_previous_database_and_can_recover() -> Result<(), StoreError> {
    let dir = tmp();
    let path = dir.path().join("local.db");
    make_v1(&path)?;

    // A failure (or a kill) inside the upgrade must leave the v1 database untouched.
    let failed = LocalStore::open_simulating_failure(&path, 2);
    let Err(StoreError::MigrationFailed(failure)) = failed else {
        panic!("expected a migration failure")
    };
    assert_eq!((failure.from, failure.to), (1, 2));
    let backup = failure
        .backup
        .clone()
        .unwrap_or_else(|| panic!("backup path expected"));
    {
        let conn = Connection::open(&path)?;
        assert_eq!(
            migrations::current_version(&conn)?,
            1,
            "previous schema retained"
        );
        let n: i64 = conn.query_row("select count(*) from profiles", [], |r| r.get(0))?;
        assert_eq!(n, 1, "previous data retained");
        let has_ws: i64 = conn.query_row(
            "select count(*) from sqlite_master where name = 'workspaces'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(has_ws, 0, "no partial schema left behind");
    }

    // Recovery action 1: retry succeeds once the cause is gone.
    let store = LocalStore::open(&path)?;
    assert_eq!(store.schema_version()?, 2);
    drop(store);

    // Recovery action 2: restoring the pre-upgrade backup returns to the exact v1 state.
    LocalStore::restore_backup(&path, &backup)?;
    let conn = Connection::open(&path)?;
    assert_eq!(migrations::current_version(&conn)?, 1);
    Ok(())
}

#[test]
fn device_is_created_once() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let a = store.ensure_device("macos-arm64", "aarch64")?;
    let b = store.ensure_device("macos-arm64", "aarch64")?;
    assert_eq!(a, b);
    assert_eq!(a.installation_id.len(), 32);
    Ok(())
}

#[test]
fn settings_allowlist_defaults_and_versions() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let theme = store.get_setting(settings::THEME)?;
    assert_eq!((theme.value.clone(), theme.version), (json!("system"), 0));

    let set = store.set_setting(settings::THEME, &json!("dark"), true, Some(0))?;
    assert_eq!((set.value, set.version), (json!("dark"), 1));
    assert!(matches!(
        store.set_setting(settings::THEME, &json!("light"), true, Some(0)),
        Err(StoreError::VersionConflict { current: 1 })
    ));
    assert!(matches!(
        store.set_setting("os.exec", &json!("x"), true, None),
        Err(StoreError::Setting(SettingError::UnknownKey))
    ));
    assert!(matches!(
        store.set_setting(settings::DOWNLOAD_DIR, &json!("/tmp"), true, None),
        Err(StoreError::Setting(SettingError::NotUiSettable))
    ));
    assert_eq!(store.get_settings()?.len(), settings::SETTINGS.len());
    Ok(())
}

#[test]
fn runtimes_and_timings() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    store.upsert_runtime(&RuntimeInstallation {
        version: "153.0.1".into(),
        platform: "macos-arm64".into(),
        digest: "a".repeat(64),
        verified_at: None,
        path: "/x".into(),
        status: "quarantined".into(),
    })?;
    assert_eq!(store.list_runtimes()?[0].status, "quarantined");
    for ms in [10.0, 20.0, 30.0, 40.0, 1000.0] {
        store.record_timing("manager_startup", ms)?;
    }
    let s = store.timing_summary("manager_startup")?;
    assert_eq!(
        (s.count, s.last_ms, s.p50_ms),
        (5, Some(1000.0), Some(30.0))
    );
    Ok(())
}

#[test]
fn auth_transactions_are_one_time() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    store.begin_auth_transaction("state-abcdefghijklmnop", 300)?;
    assert_eq!(
        store.consume_auth_transaction("state-abcdefghijklmnop")?,
        Ok(())
    );
    assert_eq!(
        store.consume_auth_transaction("state-abcdefghijklmnop")?,
        Err(AuthTxError::Replayed)
    );
    assert_eq!(
        store.consume_auth_transaction("never-issued-state-0000")?,
        Err(AuthTxError::Unknown)
    );
    store.begin_auth_transaction("expired-state-000000000", 0)?;
    assert_eq!(
        store.consume_auth_transaction("expired-state-000000000")?,
        Err(AuthTxError::Expired)
    );
    Ok(())
}
