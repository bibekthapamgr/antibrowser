use super::*;
use pb_runtime::{PermissionDefault, RunState};
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
    let north = store.ensure_client(&ws.id, "North")?;
    let south = store.ensure_client(&ws.id, "South_1")?;
    store.insert_profile(NewProfile::basic(
        a.clone(),
        Some(ws.id.clone()),
        "Shop admin",
        Some(north),
    ))?;
    store.insert_profile(NewProfile::basic(
        id(2),
        Some(ws.id.clone()),
        "Ads",
        Some(south),
    ))?;
    store.insert_profile(NewProfile::basic(
        id(3),
        Some(other.id.clone()),
        "Elsewhere north",
        None,
    ))?;
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

    let identity = runs::StartIdentity {
        start_time: Some(1_700_000_000),
        exe: Some("/opt/rt/chromium".into()),
    };
    let run = store.begin_run(&a, 4242, &identity, Some("155.0.1.2"), RunState::Starting)?;
    let p = store.get_profile(&a)?.ok_or(StoreError::NotFound)?;
    assert_eq!((p.running_pid, p.state), (Some(4242), RunState::Starting));
    assert_eq!(p.active_run_id.as_deref(), Some(run.as_str()));
    assert_eq!(p.runtime_version.as_deref(), Some("155.0.1.2"));
    let active = store.active_runs()?;
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].identity, identity);
    assert!(
        store
            .begin_run(&a, 4243, &identity, None, RunState::Starting)
            .is_err(),
        "at most one active run per profile"
    );
    store.end_run(
        &run,
        runs::RunOutcome::Clean,
        Some(0),
        RunState::Stopped,
        None,
    )?;
    let p = store.get_profile(&a)?.ok_or(StoreError::NotFound)?;
    assert_eq!((p.running_pid, p.state), (None, RunState::Stopped));
    assert!(p.last_clean_shutdown_at.is_some());
    Ok(())
}

#[test]
fn foreign_keys_are_enforced() -> Result<(), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let bogus = WorkspaceId::generate().map_err(|_| StoreError::Corrupt)?;
    let result = store.insert_profile(NewProfile::basic(id(9), Some(bogus), "x", None));
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
    let c = store.ensure_client(&ws.id, "C")?;
    let p = store.insert_profile(NewProfile::basic(
        id(1),
        Some(ws.id.clone()),
        "Old",
        Some(c),
    ))?;
    let updated = store.update_profile(
        &p.id,
        ProfileUpdate {
            name: Some("New"),
            client_id: Some(None),
            notes: Some("hello"),
            ..ProfileUpdate::default()
        },
        1,
    )?;
    assert_eq!(
        (updated.name.as_str(), updated.client_id, updated.version),
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
    let rows: Vec<NewProfile> = (0..150)
        .map(|n| NewProfile::basic(id(n), None, "p", None))
        .collect();
    store.insert_profiles(&rows)?;
    assert_eq!(store.search_profiles(None, None, 100)?.len(), 100);
    assert_eq!(store.search_profiles(None, None, u32::MAX)?.len(), 150);
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
    assert_eq!(store.schema_version()?, SCHEMA_VERSION);
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
    assert_eq!(store.schema_version()?, SCHEMA_VERSION);
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
        distribution: Some("chrome-for-testing".into()),
        executable: Some("chrome/chrome".into()),
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

/// A v2 database (milestone 02) with a tracked running browser upgrades to v3 with an active run.
#[test]
fn upgrade_from_v2_converts_tracked_processes_into_runs() -> Result<(), StoreError> {
    let dir = tmp();
    let path = dir.path().join("local.db");
    {
        let mut conn = Connection::open(&path)?;
        let tx = conn.transaction()?;
        (migrations::MIGRATIONS[0].2)(&tx)?;
        (migrations::MIGRATIONS[1].2)(&tx)?;
        tx.execute(
            "insert into workspaces (id, name) values ('wsp_01J9ZSEED0A010000000000000', 'W')",
            [],
        )?;
        tx.execute(
            "insert into profiles (id, workspace_id, name, search_text)
             values ('prf_01J9ZSEED0A010000000000000', 'wsp_01J9ZSEED0A010000000000000', 'Legacy', 'legacy')",
            [],
        )?;
        tx.execute(
            "insert into processes (profile_id, pid, process_start_time, executable)
             values ('prf_01J9ZSEED0A010000000000000', 777, 1700000000, '/rt/chrome')",
            [],
        )?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }
    let store = LocalStore::open(&path)?;
    assert!(dir.path().join("local.db.v2.bak").is_file());
    let runs = store.active_runs()?;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].pid, 777);
    assert_eq!(runs[0].identity.start_time, Some(1_700_000_000));
    let p = store
        .get_profile(&runs[0].profile_id)?
        .ok_or(StoreError::NotFound)?;
    assert_eq!(p.state, RunState::Running);
    assert_eq!(p.data_dir_ref, p.id.as_str());
    assert_eq!(p.camera, PermissionDefault::Ask);
    assert!(p.start_urls.is_empty());
    Ok(())
}

fn store_with_profile() -> Result<(tempfile::TempDir, LocalStore, ProfileId), StoreError> {
    let dir = tmp();
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let ws = store.create_workspace("W")?;
    let p = id(5);
    store.insert_profile(NewProfile::basic(p.clone(), Some(ws.id.clone()), "P", None))?;
    Ok((dir, store, p))
}

#[test]
fn profile_settings_are_typed_and_versioned() -> Result<(), StoreError> {
    let (_d, store, p) = store_with_profile()?;
    let urls = vec![
        "https://a.test/".to_string(),
        "https://b.test/x".to_string(),
    ];
    let updated = store.update_profile(
        &p,
        ProfileUpdate {
            favourite: Some(true),
            start_urls: Some(&urls),
            download_dir: Some(Some("/downloads/a")),
            camera: Some(PermissionDefault::Block),
            location: Some(PermissionDefault::Allow),
            ..ProfileUpdate::default()
        },
        1,
    )?;
    assert!(updated.favourite);
    assert_eq!(updated.start_urls, urls);
    assert_eq!(updated.camera, PermissionDefault::Block);
    assert_eq!(updated.microphone, PermissionDefault::Ask);
    assert_eq!(updated.version, 2);
    let cleared = store.update_profile(
        &p,
        ProfileUpdate {
            favourite: Some(false),
            download_dir: Some(None),
            ..ProfileUpdate::default()
        },
        2,
    )?;
    assert_eq!((cleared.favourite, cleared.download_dir), (false, None));
    Ok(())
}

#[test]
fn crash_counter_and_audit_log() -> Result<(), StoreError> {
    let (_d, store, p) = store_with_profile()?;
    let ident = runs::StartIdentity::default();
    for _ in 0..2 {
        let run = store.begin_run(&p, 1, &ident, None, RunState::Starting)?;
        store.end_run(
            &run,
            runs::RunOutcome::Crashed,
            Some(-11),
            RunState::Crashed,
            Some("CRASHED"),
        )?;
    }
    let crashed = store.get_profile(&p)?.ok_or(StoreError::NotFound)?;
    assert_eq!((crashed.crash_count, crashed.state), (2, RunState::Crashed));
    assert_eq!(crashed.last_error.as_deref(), Some("CRASHED"));
    let run = store.begin_run(&p, 2, &ident, None, RunState::Starting)?;
    assert_eq!(
        store.get_profile(&p)?.and_then(|x| x.last_error),
        None,
        "a new start clears the error"
    );
    store.end_run(
        &run,
        runs::RunOutcome::Clean,
        Some(0),
        RunState::Stopped,
        None,
    )?;
    store.end_run(
        &run,
        runs::RunOutcome::Crashed,
        None,
        RunState::Crashed,
        None,
    )?;
    let p2 = store.get_profile(&p)?.ok_or(StoreError::NotFound)?;
    assert_eq!(
        (p2.crash_count, p2.state),
        (0, RunState::Stopped),
        "ending twice is a no-op"
    );
    assert_eq!(store.runs_for(&p, 10)?.len(), 3);

    store.audit(Some(&p), "start", "ok", Some(&run), None)?;
    store.audit(Some(&p), "crash", "crashed", None, Some("EXITED_EARLY"))?;
    assert!(
        store.audit(Some(&p), "visit", "ok", None, None).is_err(),
        "unknown actions rejected"
    );
    let log = store.list_audit(Some(&p), 10)?;
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].action, "crash");
    Ok(())
}
