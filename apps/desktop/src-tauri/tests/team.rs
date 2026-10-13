//! Milestone 08 desktop acceptance tests: shared sessions of organization profiles through the real IPC commands,
//! local database, profile folders and (fake) browsers, with the in-memory server (`pb_sync::fake`) in place of the
//! API and storage. The server's clock and this computer's monotonic clock are moved by the tests, so lease expiry,
//! lost connections and delayed heartbeats are exact. `e2e` tests in CI run two devices against the real API.
//!
//! Exit-gate scenarios: simultaneous acquisition (one writer; refused and repeated opens take nothing), packet
//! loss, an app crash, a delayed heartbeat (uncertain session, revived by its holder), stale uploads (fenced, kept as
//! a recovery copy), revoked access and a forced takeover — newer state is never overwritten and nothing is merged.

mod support;

use pb_desktop_lib::operations::{OpKind, OpStatus};
use pb_desktop_lib::supervisor::fake::FakeProcesses;
use pb_runtime::ProfileId;
use pb_storage::cloud as cs;
use pb_storage::team::TeamSession;
use pb_sync::fake::{FakeServer, When};
use pb_sync::{OpenRequest, Poll, SessionApi};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use support::*;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";
const PRF: &str = "prf_01J9ZSEED0A010000000000000";
const DEV_A: &str = "dev_01J9ZSEED0D1D1000000000000";
const DEV_B: &str = "dev_01J9ZSEED0D2D2000000000000";
const BEAT: Duration = Duration::from_secs(15);

fn pid(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap_or_else(|_| panic!("bad id {id}"))
}

fn connect(f: &Fixture, server: &Arc<FakeServer>, dev: &str) {
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .set_cloud_state(cs::DEVICE_ID, Some(dev))
        .unwrap_or_else(|e| panic!("{e}"));
    f.state
        .use_sync_backend(Arc::new(server.client(dev, &[ORG])));
    f.state.set_sync_poll(Poll {
        interval: Duration::from_millis(1),
        max_wait: Duration::from_millis(200),
    });
}

fn user_data(f: &Fixture, id: &str) -> PathBuf {
    f.data().join("profiles").join(id).join("user-data")
}

fn cookies(f: &Fixture, id: &str) -> Vec<u8> {
    std::fs::read(user_data(f, id).join("Default/Cookies")).unwrap_or_default()
}

fn sync_status(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_sync_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn team(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_team_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Waits for a session phase, running the process monitor's step meanwhile (the app runs it every ~1.5 s).
fn wait_phase(f: &Fixture, id: &str, phase: Value) {
    wait_until(&format!("phase {phase}"), || {
        f.state.poll_once();
        team(f, id)["phase"] == phase
    });
}

fn profile_state(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_profile_status", json!({ "profileId": id }))
        .map(|s| s["profile"]["state"].clone())
        .unwrap_or(Value::Null)
}

/// Waits for a clean close to settle: stopped, the routine last-good copy written, the session's exit handled.
fn wait_closed(f: &Fixture, id: &str) {
    wait_until("the profile to stop", || {
        profile_state(f, id) == json!("stopped")
    });
    wait_until("the routine copy and the session to settle", || {
        let copying = f.state.ops.list().iter().any(|o| {
            o.kind == OpKind::BackupProfile
                && o.status == OpStatus::Running
                && o.target.as_deref() == Some(id)
        });
        let phase = team(f, id)["phase"].clone();
        !copying && phase != json!("running") && phase != json!("closing")
    });
}

fn launch(f: &Fixture, id: &str) -> Value {
    invoke(f, "launch_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn open(f: &Fixture, id: &str) {
    let op = launch(f, id);
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
}

/// Opens and returns the error code the open failed with.
fn refused(f: &Fixture, id: &str) -> Option<&'static str> {
    let op = launch(f, id);
    let id = op["operation_id"].as_str().unwrap_or_default();
    let done = f.state.ops.wait(id, Duration::from_secs(20));
    assert_eq!(done.as_ref().map(|o| o.status), Some(OpStatus::Failed));
    done.and_then(|o| o.error_code)
}

/// Chromium marks its profile "Crashed" while it runs and "Normal" on an orderly exit; the fake browser only writes
/// the latter, so tests that crash it write the former.
fn mark_running_like_chromium(f: &Fixture, id: &str) {
    let path = pb_runtime::prefs::preferences_path(&user_data(f, id));
    let mut v: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    v["profile"]["exit_type"] = json!("Crashed");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{e}"));
    }
    std::fs::write(&path, v.to_string()).unwrap_or_else(|e| panic!("{e}"));
}

fn work(f: &Fixture, id: &str, cookies: &[u8]) {
    let ud = user_data(f, id);
    std::fs::create_dir_all(ud.join("Default")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(ud.join("Default/Cookies"), cookies).unwrap_or_else(|e| panic!("{e}"));
}

/// "Close and hand off", optionally with a note; returns once the closing backup is queued.
fn hand_off(f: &Fixture, id: &str, cookies: &[u8], note: Option<&str>) {
    work(f, id, cookies);
    invoke(f, "team_close", json!({ "profileId": id, "note": note }))
        .unwrap_or_else(|e| panic!("{e}"));
    wait_closed(f, id);
}

/// One heartbeat period later on both clocks, then the worker's step.
fn beat(f: &Fixture, server: &FakeServer) {
    server.advance(BEAT.as_millis() as u64);
    f.state.team_advance(BEAT);
    f.state.run_team_tick();
}

fn team_events(f: &Fixture) -> Vec<String> {
    f.events
        .events
        .lock()
        .map(|e| {
            e.iter()
                .filter(|(n, _)| n == "team")
                .map(|(_, p)| p["kind"].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// A profile that ran once on this computer, linked to the organization profile and backed up as version 1.
fn shared_profile(f: &Fixture) -> String {
    let id = workspace_with_profile(f);
    open(f, &id);
    work(f, &id, b"cookies-v1");
    let stop =
        invoke(f, "stop_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(f, &stop), OpStatus::Succeeded);
    wait_closed(f, &id);
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .link_org_profiles(ORG, &[(pid(&id), PRF.into())])
        .unwrap_or_else(|e| panic!("{e}"));
    invoke(f, "sync_backup_now", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    f.state.run_sync_jobs();
    assert_eq!(sync_status(f, &id)["synced_version"], json!(1));
    id
}

/// The organization profile put on another computer (newest backup).
fn restored_here(f: &Fixture) -> String {
    invoke(f, "create_workspace", json!({ "name": "Home" })).unwrap_or_else(|e| panic!("{e}"));
    let view = invoke(
        f,
        "sync_restore_here",
        json!({ "orgId": ORG, "orgProfileId": PRF, "name": "Shop" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    f.state.run_sync_jobs();
    view["id"].as_str().unwrap_or_default().to_owned()
}

fn evidence_with(f: &Fixture, id: &str, label: &str) -> Vec<PathBuf> {
    std::fs::read_dir(f.data().join("evidence").join(id))
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(label))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn setup() -> (Arc<FakeServer>, Fixture, String) {
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let a = fixture();
    connect(&a, &server, DEV_A);
    let id = shared_profile(&a);
    (server, a, id)
}

// ------------------------------------------------------------------------------------------------- the happy path

#[test]
fn a_shared_profile_opens_under_a_lease_heartbeats_and_hands_off_with_a_note() {
    let (server, a, id_a) = setup();
    let b = fixture();
    connect(&b, &server, DEV_B);
    let id_b = restored_here(&b);

    open(&a, &id_a);
    let t = team(&a, &id_a);
    assert_eq!(t["phase"], json!("running"), "{t}");
    assert_eq!(
        t["capabilities"],
        json!(["launch", "edit", "backup_download"])
    );
    let lease = server.lease(PRF).unwrap_or_else(|| panic!("no lease"));
    assert_eq!(
        (lease.device.as_str(), lease.purpose, lease.state),
        (DEV_A, "session", "active")
    );
    // Heartbeats keep it well past the 60 s lease time.
    for _ in 0..6 {
        beat(&a, &server);
    }
    let held = server.lease(PRF).unwrap_or_else(|| panic!("no lease"));
    assert_eq!(
        (held.state, held.fencing, held.run_state.as_deref()),
        ("active", lease.fencing, Some("running"))
    );

    // One writer: B is refused and sees who has it; its refused open takes nothing.
    assert_eq!(refused(&b, &id_b), Some("PROFILE_IN_USE_ELSEWHERE"));
    let t = team(&b, &id_b);
    assert_eq!(
        (t["phase"].clone(), t["refusal"]["device_name"].clone()),
        (Value::Null, json!(DEV_A)),
        "{t}"
    );
    assert_eq!(server.lease(PRF).map(|l| l.fencing), Some(lease.fencing));

    // B asks; the request reaches A with the next heartbeat and closes nothing by itself.
    let req = server.request_handoff(PRF, DEV_B, "Need it for the refund queue");
    beat(&a, &server);
    let t = team(&a, &id_a);
    assert_eq!(
        (t["phase"].clone(), t["requests"][0]["id"].clone()),
        (json!("running"), json!(req)),
        "{t}"
    );
    assert!(team_events(&a).iter().any(|k| k == "requests"));

    // A note that looks like a password is refused (built at run time; not a real secret).
    let secretish = format!("{}: {}", ["pass", "word"].concat(), "not-a-real-one");
    assert_eq!(
        code(&invoke(
            &a,
            "team_close",
            json!({ "profileId": id_a, "note": secretish })
        ))
        .as_deref(),
        Some("NOTES_LOOK_SECRET")
    );
    assert_eq!(team(&a, &id_a)["phase"], json!("running"));

    // Close and hand off: "handoff ready" only after the closing backup committed.
    hand_off(&a, &id_a, b"cookies-from-a", Some("Refund half done"));
    let t = team(&a, &id_a);
    assert_eq!(t["phase"], json!("handing_off"), "{t}");
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    assert!(!team_events(&a).iter().any(|k| k == "handoff_ready"));
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id_a)["phase"], Value::Null);
    assert!(team_events(&a).iter().any(|k| k == "handoff_ready"));
    let released = server.lease(PRF).unwrap_or_else(|| panic!("no lease"));
    assert_eq!(
        (released.state, released.note.as_deref()),
        ("released", Some("Refund half done"))
    );
    assert_eq!(server.head(PRF).0, 2);
    assert_eq!(server.requests(PRF), vec![(req, "fulfilled")]);

    // B opens: the newest backup is put on B first, and A's note is shown.
    open(&b, &id_b);
    assert_eq!(cookies(&b, &id_b), b"cookies-from-a");
    let t = team(&b, &id_b);
    assert_eq!(
        (t["received_note"]["text"].clone(), t["refusal"].clone()),
        (json!("Refund half done"), Value::Null),
        "{t}"
    );
    assert_eq!(server.lease(PRF).map(|l| l.device), Some(DEV_B.to_owned()));
}

// ------------------------------------------------------------------------------- contention and refused opens

#[test]
fn repeated_clicks_share_one_open_and_refused_or_failed_opens_hold_nothing() {
    let (server, a, id) = setup();
    let spawns = a.launcher.spawns.load(Ordering::SeqCst);

    // Two clicks while the server is slow: one operation, one lease, one browser.
    server.hold("open_session");
    let first = launch(&a, &id);
    let second = launch(&a, &id);
    assert_eq!(first["operation_id"], second["operation_id"]);
    server.release_held();
    assert_eq!(wait_op(&a, &first), OpStatus::Succeeded);
    assert_eq!(
        server
            .calls()
            .iter()
            .filter(|c| **c == "open_session")
            .count(),
        1
    );
    assert_eq!(a.launcher.spawns.load(Ordering::SeqCst), spawns + 1);
    // A click on the open profile joins it.
    open(&a, &id);
    assert_eq!(a.launcher.spawns.load(Ordering::SeqCst), spawns + 1);
    hand_off(&a, &id, b"v2", None);
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id)["phase"], Value::Null);

    // Offline: a shared open is refused (local profiles still open).
    server.fail("open_session", When::Before);
    assert_eq!(refused(&a, &id), Some("SHARED_OFFLINE"));
    assert_eq!(team(&a, &id)["phase"], Value::Null);
    let local = invoke(&a, "create_profile", json!({ "name": "Only here" }))
        .unwrap_or_else(|e| panic!("{e}"));
    let local = local["id"].as_str().unwrap_or_default().to_owned();
    open(&a, &local);
    assert_eq!(team(&a, &local)["shared"], json!(false));

    // The answer is lost after the server granted the lease: the next open replaces it (same computer).
    let before = server.lease(PRF).map(|l| l.fencing).unwrap_or_default();
    server.fail("open_session", When::After);
    assert_eq!(refused(&a, &id), Some("SHARED_OFFLINE"));
    open(&a, &id);
    let now = server.lease(PRF).unwrap_or_else(|| panic!("no lease"));
    assert!(now.fencing > before + 1, "{now:?}");
    assert_eq!(now.state, "active");

    // A browser that never finishes starting: the launch failed and the profile is given back.
    hand_off(&a, &id, b"v3", None);
    a.state.run_sync_jobs();
    mark_running_like_chromium(&a, &id);
    a.launcher.die_immediately.store(true, Ordering::SeqCst);
    assert_eq!(refused(&a, &id), Some("EXITED_EARLY"));
    wait_phase(&a, &id, Value::Null);
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("released"));
    assert_eq!(server.head(PRF).0, 3, "nothing uploaded");

    // Without `launch` (a viewer): refused by the server.
    server.set_capabilities(DEV_A, &[]);
    assert_eq!(refused(&a, &id), Some("NO_ACCESS"));
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("released"));
}

// --------------------------------------------------------------------------- packet loss and delayed heartbeats

#[test]
fn a_lost_connection_closes_the_browser_before_the_lease_runs_out_and_the_handoff_resumes() {
    let (server, a, id_a) = setup();
    let b = fixture();
    connect(&b, &server, DEV_B);
    let id_b = restored_here(&b);
    open(&a, &id_a);
    work(&a, &id_a, b"work-before-the-outage");

    // Packet loss: heartbeats fail. After 40 s without one, the browser is closed (the lease lasts 60 s).
    for _ in 0..3 {
        server.fail("heartbeat", When::Before);
    }
    beat(&a, &server);
    beat(&a, &server);
    assert_eq!(team(&a, &id_a)["phase"], json!("running"));
    beat(&a, &server);
    wait_phase(&a, &id_a, json!("handing_off"));
    let t = team(&a, &id_a);
    assert_eq!(
        (t["phase"].clone(), t["error_code"].clone()),
        (json!("handing_off"), json!("CONNECTION_LOST")),
        "{t}"
    );
    // The server still sees A's lease (45 s): nobody else could open it meanwhile.
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    assert_eq!(refused(&b, &id_b), Some("PROFILE_IN_USE_ELSEWHERE"));

    // Connected again: the closing backup uploads under the same lease, then the lease is released.
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id_a)["phase"], Value::Null);
    assert_eq!(server.head(PRF).0, 2);

    // A delayed heartbeat: this time the outage outlasts the lease. The session is uncertain (its browser may still
    // be open), so nobody else may open the profile until its holder confirms closure.
    open(&a, &id_a);
    work(&a, &id_a, b"work-before-a-long-outage");
    for _ in 0..3 {
        server.fail("heartbeat", When::Before);
    }
    for _ in 0..3 {
        beat(&a, &server);
    }
    wait_phase(&a, &id_a, json!("handing_off"));
    server.advance(30_000);
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("uncertain"));
    assert_eq!(refused(&b, &id_b), Some("PROFILE_SESSION_UNCERTAIN"));
    assert_eq!(
        team(&b, &id_b)["refusal"]["code"],
        json!("PROFILE_SESSION_UNCERTAIN")
    );
    // The closing backup cannot commit on an expired lease: it waits, it does not fail.
    a.state.run_sync_jobs();
    assert_eq!(server.head(PRF).0, 2);
    assert_eq!(team(&a, &id_a)["phase"], json!("handing_off"));
    // The holder's next heartbeat revives the same lease (nobody took it), and the handoff completes.
    let token = server.lease(PRF).map(|l| l.fencing);
    beat(&a, &server);
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    assert_eq!(server.lease(PRF).map(|l| l.fencing), token);
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id_a)["phase"], Value::Null);
    assert_eq!(server.head(PRF).0, 3);
    open(&b, &id_b);
    assert_eq!(cookies(&b, &id_b), b"work-before-a-long-outage");
}

// ---------------------------------------------------------------------------------------------------- app crash

#[test]
fn a_restarted_app_keeps_its_session_and_a_crashed_browser_waits_for_the_person() {
    let procs = Arc::new(FakeProcesses::default());
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    let first = fixture_in(tmp, procs.clone());
    connect(&first, &server, DEV_A);
    let id = shared_profile(&first);
    open(&first, &id);
    let token = server.lease(PRF).map(|l| l.fencing);

    // The app quits (or is killed) and the browser keeps running.
    let Fixture {
        tmp,
        webview,
        _app,
        state,
        launcher,
        ..
    } = first;
    drop((webview, _app, launcher));
    state.supervisor.detach_all();
    drop(state);
    let g = fixture_in(tmp, procs.clone());
    connect(&g, &server, DEV_A);
    g.state.resume_team_sessions();
    assert_eq!(team(&g, &id)["phase"], json!("running"));
    beat(&g, &server);
    assert_eq!(server.lease(PRF).map(|l| l.fencing), token, "same lease");
    assert_eq!(
        server.lease(PRF).and_then(|l| l.run_state).as_deref(),
        Some("running")
    );

    // Then the browser crashes: nothing is uploaded until the person decides, and the lease stays held meanwhile.
    work(&g, &id, b"crashed-work");
    mark_running_like_chromium(&g, &id);
    let main = 4010;
    assert!(procs.contains(main), "the re-attached browser");
    procs.remove(main + 1);
    procs.remove(main);
    wait_phase(&g, &id, json!("pending"));
    assert_eq!(
        team(&g, &id)["error_code"],
        json!("PROFILE_CLOSED_UNCLEANLY")
    );
    for _ in 0..5 {
        beat(&g, &server);
    }
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    assert_eq!(
        code(&invoke(&g, "team_retry", json!({ "profileId": id }))).as_deref(),
        Some("SESSION_NEEDS_REOPEN")
    );
    assert_eq!(server.head(PRF).0, 1);
    // Reopened under the same lease (the browser's own recovery runs), then closed normally.
    open(&g, &id);
    assert_eq!(team(&g, &id)["phase"], json!("running"));
    assert_eq!(server.lease(PRF).map(|l| l.fencing), token);
    hand_off(&g, &id, b"recovered-work", None);
    g.state.run_sync_jobs();
    assert_eq!(team(&g, &id)["phase"], Value::Null);
    assert_eq!(server.head(PRF).0, 2);

    // Killed while an open was on its way: at start-up the open is replayed with its key and given back.
    let key = "open-killed-midway-0001";
    let client = server.client(DEV_A, &[ORG]);
    client
        .open_session(
            ORG,
            PRF,
            key,
            &OpenRequest {
                device_id: DEV_A.into(),
                purpose: "session".into(),
                platform: "linux".into(),
                browser_version: TEST_BROWSER_VERSION.into(),
            },
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    let store = g.state.store().unwrap_or_else(|e| panic!("{e:?}"));
    store
        .put_team_session(&TeamSession {
            local_profile_id: pid(&id),
            org_id: ORG.into(),
            org_profile_id: PRF.into(),
            lease_id: None,
            fencing_token: None,
            open_key: key.into(),
            phase: "opening".into(),
            operation_id: None,
            upload_job_id: None,
            handoff_note: None,
            received_note: None,
            error_code: None,
            quarantine: None,
            started_at: String::new(),
            updated_at: String::new(),
        })
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("active"));
    g.state.resume_team_sessions();
    assert_eq!(team(&g, &id)["phase"], Value::Null);
    assert_eq!(server.lease(PRF).map(|l| l.state), Some("released"));
}

// ----------------------------------------------------------------------------------- takeover and stale uploads

#[test]
fn a_forced_takeover_closes_the_browser_and_keeps_this_copy_aside_as_a_recovery_copy() {
    let (server, a, id) = setup();
    open(&a, &id);
    work(&a, &id, b"work-in-progress");
    assert!(server.take_over(PRF));
    beat(&a, &server);
    let t = team(&a, &id);
    assert_eq!(
        (t["phase"].clone(), t["error_code"].clone()),
        (json!("taken_over"), json!("TAKEN_OVER")),
        "{t}"
    );
    // Paused: no settings change, no reopen until the notice is dismissed.
    let version = invoke(&a, "get_profile_status", json!({ "profileId": id }))
        .map(|s| s["profile"]["version"].clone())
        .unwrap_or(Value::Null);
    assert_eq!(
        code(&invoke(
            &a,
            "update_profile",
            json!({ "profileId": id, "expectedVersion": version, "name": "Renamed" })
        ))
        .as_deref(),
        Some("SESSION_PAUSED")
    );
    wait_until("the browser to close", || {
        profile_state(&a, &id) == json!("stopped")
    });
    assert_eq!(
        code(&invoke(&a, "launch_profile", json!({ "profileId": id }))).as_deref(),
        Some("SESSION_ENDED")
    );
    // Kept aside (never merged), then uploaded as a recovery copy that never becomes the newest version.
    a.state.run_team_tick();
    let kept = evidence_with(&a, &id, "taken-over");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        std::fs::read(kept[0].join("user-data/Default/Cookies")).unwrap_or_default(),
        b"work-in-progress"
    );
    assert!(team(&a, &id)["kept_aside"].is_string());
    a.state.run_sync_jobs();
    assert_eq!(server.recovery_copies(PRF).len(), 1);
    assert_eq!(server.head(PRF).0, 1);
    assert_eq!(team(&a, &id)["error_code"], json!("RECOVERY_COPY_KEPT"));
    assert!(team_events(&a).iter().any(|k| k == "recovery_kept"));

    // Dismissed, the profile opens again from the newest backup.
    invoke(&a, "team_dismiss", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    open(&a, &id);
    assert_eq!(cookies(&a, &id), b"cookies-v1");

    // A stale upload: taken over after the browser closed and before the closing backup committed. The upload is
    // refused (fenced), nothing overwrites the newest version, and this copy becomes a recovery copy too.
    hand_off(&a, &id, b"closed-but-not-uploaded", None);
    assert!(server.take_over(PRF));
    a.state.run_sync_jobs();
    let t = team(&a, &id);
    assert_eq!(t["phase"], json!("taken_over"), "{t}");
    assert_eq!(server.head(PRF).0, 1);
    a.state.run_team_tick();
    assert_eq!(evidence_with(&a, &id, "taken-over").len(), 2);
    a.state.run_sync_jobs();
    assert_eq!(server.recovery_copies(PRF).len(), 2);
    assert_eq!(server.head(PRF).0, 1);
    assert_eq!(server.committed(PRF).len(), 1);
}

#[test]
fn removed_access_stops_the_session_and_keeps_the_data_on_this_computer() {
    let (server, a, id) = setup();
    // An operator without `edit`: synced settings are refused, other edits are fine.
    server.set_capabilities(DEV_A, &["launch", "backup_download"]);
    open(&a, &id);
    assert_eq!(
        team(&a, &id)["capabilities"],
        json!(["launch", "backup_download"])
    );
    let version = invoke(&a, "get_profile_status", json!({ "profileId": id }))
        .map(|s| s["profile"]["version"].clone())
        .unwrap_or(Value::Null);
    assert_eq!(
        code(&invoke(
            &a,
            "update_profile",
            json!({ "profileId": id, "expectedVersion": version, "startUrls": ["https://example.com/"] })
        ))
        .as_deref(),
        Some("NO_EDIT_CAPABILITY")
    );
    invoke(
        &a,
        "update_profile",
        json!({ "profileId": id, "expectedVersion": version, "favourite": true }),
    )
    .unwrap_or_else(|e| panic!("{e}"));

    work(&a, &id, b"work-when-access-ended");
    server.revoke_access(DEV_A);
    beat(&a, &server);
    let t = team(&a, &id);
    assert_eq!(
        (t["phase"].clone(), t["error_code"].clone()),
        (json!("revoked"), json!("ACCESS_REMOVED")),
        "{t}"
    );
    wait_until("the browser to close", || {
        profile_state(&a, &id) == json!("stopped")
    });
    a.state.run_team_tick();
    // Already-downloaded data is not erased: it is kept aside on this computer, and nothing is uploaded.
    let kept = evidence_with(&a, &id, "access-removed");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        std::fs::read(kept[0].join("user-data/Default/Cookies")).unwrap_or_default(),
        b"work-when-access-ended"
    );
    a.state.run_sync_jobs();
    assert!(server.recovery_copies(PRF).is_empty());
    invoke(&a, "team_dismiss", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(refused(&a, &id), Some("NO_ACCESS"));
}

// ------------------------------------------------------------------------------ an unsynced copy is never merged

#[test]
fn a_given_up_handoff_keeps_this_copy_and_a_newer_backup_sets_it_aside_before_opening() {
    let (server, a, id_a) = setup();
    let b = fixture();
    connect(&b, &server, DEV_B);
    let id_b = restored_here(&b);

    // A cannot upload its closing backup and gives the handoff up: its copy stays here, unsynced.
    open(&a, &id_a);
    hand_off(&a, &id_a, b"unsynced-on-a", None);
    server.fail("put_part", When::Before);
    a.state.run_sync_jobs();
    assert_eq!(team(&a, &id_a)["phase"], json!("handing_off"));
    invoke(&a, "team_abort", json!({ "profileId": id_a })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(team(&a, &id_a)["phase"], Value::Null);
    assert_eq!(sync_status(&a, &id_a)["dirty"], json!(true));
    assert_eq!(cookies(&a, &id_a), b"unsynced-on-a");

    // B works and hands off version 2.
    open(&b, &id_b);
    hand_off(&b, &id_b, b"from-b", None);
    b.state.run_sync_jobs();
    assert_eq!(server.head(PRF).0, 2);

    // A opens: its unsynced copy is kept aside (not merged, not uploaded) and B's version is put on A.
    open(&a, &id_a);
    assert_eq!(cookies(&a, &id_a), b"from-b");
    assert!(team(&a, &id_a)["kept_aside"].is_string());
    let kept = evidence_with(&a, &id_a, "unsynced-before-restore");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        std::fs::read(kept[0].join("user-data/Default/Cookies")).unwrap_or_default(),
        b"unsynced-on-a"
    );
    hand_off(&a, &id_a, b"from-a-on-top-of-b", None);
    a.state.run_sync_jobs();
    assert_eq!(server.head(PRF).0, 3);
}
