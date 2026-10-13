//! Milestone 07 desktop acceptance tests: organization backups through the real IPC commands, local database and
//! profile folders, with the in-memory server (`pb_sync::fake`) in place of the API and storage — the engine's own
//! tests kill the network and the app at every step; `e2e` tests in CI run the same flow against the real API and
//! S3-compatible storage.

mod support;

use pb_desktop_lib::operations::{OpKind, OpStatus};
use pb_desktop_lib::secrets::MemoryStore;
use pb_desktop_lib::supervisor::fake::FakeProcesses;
use pb_runtime::ProfileId;
use pb_storage::cloud as cs;
use pb_sync::Poll;
use pb_sync::fake::{FakeServer, When};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use support::*;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";
const PRF: &str = "prf_01J9ZSEED0A010000000000000";
const DEV_A: &str = "dev_01J9ZSEED0D1D1000000000000";
const DEV_B: &str = "dev_01J9ZSEED0D2D2000000000000";

fn user_data(f: &Fixture, id: &str) -> PathBuf {
    f.data().join("profiles").join(id).join("user-data")
}

fn sync_status(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_sync_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn pid(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap_or_else(|_| panic!("bad id {id}"))
}

/// Connects a fixture to the in-memory server as device `dev`.
fn connect(f: &Fixture, server: &Arc<FakeServer>, dev: &str) {
    let store = f.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    store
        .set_cloud_state(cs::DEVICE_ID, Some(dev))
        .unwrap_or_else(|e| panic!("{e}"));
    f.state
        .use_sync_backend(Arc::new(server.client(dev, &[ORG])));
    f.state.set_sync_poll(Poll {
        interval: Duration::from_millis(1),
        max_wait: Duration::from_millis(200),
    });
}

fn open(f: &Fixture, id: &str) {
    let op =
        invoke(f, "launch_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        wait_op(f, &op),
        pb_desktop_lib::operations::OpStatus::Succeeded
    );
}

fn close(f: &Fixture, id: &str, cookies: &[u8]) {
    let ud = user_data(f, id);
    std::fs::create_dir_all(ud.join("Default/Local Storage")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(ud.join("Default/Cookies"), cookies).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(ud.join("Default/Local Storage/site"), b"local-storage")
        .unwrap_or_else(|e| panic!("{e}"));
    let stop =
        invoke(f, "stop_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        wait_op(f, &stop),
        pb_desktop_lib::operations::OpStatus::Succeeded
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while invoke(f, "get_profile_status", json!({ "profileId": id }))
        .map(|s| s["profile"]["state"] != json!("stopped"))
        .unwrap_or(true)
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    // The routine last-good copy after a clean close holds the profile for a moment (longer on Windows). An
    // organization backup started meanwhile waits for it and is woken when it ends; these tests start after it, as a
    // person would see it: a copy exists and no backup of the profile is running.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let copying = f.state.ops.list().iter().any(|o| {
            o.kind == OpKind::BackupProfile
                && o.status == OpStatus::Running
                && o.target.as_deref() == Some(id)
        });
        let copied = invoke(f, "get_profile_status", json!({ "profileId": id }))
            .map(|s| !s["backup"].is_null())
            .unwrap_or(false);
        // A shared session's closing backup is queued once the browser's exit was seen.
        let settled = invoke(f, "get_team_status", json!({ "profileId": id }))
            .map(|t| t["phase"] != json!("running") && t["phase"] != json!("closing"))
            .unwrap_or(true);
        if (copied && !copying && settled) || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run(f: &Fixture, id: &str, cookies: &[u8]) {
    open(f, id);
    close(f, id, cookies);
}

fn team(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_team_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

/// A local profile that ran once and is linked to the organization profile.
fn linked_profile(f: &Fixture) -> String {
    let id = workspace_with_profile(f);
    run(f, &id, b"cookies-v1");
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .link_org_profiles(ORG, &[(pid(&id), PRF.into())])
        .unwrap_or_else(|e| panic!("{e}"));
    id
}

fn cookies(f: &Fixture, id: &str) -> Vec<u8> {
    std::fs::read(user_data(f, id).join("Default/Cookies")).unwrap_or_default()
}

#[test]
fn backups_after_a_clean_close_and_restore_with_evidence_kept() {
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let f = fixture();
    connect(&f, &server, DEV_A);
    let id = linked_profile(&f);
    let s = sync_status(&f, &id);
    assert_eq!(
        (
            s["linked"].clone(),
            s["dirty"].clone(),
            s["synced_version"].clone()
        ),
        (json!(true), json!(true), json!(0))
    );

    // Back up now.
    invoke(&f, "sync_backup_now", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(f.state.run_sync_jobs(), 1);
    let s = sync_status(&f, &id);
    assert_eq!(s["job"]["state"], json!("committed"), "{s}");
    assert_eq!(
        (s["synced_version"].clone(), s["dirty"].clone()),
        (json!(1), json!(false))
    );
    assert_eq!(server.committed(PRF).len(), 1);
    assert_eq!(
        dir_entries(&f.data().join("sync")),
        0,
        "no sealed file left"
    );
    let names = f.events.names();
    assert!(names.iter().any(|n| n == "sync"));

    // Opening it marks it changed; a clean close queues the automatic backup.
    run(&f, &id, b"cookies-v2");
    let s = sync_status(&f, &id);
    assert_eq!(s["job"]["state"], json!("local_dirty"), "{s}");
    f.state.run_sync_jobs();
    let s = sync_status(&f, &id);
    assert_eq!(
        (s["synced_version"].clone(), s["job"]["version"].clone()),
        (json!(2), json!(2))
    );

    // Damage the local copy, then restore the newest backup into it.
    std::fs::write(user_data(&f, &id).join("Default/Cookies"), b"damaged")
        .unwrap_or_else(|e| panic!("{e}"));
    invoke(
        &f,
        "sync_restore",
        json!({ "profileId": id, "asCopy": false }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(sync_status(&f, &id)["restoring"], json!(true));
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": id }))).as_deref(),
        Some("PROFILE_RESTORING")
    );
    f.state.run_sync_jobs();
    let s = sync_status(&f, &id);
    assert_eq!(s["job"]["state"], json!("done"), "{s}");
    assert_eq!(s["job"]["portability"], json!("supported"), "same device");
    assert_eq!(cookies(&f, &id), b"cookies-v2");
    assert!(!user_data(&f, &id).join("Default/Cache").exists());
    // The damaged data was kept as evidence, not deleted.
    let evidence = f.data().join("evidence").join(&id);
    let kept: Vec<_> = std::fs::read_dir(&evidence)
        .unwrap_or_else(|e| panic!("{e}"))
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with("cloud-restore"))
        .collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        std::fs::read(kept[0].path().join("user-data/Default/Cookies")).unwrap_or_default(),
        b"damaged"
    );
    assert!(
        !f.data()
            .join("profiles")
            .join(&id)
            .join("user-data.incoming")
            .exists()
    );
    assert_eq!(sync_status(&f, &id)["restoring"], json!(false));
    let op =
        invoke(&f, "launch_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        wait_op(&f, &op),
        pb_desktop_lib::operations::OpStatus::Succeeded
    );
}

#[test]
fn another_computer_restores_and_a_stale_computer_gets_the_newest_or_a_conflict_never_an_overwrite()
{
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let a = fixture();
    connect(&a, &server, DEV_A);
    let id_a = linked_profile(&a);
    let b = fixture();
    connect(&b, &server, DEV_B);
    invoke(&b, "create_workspace", json!({ "name": "Home" })).unwrap_or_else(|e| panic!("{e}"));
    // Nothing to restore yet: refused before any local profile is created.
    assert_eq!(
        code(&invoke(
            &b,
            "sync_restore_here",
            json!({ "orgId": ORG, "orgProfileId": PRF, "name": "Shop" })
        ))
        .as_deref(),
        Some("SYNC_NO_BACKUP")
    );
    assert_eq!(
        invoke(&b, "list_profiles", json!({}))
            .map(|l| l.as_array().map(Vec::len))
            .ok()
            .flatten(),
        Some(0)
    );
    invoke(&a, "sync_backup_now", json!({ "profileId": id_a })).unwrap_or_else(|e| panic!("{e}"));
    a.state.run_sync_jobs();
    assert_eq!(sync_status(&a, &id_a)["synced_version"], json!(1));

    // Computer B puts the organization profile on this computer.
    let view = invoke(
        &b,
        "sync_restore_here",
        json!({ "orgId": ORG, "orgProfileId": PRF, "name": "Shop" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let id_b = view["id"].as_str().unwrap_or_default().to_owned();
    // Asking twice does not create a second copy.
    assert_eq!(
        code(&invoke(
            &b,
            "sync_restore_here",
            json!({ "orgId": ORG, "orgProfileId": PRF, "name": "Again" })
        ))
        .as_deref(),
        Some("SYNC_ALREADY_HERE")
    );
    b.state.run_sync_jobs();
    let s = sync_status(&b, &id_b);
    assert_eq!(s["job"]["state"], json!("done"), "{s}");
    assert_eq!(
        s["job"]["portability"],
        json!("sign_in_required"),
        "another device"
    );
    assert_eq!(
        (
            s["linked"].clone(),
            s["synced_version"].clone(),
            s["dirty"].clone()
        ),
        (json!(true), json!(1), json!(false))
    );
    assert_eq!(cookies(&b, &id_b), b"cookies-v1");

    // B works and hands off version 2.
    run(&b, &id_b, b"cookies-from-b");
    b.state.run_sync_jobs();
    assert_eq!(sync_status(&b, &id_b)["synced_version"], json!(2));
    assert_eq!(team(&b, &id_b)["phase"], Value::Null, "handed off");

    // A, still based on version 1, opens it (milestone 08): the newest backup is put on A before the browser
    // starts, so A works on B's version. Nothing is overwritten and nothing is merged.
    open(&a, &id_a);
    assert_eq!(cookies(&a, &id_a), b"cookies-from-b");
    assert_eq!(sync_status(&a, &id_a)["synced_version"], json!(2));
    close(&a, &id_a, b"cookies-from-a");
    a.state.run_sync_jobs();
    let s = sync_status(&a, &id_a);
    assert_eq!(
        (s["synced_version"].clone(), s["dirty"].clone()),
        (json!(3), json!(false)),
        "{s}"
    );

    // A works again and gives the handoff up while its backup cannot upload: A keeps its copy, unsynced, and the
    // profile is free for B.
    run(&a, &id_a, b"cookies-a-unsynced");
    server.fail("put_part", When::Before);
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id_a)["phase"], json!("handing_off"));
    assert_eq!(
        code(&invoke(&a, "sync_backup_now", json!({ "profileId": id_a }))).as_deref(),
        Some("TEAM_SESSION_ACTIVE")
    );
    invoke(&a, "team_abort", json!({ "profileId": id_a })).unwrap_or_else(|e| panic!("{e}"));
    let s = sync_status(&a, &id_a);
    assert_eq!(
        (s["synced_version"].clone(), s["dirty"].clone()),
        (json!(3), json!(true)),
        "{s}"
    );
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("released"));
    run(&b, &id_b, b"cookies-from-b-again");
    b.state.run_sync_jobs();
    assert_eq!(sync_status(&b, &id_b)["synced_version"], json!(4));

    // A backs its copy up: based on version 3, it conflicts and nothing is overwritten.
    invoke(&a, "sync_backup_now", json!({ "profileId": id_a })).unwrap_or_else(|e| panic!("{e}"));
    a.state.run_sync_jobs();
    let s = sync_status(&a, &id_a);
    assert_eq!(s["job"]["state"], json!("conflict"), "{s}");
    assert_eq!(s["conflict_head"], json!(4));
    assert_eq!(server.head(PRF).0, 4);
    assert_eq!(
        cookies(&a, &id_a),
        b"cookies-a-unsynced",
        "A's data is untouched"
    );
    assert_eq!(
        code(&invoke(&a, "sync_backup_now", json!({ "profileId": id_a }))).as_deref(),
        Some("SYNC_CONFLICT_OPEN")
    );
    assert_eq!(
        code(&invoke(&a, "launch_profile", json!({ "profileId": id_a }))).as_deref(),
        Some("SYNC_CONFLICT_OPEN")
    );

    // A compares first: the newer backup as a separate copy.
    invoke(
        &a,
        "sync_resolve_conflict",
        json!({ "profileId": id_a, "choice": "open_newer_as_copy" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    a.state.run_sync_jobs();
    let listed = invoke(&a, "list_profiles", json!({})).unwrap_or_else(|e| panic!("{e}"));
    let copy = listed
        .as_array()
        .and_then(|l| {
            l.iter().find(|p| {
                p["name"]
                    .as_str()
                    .is_some_and(|n| n.ends_with("(restored copy)"))
            })
        })
        .and_then(|p| p["id"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert_eq!(cookies(&a, &copy), b"cookies-from-b-again");
    assert_eq!(
        sync_status(&a, &copy)["linked"],
        json!(false),
        "a copy is not linked"
    );

    // Then keeps its own as the newest: version 5, based on 4.
    invoke(
        &a,
        "sync_resolve_conflict",
        json!({ "profileId": id_a, "choice": "upload_mine" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    a.state.run_sync_jobs();
    let s = sync_status(&a, &id_a);
    assert_eq!(
        (s["synced_version"].clone(), s["conflict_head"].clone()),
        (json!(5), Value::Null),
        "{s}"
    );
    assert_eq!(server.committed(PRF).len(), 5);
}

#[test]
fn opening_replaces_a_waiting_backup_and_a_lost_connection_leaves_the_closing_backup_waiting() {
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let f = fixture();
    connect(&f, &server, DEV_A);
    let id = linked_profile(&f);
    invoke(&f, "sync_backup_now", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    // Opened before the backup ran (milestone 08): the session's own closing backup replaces it.
    open(&f, &id);
    assert_eq!(sync_status(&f, &id)["job"]["state"], json!("canceled"));
    assert_eq!(team(&f, &id)["phase"], json!("running"));
    assert_eq!(server.lease(PRF).map(|l| l.purpose), Some("session"));
    assert_eq!(
        code(&invoke(&f, "sync_backup_now", json!({ "profileId": id }))).as_deref(),
        Some("TEAM_SESSION_ACTIVE")
    );
    f.state.run_sync_jobs();
    assert_eq!(server.committed(PRF).len(), 0);

    // The connection drops while parts are uploading: the closing backup waits and resumes later; the profile
    // stays held until it commits.
    server.fail("put_part", When::Before);
    close(&f, &id, b"cookies-v1");
    f.state.run_sync_jobs();
    let s = sync_status(&f, &id);
    assert_eq!(s["job"]["state"], json!("uploading"), "{s}");
    assert_eq!(s["progress"]["waiting_for"], json!("STORAGE_OFFLINE"));
    assert_eq!(team(&f, &id)["phase"], json!("handing_off"));
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    f.state.run_sync_jobs();
    let s = sync_status(&f, &id);
    assert_eq!(
        (s["job"]["state"].clone(), s["synced_version"].clone()),
        (json!("committed"), json!(1)),
        "{s}"
    );
    assert_eq!(s["progress"]["waiting_for"], Value::Null);
    assert_eq!(team(&f, &id)["phase"], Value::Null, "handoff ready");
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("released"));

    // The person cancels a later closing backup: the last version stays the newest and the session waits for
    // their decision (retry, or give the handoff up keeping this copy).
    run(&f, &id, b"cookies-v2");
    server.fail("put_part", When::Before);
    f.state.run_sync_jobs();
    invoke(&f, "sync_cancel", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    let s = sync_status(&f, &id);
    assert_eq!(
        (s["job"]["state"].clone(), s["dirty"].clone()),
        (json!("canceled"), json!(true)),
        "{s}"
    );
    let t = team(&f, &id);
    assert_eq!(
        (t["phase"].clone(), t["error_code"].clone()),
        (json!("pending"), json!("UPLOAD_CANCELED")),
        "{t}"
    );
    assert_eq!(server.head(PRF).0, 1);
    invoke(&f, "team_retry", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    f.state.run_sync_jobs();
    assert_eq!(sync_status(&f, &id)["synced_version"], json!(2));
    assert_eq!(team(&f, &id)["phase"], Value::Null);
}

#[test]
fn signed_out_jobs_wait_and_unlinked_profiles_are_refused() {
    let f = fixture();
    let id = workspace_with_profile(&f);
    assert_eq!(
        code(&invoke(&f, "sync_backup_now", json!({ "profileId": id }))).as_deref(),
        Some("SYNC_NOT_LINKED")
    );
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .link_org_profiles(ORG, &[(pid(&id), PRF.into())])
        .unwrap_or_else(|e| panic!("{e}"));
    invoke(&f, "sync_backup_now", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    f.state.run_sync_jobs();
    let s = sync_status(&f, &id);
    assert_eq!(
        s["progress"]["waiting_for"],
        json!("CLOUD_SIGNED_OUT"),
        "{s}"
    );
    assert_eq!(s["job"]["state"], json!("local_dirty"));
    invoke(
        &f,
        "sync_set_auto_backup",
        json!({ "profileId": id, "enabled": false }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(sync_status(&f, &id)["auto_backup"], json!(false));
    assert_eq!(
        code(&invoke(
            &f,
            "sync_resolve_conflict",
            json!({ "profileId": id, "choice": "upload_mine" })
        ))
        .as_deref(),
        Some("SYNC_NO_CONFLICT")
    );
    assert_eq!(
        code(&invoke(
            &f,
            "sync_resolve_conflict",
            json!({ "profileId": id, "choice": "overwrite" })
        ))
        .as_deref(),
        Some("INVALID_ARGUMENT")
    );
}

#[test]
fn local_backups_are_sealed_with_a_keychain_key_and_need_it_to_restore() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let procs = Arc::new(FakeProcesses::default());
    let keychain = Arc::new(MemoryStore::default());
    let f = fixture_in(tmp, procs.clone());
    f.state.use_secret_store(keychain.clone());
    let id = workspace_with_profile(&f);
    run(&f, &id, b"cookies-v1");
    assert_eq!(sync_status(&f, &id)["local_backups_sealed"], json!(true));
    assert!(keychain.accounts().contains(&"backup-key-v1".to_owned()));
    let op = invoke(
        &f,
        "recover_profile",
        json!({ "profileId": id, "action": "backup_now" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    wait_op(&f, &op);
    let s = sync_status(&f, &id);
    assert_eq!(
        (
            s["local_backup"]["sealed"].clone(),
            s["local_backup"]["openable"].clone()
        ),
        (json!(true), json!(true)),
        "{s}"
    );
    let sealed = f
        .data()
        .join("backups")
        .join(&id)
        .join("last-good/user-data.pbseal");
    let raw = std::fs::read(&sealed).unwrap_or_default();
    assert!(!raw.is_empty() && !raw.windows(10).any(|w| w == b"cookies-v1"));

    // The keychain was reset: the backup is reported as needing its key, and restoring it is refused cleanly.
    let Fixture {
        tmp,
        webview,
        _app,
        state,
        launcher,
        ..
    } = f;
    drop((webview, _app, launcher));
    drop(state);
    let g = fixture_in(tmp, procs);
    g.state.use_secret_store(Arc::new(MemoryStore::default()));
    let s = sync_status(&g, &id);
    assert_eq!(
        (
            s["local_backup"]["sealed"].clone(),
            s["local_backup"]["openable"].clone()
        ),
        (json!(true), json!(false)),
        "{s}"
    );
    let restore = invoke(
        &g,
        "recover_profile",
        json!({ "profileId": id, "action": "restore_backup" }),
    );
    if let Ok(op) = &restore {
        assert_ne!(
            wait_op(&g, op),
            pb_desktop_lib::operations::OpStatus::Succeeded
        );
    }
    assert_eq!(cookies(&g, &id), b"cookies-v1", "the profile is untouched");
}

#[test]
fn a_restore_interrupted_mid_switch_is_finished_at_start_up() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let procs = Arc::new(FakeProcesses::default());
    let f = fixture_in(tmp, procs.clone());
    let id = workspace_with_profile(&f);
    run(&f, &id, b"old");
    let root = f.data().join("profiles").join(&id);
    // Killed after the old data became evidence and before the restored folder moved in.
    std::fs::create_dir_all(root.join("user-data.incoming/user-data/Default"))
        .unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        root.join("user-data.incoming/user-data/Default/Cookies"),
        b"restored",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    std::fs::remove_dir_all(root.join("user-data")).unwrap_or_else(|e| panic!("{e}"));
    let Fixture {
        tmp,
        webview,
        _app,
        state,
        launcher,
        ..
    } = f;
    drop((webview, _app, launcher));
    drop(state);
    let g = fixture_in(tmp, procs);
    assert_eq!(cookies(&g, &id), b"restored");
    assert!(!root.join("user-data.incoming").exists());
}
