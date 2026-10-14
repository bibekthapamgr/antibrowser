//! Milestone 10 desktop acceptance tests: this computer as an automation agent, through the real IPC commands, local
//! database, profile folders, shared-session leases and closing backups, with the in-memory server
//! (`pb_sync::fake`) in place of the API and an in-memory browser (`pb_devtools::fake`) answering DevTools on the
//! protected pipe. The API's own tests cover the server side (scoped tokens, claims, one job per profile, webhooks).
//!
//! Exit-gate scenarios here: a job runs only under the profile's session lease and hands the profile back with its
//! closing backup; steps stay on approved sites; a cancel stops before the next step; a lost answer resumes only the
//! safe step under a new lease; a profile that is not here is restored first (or the claim goes back to the queue);
//! debugging needs this computer's consent; a computer removed in the organization stops asking for work.

mod support;

use pb_desktop_lib::automation::AutomationTiming;
use pb_desktop_lib::operations::{OpKind, OpStatus};
use pb_runtime::ProfileId;
use pb_storage::cloud as cs;
use pb_sync::Poll;
use pb_sync::fake::{FakeJob, FakeServer, When};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";
const PRF: &str = "prf_01J9ZSEED0A010000000000000";
const PRF_EMPTY: &str = "prf_01J9ZSEED0A020000000000000";
const DEV_A: &str = "dev_01J9ZSEED0D1D1000000000000";
const DEV_B: &str = "dev_01J9ZSEED0D2D2000000000000";
const SITE: &str = "https://portal.example.test";

fn pid(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap_or_else(|_| panic!("bad id {id}"))
}

fn timing() -> AutomationTiming {
    AutomationTiming {
        poll: Duration::from_millis(20),
        open_wait: Duration::from_secs(20),
        stop_wait: Duration::from_secs(10),
        close_wait: Duration::from_secs(20),
        restore_wait: Duration::from_secs(20),
        debug_connect: Duration::from_secs(10),
        report_retry: Duration::from_millis(10),
        report_tries: 1,
        minute: Duration::from_millis(200),
    }
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
    f.state.set_automation_timing(timing());
}

fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Runs what the app's background threads would (process monitor, organization backups, the automation poll)
/// until `cond` holds.
fn drive(f: &Fixture, what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        f.state.poll_once();
        f.state.run_sync_jobs();
        f.state.run_automation_tick();
        if cond() {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn job(server: &FakeServer, id: &str) -> FakeJob {
    server.job(id).unwrap_or_else(|| panic!("no job {id}"))
}

fn finished(server: &FakeServer, id: &str) -> bool {
    matches!(job(server, id).state, "SUCCEEDED" | "FAILED" | "CANCELED")
}

/// The job finished on the server and this computer let go of it.
fn run_to_end(f: &Fixture, server: &FakeServer, id: &str) -> FakeJob {
    drive(f, "the job to finish", || {
        finished(server, id) && f.state.automation_running().is_empty()
    });
    job(server, id)
}

fn step_states(j: &FakeJob) -> Vec<(String, String)> {
    j.steps
        .iter()
        .map(|s| (s.action.clone(), s.state.clone()))
        .collect()
}

fn reports(server: &FakeServer) -> Vec<String> {
    server
        .reports()
        .into_iter()
        .filter(|r| r != "poll")
        .collect()
}

fn status(f: &Fixture) -> Value {
    invoke(f, "get_automation_status", json!({})).unwrap_or_else(|e| panic!("{e}"))
}

fn enroll(f: &Fixture) -> Value {
    invoke(
        f,
        "automation_enroll",
        json!({ "orgId": ORG, "accepts": "mine", "maxJobs": 2 }),
    )
    .unwrap_or_else(|e| panic!("{e}"))
}

fn user_data(f: &Fixture, id: &str) -> PathBuf {
    f.data().join("profiles").join(id).join("user-data")
}

fn profile_state(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_profile_status", json!({ "profileId": id }))
        .map(|s| s["profile"]["state"].clone())
        .unwrap_or(Value::Null)
}

fn team(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_team_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn open(f: &Fixture, id: &str) {
    let op =
        invoke(f, "launch_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(f, &op), OpStatus::Succeeded);
}

fn wait_closed(f: &Fixture, id: &str) {
    wait_until("the profile to stop", || {
        profile_state(f, id) == json!("stopped")
    });
    wait_until("the routine copy to finish", || {
        !f.state.ops.list().iter().any(|o| {
            o.kind == OpKind::BackupProfile
                && o.status == OpStatus::Running
                && o.target.as_deref() == Some(id)
        })
    });
}

/// A profile that ran once on this computer, linked to the organization profile and backed up as version 1.
fn shared_profile(f: &Fixture) -> String {
    let id = workspace_with_profile(f);
    open(f, &id);
    let ud = user_data(f, &id);
    std::fs::create_dir_all(ud.join("Default")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(ud.join("Default/Cookies"), b"cookies-v1").unwrap_or_else(|e| panic!("{e}"));
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
    id
}

fn setup() -> (Fixture, Arc<FakeServer>, String) {
    let f = fixture();
    let server = FakeServer::new(64 * 1024);
    server.add_profile(ORG, PRF);
    connect(&f, &server, DEV_A);
    let id = shared_profile(&f);
    assert_eq!(server.head(PRF).0, 1);
    (f, server, id)
}

fn set_page(f: &Fixture, edit: impl FnOnce(&mut pb_devtools::fake::FakePage)) {
    if let Ok(mut p) = f.launcher.devtools_page.lock() {
        edit(&mut p);
    }
}

fn audit_outcomes(f: &Fixture) -> Vec<String> {
    let db =
        rusqlite::Connection::open(f.data().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
    let mut stmt = db
        .prepare("select outcome from audit_log where action = 'automation' order by seq")
        .unwrap_or_else(|e| panic!("{e}"));
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap_or_else(|e| panic!("{e}"))
        .filter_map(Result::ok)
        .collect()
}

// ---------------------------------------------------------------------------------------------- the happy path

#[test]
fn a_job_runs_under_the_profile_lease_and_hands_the_profile_back_with_its_backup() {
    let (f, server, id) = setup();
    let st = enroll(&f);
    assert_eq!(st["enrollments"][0]["org_id"], json!(ORG));
    assert_eq!(st["allow_debugging"], json!(false));
    assert_eq!(server.agents().len(), 1);
    set_page(&f, |p| {
        p.title = "Portal".into();
        p.text = "Welcome back".into();
        p.selectors = vec!["#app".into()];
    });
    let j = server.add_job(
        ORG,
        PRF,
        vec![
            json!({ "action": "open_url", "url": format!("{SITE}/login") }),
            json!({ "action": "wait_for", "condition": { "type": "text", "text": "Welcome" } }),
            json!({ "action": "wait_for", "condition": { "type": "selector", "selector": "#app" } }),
            json!({ "action": "screenshot", "label": "login" }),
        ],
        None,
        None,
        &[SITE],
    );
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "SUCCEEDED", "{:?}", step_states(&done));
    assert!(done.steps.iter().all(|s| s.state == "succeeded"));
    let out = |action: &str| {
        done.steps
            .iter()
            .find(|s| s.action == action)
            .and_then(|s| s.output.clone())
            .unwrap_or(Value::Null)
    };
    assert_eq!(out("open_profile")["restored"], json!(false));
    assert_eq!(out("open_url")["final_origin"], json!(SITE));
    assert_eq!(out("open_url")["http_status"], json!(200));
    assert_eq!(out("close_profile")["backup"], json!("committed"));
    let art = out("screenshot")["artifact_id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_default();
    let jpeg = server.artifact(&art).unwrap_or_default();
    assert_eq!(&jpeg[..3], &[0xff, 0xd8, 0xff]);
    assert_eq!(out("screenshot")["width"], json!(1280));

    // Reported in order: the lease first, every step before and after it ran, then the result.
    assert_eq!(
        reports(&server),
        vec![
            "started",
            "step_started:0",
            "step_finished:0:succeeded",
            "step_started:1",
            "step_finished:1:succeeded",
            "step_started:2",
            "step_finished:2:succeeded",
            "step_started:3",
            "step_finished:3:succeeded",
            "step_started:4",
            "step_finished:4:succeeded",
            "step_started:5",
            "step_finished:5:succeeded",
            "finished:SUCCEEDED",
        ]
    );
    // An automation session says so; DevTools went over the pipe, never a port.
    let args = f
        .launcher
        .last_args
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default();
    assert!(args.iter().any(|a| a == "--enable-automation"));
    assert!(!args.iter().any(|a| a.starts_with("--remote-debugging")));
    let browser = f
        .launcher
        .devtools_browser()
        .unwrap_or_else(|| panic!("no devtools browser"));
    let methods = browser.methods();
    assert!(methods.iter().any(|m| m == "Page.navigate"));
    assert!(methods.iter().any(|m| m == "Page.captureScreenshot"));
    // The job's text reached the page only as a JSON string argument.
    let expressions = browser
        .state
        .lock()
        .map(|s| s.expressions.clone())
        .unwrap_or_default();
    assert!(expressions.iter().any(|e| e.ends_with("(\"Welcome\")")));

    // Handed back like a person's session: closing backup committed, lease released, nothing left open here.
    assert_eq!(server.head(PRF).0, 2);
    assert_eq!(server.lease_holder(PRF), None);
    assert_eq!(team(&f, &id)["phase"], Value::Null);
    assert_eq!(profile_state(&f, &id), json!("stopped"));
    let st = status(&f);
    assert_eq!(st["running"], json!([]));
    let run = &st["runs"][0];
    assert_eq!(
        (
            run["job_id"].clone(),
            run["state"].clone(),
            run["outcome"].clone(),
            run["opens"].clone()
        ),
        (json!(j), json!("done"), json!("SUCCEEDED"), json!(1))
    );
    assert_eq!(run["profile_id"], json!(id));
    let audit = audit_outcomes(&f);
    assert!(audit.contains(&"enrolled".to_owned()) && audit.contains(&"job_succeeded".to_owned()));

    // A person's launch afterwards is an ordinary one.
    open(&f, &id);
    let args = f
        .launcher
        .last_args
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default();
    assert!(!args.iter().any(|a| a == "--enable-automation"));
}

#[test]
fn steps_stay_on_approved_sites_and_a_failed_step_still_closes_the_profile() {
    let (f, server, id) = setup();
    enroll(&f);
    // The site sends the page elsewhere: the job stops there, takes no screenshot, and closes the profile.
    set_page(&f, |p| {
        p.redirect_to = Some("https://elsewhere.example.net/".into())
    });
    let j = server.add_job(
        ORG,
        PRF,
        vec![
            json!({ "action": "open_url", "url": format!("{SITE}/") }),
            json!({ "action": "screenshot" }),
        ],
        None,
        None,
        &[SITE],
    );
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "FAILED");
    assert_eq!(done.error.as_deref(), Some("PAGE_LEFT_APPROVED_SITES"));
    assert_eq!(
        step_states(&done)
            .into_iter()
            .map(|(_, s)| s)
            .collect::<Vec<_>>(),
        vec!["succeeded", "failed", "skipped", "succeeded"]
    );
    let browser = f
        .launcher
        .devtools_browser()
        .unwrap_or_else(|| panic!("no devtools browser"));
    assert!(
        !browser
            .methods()
            .iter()
            .any(|m| m == "Page.captureScreenshot")
    );
    assert_eq!(server.lease_holder(PRF), None);
    assert_eq!(profile_state(&f, &id), json!("stopped"));

    // An address that is not approved never opens, even if a job carries it.
    set_page(&f, |p| p.redirect_to = None);
    let j = server.add_job(
        ORG,
        PRF,
        vec![json!({ "action": "open_url", "url": "https://elsewhere.example.net/x" })],
        None,
        None,
        &[SITE],
    );
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.error.as_deref(), Some("URL_NOT_APPROVED"));
    let browser = f
        .launcher
        .devtools_browser()
        .unwrap_or_else(|| panic!("no devtools browser"));
    assert!(!browser.methods().iter().any(|m| m == "Page.navigate"));
}

// ---------------------------------------------------------------------------------------------- stopping

#[test]
fn a_cancel_stops_before_the_next_step_and_a_holding_job_ends_when_stopped() {
    let (f, server, id) = setup();
    enroll(&f);
    // Canceled while a step runs: that step finishes, nothing after it runs, the profile closes.
    let j = server.add_job(
        ORG,
        PRF,
        vec![
            json!({ "action": "open_url", "url": format!("{SITE}/") }),
            json!({ "action": "wait_for", "condition": { "type": "text", "text": "Ready" }, "timeout_ms": 20000 }),
            json!({ "action": "screenshot" }),
        ],
        None,
        None,
        &[SITE],
    );
    drive(&f, "the wait to start", || {
        reports(&server).contains(&"step_started:2".to_owned())
    });
    server.cancel_job(&j);
    if let Some(b) = f.launcher.devtools_browser() {
        b.set_page(|p| p.text = "Ready".into());
    }
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "CANCELED");
    assert_eq!(
        step_states(&done)
            .into_iter()
            .map(|(_, s)| s)
            .collect::<Vec<_>>(),
        vec![
            "succeeded",
            "succeeded",
            "succeeded",
            "skipped",
            "succeeded"
        ]
    );
    assert_eq!(server.head(PRF).0, 2, "the closing backup still uploads");

    // Keeping the profile open: the organization's stop ends it as succeeded.
    let j = server.add_job(
        ORG,
        PRF,
        vec![json!({ "action": "open_url", "url": format!("{SITE}/") })],
        Some(50),
        None,
        &[SITE],
    );
    drive(&f, "the profile to be held", || {
        status(&f)["runs"][0]["state"] == json!("holding")
    });
    assert_eq!(profile_state(&f, &id), json!("running"));
    server.cancel_job(&j);
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "SUCCEEDED");
    assert_eq!(
        done.steps
            .iter()
            .find(|s| s.action == "hold_open")
            .map(|s| s.state.clone()),
        Some("succeeded".into())
    );

    // Stopped by the person here: canceled. Leaving the organization's automation waits until nothing runs.
    let j = server.add_job(
        ORG,
        PRF,
        vec![json!({ "action": "open_url", "url": format!("{SITE}/") })],
        Some(50),
        None,
        &[SITE],
    );
    drive(&f, "the profile to be held again", || {
        status(&f)["runs"][0]["job_id"] == json!(j)
            && status(&f)["runs"][0]["state"] == json!("holding")
    });
    assert_eq!(
        code(&invoke(&f, "automation_unenroll", json!({ "orgId": ORG }))).as_deref(),
        Some("AUTOMATION_BUSY")
    );
    invoke(&f, "automation_stop_job", json!({ "jobId": j })).unwrap_or_else(|e| panic!("{e}"));
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "CANCELED");
    assert_eq!(
        code(&invoke(&f, "automation_stop_job", json!({ "jobId": j }))).as_deref(),
        Some("UNKNOWN_JOB")
    );
    let st = invoke(&f, "automation_unenroll", json!({ "orgId": ORG }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(st["enrollments"], json!([]));
    assert!(server.agents().is_empty());
    let audit = audit_outcomes(&f);
    for expected in ["stopped_here", "job_canceled", "unenrolled"] {
        assert!(
            audit.iter().any(|a| a == expected),
            "{expected} in {audit:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------- disconnects

#[test]
fn a_lost_answer_resumes_only_the_safe_step_under_a_new_lease() {
    let (f, server, id) = setup();
    enroll(&f);
    // The page never finishes loading: the step times out, and the report of its result never arrives.
    set_page(&f, |p| p.hang = true);
    let j = server.add_job(
        ORG,
        PRF,
        vec![
            json!({ "action": "open_url", "url": format!("{SITE}/slow"), "timeout_ms": 1000 }),
            json!({ "action": "screenshot" }),
        ],
        None,
        None,
        &[SITE],
    );
    drive(&f, "the slow step to start", || {
        reports(&server).contains(&"step_started:1".to_owned())
    });
    server.fail("report_job", When::Before);
    set_page(&f, |p| p.hang = false);
    // This computer stops reporting and closes the profile (closing backup as usual); the server still has the
    // step running, so it sends the job back to continue from that step (navigation: safe to repeat).
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "SUCCEEDED", "{:?}", step_states(&done));
    let open_url = done.steps.iter().find(|s| s.action == "open_url").cloned();
    assert_eq!(open_url.map(|s| s.attempt), Some(2));
    let r = reports(&server);
    assert_eq!(r.iter().filter(|x| *x == "started").count(), 2, "{r:?}");
    assert_eq!(
        r.iter().filter(|x| *x == "step_started:0").count(),
        1,
        "the open step is not repeated"
    );
    // Two sessions, two lease keys (a retried open of either would have got its own lease back).
    let run = &status(&f)["runs"][0];
    assert_eq!(
        (run["outcome"].clone(), run["opens"].clone()),
        (json!("SUCCEEDED"), json!(2))
    );
    assert_eq!(server.lease_holder(PRF), None);
    assert_eq!(server.head(PRF).0, 3);
    assert_eq!(profile_state(&f, &id), json!("stopped"));
    assert!(audit_outcomes(&f).iter().any(|a| a == "job_disconnected"));
}

// ---------------------------------------------------------------------------------------------- other computers

#[test]
fn a_profile_that_is_not_here_is_restored_first_or_its_claim_goes_back() {
    let (_a, server, _id) = setup();
    let b = fixture();
    connect(&b, &server, DEV_B);
    invoke(&b, "create_workspace", json!({ "name": "Home" })).unwrap_or_else(|e| panic!("{e}"));
    enroll(&b);
    // Never backed up anywhere: this computer cannot open it; the claim goes back to the queue.
    server.add_profile(ORG, PRF_EMPTY);
    let empty = server.add_job(
        ORG,
        PRF_EMPTY,
        vec![json!({ "action": "open_url", "url": format!("{SITE}/") })],
        None,
        None,
        &[SITE],
    );
    drive(&b, "the claim to go back", || {
        reports(&server)
            .iter()
            .any(|r| r == "released:PROFILE_NOT_AVAILABLE")
    });
    // (It may be claimed again meanwhile; it never runs here.)
    assert!(matches!(job(&server, &empty).state, "QUEUED" | "CLAIMED"));
    server.cancel_job(&empty);

    // Backed up by another computer: restored here first, then run.
    let j = server.add_job(
        ORG,
        PRF,
        vec![json!({ "action": "open_url", "url": format!("{SITE}/") })],
        None,
        None,
        &[SITE],
    );
    let done = run_to_end(&b, &server, &j);
    assert_eq!(done.state, "SUCCEEDED", "{:?}", step_states(&done));
    let links = invoke(&b, "list_org_links", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert!(links.to_string().contains(PRF), "{links}");
    assert!(audit_outcomes(&b).iter().any(|a| a == "restore_here"));
    assert_eq!(server.lease_holder(PRF), None);
}

// ---------------------------------------------------------------------------------------------- debugging

/// A raw WebSocket upgrade request to the broker; returns the HTTP status line.
fn upgrade(endpoint: &str, headers: &[(&str, &str)]) -> String {
    let rest = endpoint.trim_start_matches("ws://");
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let Ok(mut s) = std::net::TcpStream::connect(host) else {
        return "refused".into();
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    // Any 16-byte nonce, base64-encoded (built here rather than written out).
    let nonce = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(b"automation tests")
    };
    let mut req = format!(
        "GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {nonce}\r\n"
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return "refused".into();
    }
    let mut buf = [0u8; 256];
    let n = s.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n])
        .lines()
        .next()
        .unwrap_or("")
        .to_owned()
}

#[test]
fn debugging_sessions_need_this_computers_consent_and_a_capability() {
    let (f, server, _id) = setup();
    enroll(&f);
    // Not settable through the generic settings command: only its own audited one.
    assert!(
        invoke(
            &f,
            "update_setting",
            json!({ "key": "automation.allow_debugging", "value": true })
        )
        .is_err()
    );
    // Built at run time (never a secret-looking literal in the repository).
    let secret = format!("pbcap_{}", hex::encode(*b"test capability!"));
    let digest = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(secret.as_bytes()))
    };
    let j = server.add_job(ORG, PRF, vec![], Some(50), Some(&digest), &[SITE]);
    for _ in 0..10 {
        f.state.run_automation_tick();
    }
    assert_eq!(
        job(&server, &j).state,
        "QUEUED",
        "not given to a computer that does not allow it"
    );

    let st = invoke(&f, "automation_set_debugging", json!({ "allow": true }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(st["allow_debugging"], json!(true));
    drive(&f, "the debugging session", || {
        job(&server, &j)
            .steps
            .iter()
            .any(|s| s.action == "debug_bridge" && s.state == "succeeded")
    });
    let endpoint = job(&server, &j)
        .steps
        .iter()
        .find(|s| s.action == "debug_bridge")
        .and_then(|s| s.output.as_ref())
        .and_then(|o| o["endpoint"].as_str().map(str::to_owned))
        .unwrap_or_default();
    assert!(endpoint.starts_with("ws://127.0.0.1:"), "{endpoint}");
    assert!(endpoint.ends_with(&format!("/cdp/{j}")));
    assert_eq!(status(&f)["runs"][0]["debug_endpoint"], json!(endpoint));
    // Without the capability, or from a web page: refused.
    assert!(upgrade(&endpoint, &[]).contains(" 401"));
    assert!(upgrade(&endpoint, &[("Authorization", "Bearer pbcap_wrong")]).contains(" 401"));
    let bearer = format!("Bearer {secret}");
    assert!(
        upgrade(
            &endpoint,
            &[
                ("Authorization", &bearer),
                ("Origin", "https://portal.example.test")
            ]
        )
        .contains(" 403")
    );

    // Turning consent off here ends the debugging session; the profile stays open until the job is stopped.
    invoke(&f, "automation_set_debugging", json!({ "allow": false }))
        .unwrap_or_else(|e| panic!("{e}"));
    drive(&f, "the debugging session to end", || {
        status(&f)["runs"][0]["debug_endpoint"].is_null()
    });
    server.cancel_job(&j);
    let done = run_to_end(&f, &server, &j);
    assert_eq!(done.state, "SUCCEEDED");
    let audit = audit_outcomes(&f);
    for expected in [
        "debugging_allowed",
        "debugging_opened",
        "debugging_closed",
        "debugging_turned_off",
    ] {
        assert!(
            audit.iter().any(|a| a == expected),
            "{expected} in {audit:?}"
        );
    }
}

#[test]
fn a_computer_removed_in_the_organization_stops_asking_for_work() {
    let (f, server, _id) = setup();
    let st = enroll(&f);
    let agent = st["enrollments"][0]["agent_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    f.state.run_automation_tick();
    assert!(status(&f)["enrollments"][0]["last_poll_seconds"].is_number());
    server.drop_agent(&agent);
    f.state.run_automation_tick();
    assert_eq!(status(&f)["enrollments"], json!([]));
    assert!(audit_outcomes(&f).iter().any(|a| a == "unenrolled"));
    // Screenshots are downloaded by the shell (signed in to the organization's server); ids are checked first.
    let shot = |org: &str, job: &str, art: &str| {
        code(&invoke(
            &f,
            "automation_screenshot",
            json!({ "orgId": org, "jobId": job, "artifactId": art }),
        ))
    };
    let (job_id, art_id) = (
        "job_01J9ZSEED0A010000000000000",
        "art_01J9ZSEED0A010000000000000",
    );
    assert_eq!(
        shot(ORG, job_id, "art_x").as_deref(),
        Some("INVALID_ARGUMENT")
    );
    assert_eq!(
        shot(ORG, job_id, art_id).as_deref(),
        Some("CLOUD_SIGNED_OUT")
    );
    // Invalid requests are refused before anything is sent.
    for (cmd, body) in [
        (
            "automation_enroll",
            json!({ "orgId": "org_bad", "accepts": "mine", "maxJobs": 1 }),
        ),
        (
            "automation_enroll",
            json!({ "orgId": ORG, "accepts": "everyone", "maxJobs": 1 }),
        ),
        (
            "automation_enroll",
            json!({ "orgId": ORG, "accepts": "mine", "maxJobs": 11 }),
        ),
        ("automation_unenroll", json!({ "orgId": ORG })),
    ] {
        assert!(invoke(&f, cmd, body).is_err(), "{cmd}");
    }
}
