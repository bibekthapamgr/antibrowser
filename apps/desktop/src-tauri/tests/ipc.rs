//! Milestone 02/03 IPC acceptance tests. They drive the real Tauri pipeline (mock runtime, real capability/ACL and
//! argument deserialization, real command bodies and SQLite) with a fake process table instead of a browser.
//! Real-browser isolation tests are in `tests/browser.rs`.
//!
//! Covers: invalid IPC path, oversized requests and disallowed URLs are rejected; only allow-listed commands are
//! reachable and only from the bundled origin; workspace -> profile -> profile settings flow; operation ids and
//! events for launch/stop; migration failure and crash recovery; interrupted installs; re-attaching profiles that
//! kept running while the manager was closed.

mod support;

use pb_desktop_lib::operations::OpStatus;
use pb_desktop_lib::supervisor::fake::FakeProcesses;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use support::*;

// ---------------------------------------------------------------------------------------------- first run flow

#[test]
fn keyboardless_flow_first_run_workspace_profile_and_profile_settings() {
    let f = fixture();
    let app = invoke(&f, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(app["first_run"], json!(true));
    assert_eq!(app["store"]["status"], json!("ready"));
    assert_eq!(
        invoke(&f, "list_profiles", json!({})),
        Ok(json!([])),
        "empty list before a workspace exists"
    );
    assert_eq!(
        code(&invoke(&f, "create_profile", json!({ "name": "x" }))).as_deref(),
        Some("NO_WORKSPACE")
    );

    let id = workspace_with_profile(&f);
    let app = invoke(&f, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(app["first_run"], json!(false));
    assert!(
        app["active_workspace_id"]
            .as_str()
            .is_some_and(|w| w.starts_with("wsp_"))
    );

    // Profile settings: rename, clear client, notes; stale versions are refused.
    let updated = invoke(
        &f,
        "update_profile",
        json!({ "profileId": id, "expectedVersion": 1, "name": "Renamed", "clearClient": true, "notes": "line1\nline2" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (
            updated["name"].clone(),
            updated["client_name"].clone(),
            updated["version"].clone()
        ),
        (json!("Renamed"), Value::Null, json!(2))
    );
    let stale = invoke(
        &f,
        "update_profile",
        json!({ "profileId": id, "expectedVersion": 1, "notes": "late" }),
    );
    assert_eq!(code(&stale).as_deref(), Some("VERSION_CONFLICT"));
    assert_eq!(
        stale.err().and_then(|e| e.get("current_version").cloned()),
        Some(json!(2))
    );
}

// ---------------------------------------------------------------------------------------------- invalid input

#[test]
fn invalid_profile_ids_and_paths_never_reach_the_launcher() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let profiles_dir = f.data().join("profiles");
    let malicious = [
        json!({ "profileId": "../../../../etc/passwd" }),
        json!({ "profileId": "/Users/victim/Library" }),
        json!({ "profileId": "C:\\Windows\\System32" }),
        json!({ "profileId": "\\\\server\\share\\x" }),
        json!({ "profileId": "prf_../../../../../../../../tmp" }),
        json!({ "profileId": "prf_01J9ZSEED0A01000000000000/" }),
        json!({ "profileId": "prf_01j9zseed0a010000000000000" }),
        json!({ "profileId": "file:///etc/passwd" }),
        json!({ "profileId": "" }),
        json!({ "profileId": 42 }),
        json!({ "profileId": null }),
        json!({ "profileId": { "path": "../x" } }),
        json!({ "profileId": ["prf_01J9ZSEED0A010000000000000"] }),
        json!({}),
    ];
    for cmd in ["launch_profile", "stop_profile"] {
        for body in &malicious {
            let err = invoke(&f, cmd, body.clone())
                .err()
                .unwrap_or_else(|| panic!("{cmd} must reject {body}"));
            assert!(
                err.as_str().is_some_and(|t| t.contains("profileId")),
                "{cmd}: expected an argument error, got {err}"
            );
        }
    }
    // Well-formed but unknown, and known with unsafe start URLs: rejected by validation.
    assert_eq!(
        code(&invoke(
            &f,
            "launch_profile",
            json!({ "profileId": "prf_01J9ZSEED0ZZZZ000000000000" })
        ))
        .as_deref(),
        Some("UNKNOWN_PROFILE")
    );
    for url in [
        "file:///etc/passwd",
        "--utility-cmd-prefix=/bin/sh",
        "javascript:alert(1)",
        "chrome://settings",
    ] {
        let r = invoke(
            &f,
            "launch_profile",
            json!({ "profileId": known, "startUrl": url }),
        );
        assert_eq!(code(&r).as_deref(), Some("BAD_START_URL"), "{url}");
    }
    assert_eq!(
        f.launcher.spawns.load(Ordering::SeqCst),
        0,
        "no process may be started"
    );
    assert_eq!(
        dir_entries(&profiles_dir),
        0,
        "no profile directory may be created"
    );
}

#[test]
fn oversized_requests_are_rejected_without_side_effects() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let huge = "A".repeat(5 * 1024 * 1024);
    let cases = [
        (
            "create_workspace",
            json!({ "name": huge }),
            "INVALID_WORKSPACE_NAME",
        ),
        ("create_profile", json!({ "name": huge }), "INVALID_LABEL"),
        (
            "create_profile",
            json!({ "name": "ok", "client": huge }),
            "INVALID_LABEL",
        ),
        ("list_profiles", json!({ "query": huge }), "QUERY_TOO_LONG"),
        (
            "update_profile",
            json!({ "profileId": known, "expectedVersion": 1, "notes": huge }),
            "NOTES_TOO_LONG",
        ),
        (
            "launch_profile",
            json!({ "profileId": known, "startUrl": format!("https://a.example/{huge}") }),
            "BAD_START_URL",
        ),
        (
            "open_external",
            json!({ "url": format!("https://github.com/{huge}") }),
            "DISALLOWED_URL",
        ),
        (
            "update_setting",
            json!({ "key": "appearance.theme", "value": huge }),
            "INVALID_ARGUMENT",
        ),
        (
            "recovery_action",
            json!({ "action": "discard_interrupted", "target": huge }),
            "INVALID_ARGUMENT",
        ),
    ];
    for (cmd, body, expected) in cases {
        assert_eq!(
            code(&invoke(&f, cmd, body)).as_deref(),
            Some(expected),
            "{cmd}"
        );
    }
    assert_eq!(f.launcher.spawns.load(Ordering::SeqCst), 0);
    assert_eq!(
        invoke(&f, "list_profiles", json!({})).map(|v| v.as_array().map(Vec::len)),
        Ok(Some(1))
    );
}

#[test]
fn disallowed_urls_are_rejected() {
    let f = fixture();
    for url in [
        "http://github.com/",
        "https://evil.example/",
        "https://github.com.evil.example/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "projectbrowser://auth/callback?state=x",
        "https://user:pw@github.com/",
    ] {
        assert_eq!(
            code(&invoke(&f, "open_external", json!({ "url": url }))).as_deref(),
            Some("DISALLOWED_URL"),
            "{url}"
        );
    }
}

#[test]
fn settings_are_allowlisted_and_typed() {
    let f = fixture();
    let ok = invoke(
        &f,
        "update_setting",
        json!({ "key": "appearance.theme", "value": "dark", "expectedVersion": 0 }),
    );
    assert_eq!(ok.map(|v| v["version"].clone()), Ok(json!(1)));
    let cases = [
        (
            json!({ "key": "os.exec", "value": "rm -rf /" }),
            "UNKNOWN_SETTING",
        ),
        (
            json!({ "key": "appearance.theme", "value": "neon" }),
            "INVALID_SETTING_VALUE",
        ),
        (
            json!({ "key": "downloads.directory", "value": "/tmp" }),
            "SETTING_READ_ONLY",
        ),
        (
            json!({ "key": "workspace.active", "value": "wsp_01J9ZSEED0ZZZZ000000000000" }),
            "UNKNOWN_WORKSPACE",
        ),
        (
            json!({ "key": "appearance.theme", "value": "light", "expectedVersion": 0 }),
            "VERSION_CONFLICT",
        ),
    ];
    for (body, expected) in cases {
        assert_eq!(
            code(&invoke(&f, "update_setting", body.clone())).as_deref(),
            Some(expected),
            "{body}"
        );
    }
}

#[test]
fn download_directory_is_validated_natively() {
    let f = fixture();
    // Inside the app's own data folder: refused. A normal writable folder: accepted.
    assert!(
        f.state
            .set_download_directory(&f.data().join("profiles"))
            .is_err()
    );
    assert!(
        f.state
            .set_download_directory(Path::new("relative/dir"))
            .is_err()
    );
    let ok_dir = f.tmp.path().join("Downloads");
    std::fs::create_dir_all(&ok_dir).unwrap_or_else(|e| panic!("{e}"));
    assert!(f.state.set_download_directory(&ok_dir).is_ok());
    #[cfg(unix)]
    {
        let link = f.tmp.path().join("link-to-data");
        std::os::unix::fs::symlink(f.data(), &link).unwrap_or_else(|e| panic!("{e}"));
        assert!(
            f.state.set_download_directory(&link).is_err(),
            "symlinks are refused"
        );
    }
}

// ---------------------------------------------------------------------------------------------- capability boundary

#[test]
fn only_allowlisted_commands_from_the_bundled_origin_are_reachable() {
    let f = fixture();
    for cmd in [
        "plugin:shell|execute",
        "plugin:fs|read_file",
        "plugin:http|fetch",
        "plugin:dialog|open",
        "plugin:opener|open_url",
        "plugin:deep-link|get_current",
        "plugin:window|create",
        "plugin:webview|create_webview_window",
        "not_a_command",
    ] {
        assert!(invoke(&f, cmd, json!({})).is_err(), "{cmd} must be denied");
    }
    let remote = invoke_from(&f, "https://attacker.example/", "get_app_state", json!({}));
    assert!(
        remote.is_err(),
        "a page from another origin must not reach any command"
    );
}

#[test]
fn the_executable_cannot_be_chosen_by_the_webview() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let op = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": known, "executable": "/bin/sh", "args": ["-c", "id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        op["operation_id"]
            .as_str()
            .is_some_and(|o| o.starts_with("op_"))
    );
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    assert_eq!(
        f.launcher
            .last_executable
            .lock()
            .ok()
            .and_then(|g| g.clone()),
        Some(f.browser.clone())
    );
    // Repeated launch: same operation, still one browser.
    let again = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(again["operation_id"], op["operation_id"]);
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    assert_eq!(f.launcher.spawns.load(Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------------------------- lifecycle and events

#[test]
fn launch_and_stop_return_operations_and_emit_events() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let listed = invoke(&f, "list_profiles", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed[0]["status"], json!("running"));
    assert_eq!(listed[0]["adopted"], json!(false));

    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": known })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    let listed = invoke(&f, "list_profiles", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed[0]["status"], json!("closed"));
    assert_eq!(
        code(&invoke(&f, "stop_profile", json!({ "profileId": known }))).as_deref(),
        Some("NOT_RUNNING")
    );

    let names = f.events.names();
    assert!(
        names.iter().filter(|n| *n == "operation").count() >= 4,
        "{names:?}"
    );
    assert!(names.iter().any(|n| n == "profiles-changed"));
    let status = invoke(&f, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        status["operations"]
            .as_array()
            .is_some_and(|o| o.len() >= 2)
    );
}

#[test]
fn a_browser_that_exits_immediately_fails_its_operation() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    // The browser disappears right away, like a broken runtime.
    f.launcher.die_immediately.store(true, Ordering::SeqCst);
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Failed);
    let ops = f.state.ops.list();
    assert!(ops.iter().any(|o| o.error_code == Some("EXITED_EARLY")));
    let status = invoke(&f, "get_profile_status", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(status["profile"]["state"], json!("crashed"));
    assert_eq!(status["profile"]["last_error"], json!("EXITED_EARLY"));
    assert_eq!(status["suggested_recovery"], json!("reopen"));
    assert_eq!(status["runs"][0]["outcome"], json!("early_exit"));
}

#[test]
fn profiles_left_running_are_reattached_after_the_manager_restarts() {
    let procs = Arc::new(FakeProcesses::default());
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let first = fixture_in(tmp, procs.clone());
    let known = workspace_with_profile(&first);
    let op = invoke(&first, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&first, &op), OpStatus::Succeeded);
    // "Leave profiles running and quit": the manager goes away (releasing its profile locks), the browser does not.
    let Fixture {
        tmp,
        webview,
        _app,
        state,
        launcher,
        ..
    } = first;
    drop(webview);
    drop(_app);
    drop(launcher);
    // The process exits: the OS releases its profile locks (simulated, since the test process lives on).
    state.supervisor.detach_all();
    drop(state);

    let second = fixture_in(tmp, procs);
    let app = invoke(&second, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(app["recovery"]["adopted_profiles"], json!(1));
    assert_eq!(app["running_count"], json!(1));
    let listed = invoke(&second, "list_profiles", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (listed[0]["status"].clone(), listed[0]["adopted"].clone()),
        (json!("running"), json!(true))
    );
}

// ---------------------------------------------------------------------------------------------- recovery

#[test]
fn killed_during_migration_restarts_into_a_safe_recovery_state() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap_or_else(|e| panic!("{e}"));
    // A v1 database that cannot be upgraded (a conflicting table), standing in for a crash or bad migration.
    {
        let conn = rusqlite_conn(&data.join("local.db"));
        conn.execute_batch(
            "create table profiles (id text primary key, org_id text, name text not null, client_label text,
               folder_label text, search_text text not null, version integer not null default 1,
               created_at text not null default 'x', updated_at text not null default 'x');
             create table processes (profile_id text primary key, pid integer not null, started_at text not null default 'x');
             create table pending_changes (seq integer primary key, profile_id text, kind text, payload text, created_at text);
             create table workspaces (conflict integer);
             pragma user_version = 1;",
        )
        .unwrap_or_else(|e| panic!("{e}"));
    }
    let f = fixture_in(tmp, Arc::new(FakeProcesses::default()));
    let app = invoke(&f, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(app["store"]["status"], json!("failed"));
    assert_eq!(app["store"]["failure"]["code"], json!("MIGRATION_FAILED"));
    assert_eq!(app["store"]["failure"]["backup_available"], json!(true));
    assert_eq!(
        app["first_run"],
        json!(false),
        "a failed store is not mistaken for a first run"
    );
    // Everything that needs data reports the recovery state instead of failing obscurely.
    assert_eq!(
        code(&invoke(&f, "list_profiles", json!({}))).as_deref(),
        Some("STORE_UNAVAILABLE")
    );
    // Diagnostics still work.
    assert!(invoke(&f, "get_diagnostics", json!({})).is_ok());
    // The previous database was kept as-is.
    assert_eq!(
        rusqlite_conn(&f.data().join("local.db"))
            .query_row("pragma user_version", [], |r| r.get::<_, i64>(0))
            .ok(),
        Some(1)
    );
    // Retrying with the same cause fails cleanly and stays in recovery.
    assert_eq!(
        code(&invoke(
            &f,
            "recovery_action",
            json!({ "action": "retry_open" })
        ))
        .as_deref(),
        Some("STORE_UNAVAILABLE")
    );
    assert_eq!(
        code(&invoke(
            &f,
            "recovery_action",
            json!({ "action": "format_disk" })
        ))
        .as_deref(),
        Some("INVALID_ARGUMENT")
    );
}

fn rusqlite_conn(path: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn crash_and_interrupted_install_are_reported_and_resolvable() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let data = tmp.path().join("data");
    let staging = data
        .join("runtimes")
        .join("staging")
        .join("153.0.1-macos-arm64");
    std::fs::create_dir_all(&staging).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(staging.join("artifact.partial"), b"half").unwrap_or_else(|e| panic!("{e}"));
    // A previous manager died without cleaning up its session marker.
    std::fs::write(
        data.join("session.json"),
        r#"{"pid":999999,"started_at_unix":1,"version":"0.1.0"}"#,
    )
    .unwrap_or_else(|e| panic!("{e}"));

    let f = fixture_in(tmp, Arc::new(FakeProcesses::default()));
    let app = invoke(&f, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(app["recovery"]["previous_session_crashed"], json!(true));
    assert_eq!(app["recovery"]["interrupted_installs"], json!(1));
    let status = invoke(&f, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(status["interrupted"][0]["id"], json!("153.0.1-macos-arm64"));

    invoke(&f, "recovery_action", json!({ "action": "dismiss_crash" }))
        .unwrap_or_else(|e| panic!("{e}"));
    invoke(
        &f,
        "recovery_action",
        json!({ "action": "discard_interrupted", "target": "153.0.1-macos-arm64" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let traversal = invoke(
        &f,
        "recovery_action",
        json!({ "action": "discard_interrupted", "target": "../../profiles" }),
    );
    assert_eq!(code(&traversal).as_deref(), Some("INVALID_ARGUMENT"));
    let app = invoke(&f, "get_app_state", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (
            app["recovery"]["previous_session_crashed"].clone(),
            app["recovery"]["interrupted_installs"].clone()
        ),
        (json!(false), json!(0))
    );
}

#[test]
fn startup_timing_is_recorded_once_and_kept_separate_from_browsers() {
    let f = fixture();
    let first = invoke(&f, "report_ui_ready", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert!(first.as_f64().is_some_and(|ms| ms >= 0.0));
    assert_eq!(
        invoke(&f, "report_ui_ready", json!({})),
        Ok(Value::Null),
        "only the first report counts"
    );
    let d = invoke(&f, "get_diagnostics", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(d["manager"]["startup_ms"]["count"], json!(1));
    assert!(
        d["manager"]["store_open_ms"]["count"]
            .as_u64()
            .is_some_and(|c| c >= 1)
    );
    assert!(d["browsers"].get("main_process_rss_bytes").is_some());
    assert_eq!(d["browsers"]["spawn_ms"]["count"], json!(0));

    // Opening a profile adds a browser measurement and leaves manager start-up untouched.
    let known = workspace_with_profile(&f);
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let d = invoke(&f, "get_diagnostics", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(d["browsers"]["spawn_ms"]["count"], json!(1));
    assert_eq!(d["manager"]["startup_ms"]["count"], json!(1));
    let text = d.to_string();
    if let Ok(home) = std::env::var("HOME")
        && home.len() > 1
    {
        assert!(
            !text.contains(&home),
            "diagnostics are scrubbed of the home directory"
        );
    }
}

#[test]
fn removing_local_data_requires_confirmation_and_no_running_profiles() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    assert_eq!(
        code(&Err(serde_json::to_value(
            f.state.remove_local_data("yes").err()
        )
        .unwrap_or_default()))
        .as_deref(),
        Some("CONFIRMATION_REQUIRED")
    );
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    assert_eq!(
        f.state.remove_local_data("DELETE").err().map(|e| e.code),
        Some("PROFILES_RUNNING")
    );
    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": known })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    assert!(f.state.remove_local_data("DELETE").is_ok());
    assert!(!f.data().join("local.db").exists() && !f.data().join("profiles").exists());
}

// ---------------------------------------------------------------------------------------------- milestone 03

fn status(f: &Fixture, id: &str) -> Value {
    invoke(f, "get_profile_status", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"))
}

fn user_data(f: &Fixture, id: &str) -> PathBuf {
    f.data().join("profiles").join(id).join("user-data")
}

#[test]
fn concurrent_launch_requests_create_one_run() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let ops: Vec<String> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..6)
            .map(|_| {
                s.spawn(|| {
                    f.state
                        .launch_profile(
                            &pb_runtime::ProfileId::parse(&known).unwrap_or_else(|e| panic!("{e}")),
                            None,
                        )
                        .map(|s| s.operation_id)
                        .unwrap_or_else(|e| panic!("{e:?}"))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| panic!("join")))
            .collect()
    });
    assert!(ops.iter().all(|o| o == &ops[0]), "{ops:?}");
    assert_eq!(
        wait_op(&f, &json!({ "operation_id": ops[0] })),
        OpStatus::Succeeded
    );
    assert_eq!(f.launcher.spawns.load(Ordering::SeqCst), 1);
    let s = status(&f, &known);
    assert_eq!(s["profile"]["state"], json!("running"));
    assert_eq!(
        (
            s["profile"]["ready"].clone(),
            s["profile"]["window_open"].clone()
        ),
        (json!(true), json!(true))
    );
    assert_eq!(s["runs"].as_array().map(Vec::len), Some(1));
}

#[test]
fn profile_settings_are_validated_and_written_into_the_browser_profile() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let bad = [
        (json!({ "tags": ["x".repeat(41)] }), "INVALID_TAG"),
        (
            json!({ "tags": (0..21).map(|i| format!("t{i}")).collect::<Vec<_>>() }),
            "INVALID_TAG",
        ),
        (
            json!({ "clientId": "cli_01J9ZSEED0A010000000000000" }),
            "UNKNOWN_CLIENT",
        ),
        (
            json!({ "startUrls": ["file:///etc/passwd"] }),
            "BAD_START_URL",
        ),
        (
            json!({ "startUrls": ["--load-extension=/x"] }),
            "BAD_START_URL",
        ),
        (
            json!({ "startUrls": (0..11).map(|i| format!("https://e.test/{i}")).collect::<Vec<_>>() }),
            "BAD_START_URL",
        ),
        (json!({ "camera": "sometimes" }), "INVALID_PERMISSION"),
    ];
    for (extra, expected) in bad {
        let mut body = json!({ "profileId": known, "expectedVersion": 1 });
        for (k, v) in extra.as_object().into_iter().flatten() {
            body[k] = v.clone();
        }
        assert_eq!(
            code(&invoke(&f, "update_profile", body)).as_deref(),
            Some(expected)
        );
    }
    let updated = invoke(
        &f,
        "update_profile",
        json!({ "profileId": known, "expectedVersion": 1, "tags": ["Ads", "VIP"],
                "startUrls": ["https://shop.example/admin", "https://mail.example/"],
                "camera": "block", "microphone": "allow", "location": "ask" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(updated["permissions"]["camera"], json!("block"));
    let downloads = f.tmp.path().join("client-north-downloads");
    std::fs::create_dir_all(&downloads).unwrap_or_else(|e| panic!("{e}"));
    let id = pb_runtime::ProfileId::parse(&known).unwrap_or_else(|e| panic!("{e}"));
    f.state
        .set_profile_download_directory(&id, &downloads)
        .unwrap_or_else(|e| panic!("{e:?}"));

    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let args = f
        .launcher
        .last_args
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default();
    let tail: Vec<&str> = args
        .iter()
        .rev()
        .take(3)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(
        tail,
        ["--", "https://shop.example/admin", "https://mail.example/"],
        "start URLs after --"
    );
    assert!(
        !args
            .iter()
            .any(|a| a.contains("remote-debugging") || a == "--no-sandbox")
    );
    let prefs: Value = serde_json::from_slice(
        &std::fs::read(user_data(&f, &known).join("Default").join("Preferences"))
            .unwrap_or_default(),
    )
    .unwrap_or_default();
    assert_eq!(prefs["profile"]["name"], json!("Known · Client North"));
    assert_eq!(
        prefs["profile"]["default_content_setting_values"]["media_stream_camera"],
        json!(2)
    );
    assert_eq!(
        prefs["profile"]["default_content_setting_values"]["media_stream_mic"],
        json!(1)
    );
    assert_eq!(
        prefs["download"]["default_directory"]
            .as_str()
            .map(PathBuf::from),
        // Ordinary path form (never Windows' \\?\ verbatim form), since Chromium reads it.
        std::fs::canonicalize(&downloads)
            .ok()
            .map(|p| pb_runtime::simplify_path(&p))
    );
}

#[test]
fn unresponsive_profiles_are_offered_an_explicit_force_close() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let other =
        invoke(&f, "create_profile", json!({ "name": "Other" })).unwrap_or_else(|e| panic!("{e}"));
    let other = other["id"].as_str().unwrap_or_default().to_owned();
    for id in [&known, &other] {
        let op = invoke(&f, "launch_profile", json!({ "profileId": id }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    }
    // The first browser (pid 4000) ignores the close request.
    f.procs
        .stubborn
        .lock()
        .unwrap_or_else(|e| panic!("{e}"))
        .push(4000);
    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": known })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Failed);
    let s = status(&f, &known);
    assert_eq!(
        (
            s["profile"]["state"].clone(),
            s["profile"]["force_available"].clone()
        ),
        (json!("stopping"), json!(true))
    );
    // A launch while closing is refused rather than starting a second browser.
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": known }))).as_deref(),
        Some("PROFILE_STOPPING")
    );

    let force = invoke(
        &f,
        "stop_profile",
        json!({ "profileId": known, "force": true }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &force), OpStatus::Succeeded);
    assert_eq!(status(&f, &known)["profile"]["state"], json!("stopped"));
    assert_eq!(status(&f, &known)["runs"][0]["outcome"], json!("forced"));
    // Only the first profile's tree was killed; the other profile still runs.
    let signals = f
        .procs
        .signals
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    assert!(signals.contains(&(4000, "kill")) && signals.contains(&(4001, "kill")));
    assert!(!signals.iter().any(|(p, s)| *p >= 4010 && *s == "kill"));
    assert_eq!(status(&f, &other)["profile"]["state"], json!("running"));
}

#[test]
fn reopening_right_after_a_close_is_never_blocked_by_the_backup() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    for round in 0..5 {
        let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
            .unwrap_or_else(|e| panic!("launch {round}: {e}"));
        assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
        let stop = invoke(&f, "stop_profile", json!({ "profileId": known }))
            .unwrap_or_else(|e| panic!("stop {round}: {e}"));
        assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
        // A backup is running (the routine one after the clean close, or this one joins it) ...
        let backup = invoke(
            &f,
            "recover_profile",
            json!({ "profileId": known, "action": "backup_now" }),
        );
        // ... and the user opens the profile again straight away: the backup gives way.
        let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
            .unwrap_or_else(|e| panic!("relaunch {round}: {e}"));
        assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
        if let Ok(b) = backup {
            let finished = wait_op(&f, &b);
            assert!(matches!(finished, OpStatus::Succeeded | OpStatus::Failed));
        }
        let stop = invoke(&f, "stop_profile", json!({ "profileId": known }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while status(&f, &known)["profile"]["state"] != json!("stopped")
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    assert_eq!(status(&f, &known)["profile"]["state"], json!("stopped"));
}

#[test]
fn damaged_profiles_are_refused_and_recovered_without_losing_evidence() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    // Run once, close cleanly, take a backup.
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let ud = user_data(&f, &known);
    std::fs::write(ud.join("Default").join("Cookies"), b"good-cookies")
        .unwrap_or_else(|e| panic!("{e}"));
    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": known })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    let backup = invoke(
        &f,
        "recover_profile",
        json!({ "profileId": known, "action": "backup_now" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &backup), OpStatus::Succeeded);
    assert!(
        status(&f, &known)["backup"]["files"]
            .as_u64()
            .is_some_and(|n| n >= 2)
    );

    // The settings file gets corrupted (disk error, killed mid-write by another tool, ...).
    std::fs::write(ud.join("Default").join("Preferences"), b"{\"profile\": tru")
        .unwrap_or_else(|e| panic!("{e}"));
    let spawns = f.launcher.spawns.load(Ordering::SeqCst);
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": known }))).as_deref(),
        Some("PROFILE_DATA_UNREADABLE")
    );
    assert_eq!(
        f.launcher.spawns.load(Ordering::SeqCst),
        spawns,
        "Chromium never sees the damaged profile"
    );
    let s = status(&f, &known);
    assert_eq!(
        (
            s["profile"]["state"].clone(),
            s["suggested_recovery"].clone()
        ),
        (json!("crashed"), json!("restore_backup"))
    );

    let restore = invoke(
        &f,
        "recover_profile",
        json!({ "profileId": known, "action": "restore_backup" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &restore), OpStatus::Succeeded);
    assert_eq!(
        std::fs::read(ud.join("Default").join("Cookies")).unwrap_or_default(),
        b"good-cookies"
    );
    let s = status(&f, &known);
    assert_eq!(
        (
            s["profile"]["state"].clone(),
            s["profile"]["crash_count"].clone()
        ),
        (json!("stopped"), json!(0))
    );
    assert_eq!(
        s["evidence_count"],
        json!(1),
        "damaged data kept as evidence"
    );
    let evidence_dir = f.data().join("evidence").join(&known);
    let kept = std::fs::read_dir(&evidence_dir)
        .ok()
        .and_then(|mut d| d.next())
        .and_then(Result::ok)
        .map(|e| e.path());
    assert_eq!(
        kept.map(|k| std::fs::read(k.join("user-data/Default/Preferences")).unwrap_or_default()),
        Some(b"{\"profile\": tru".to_vec())
    );
    // The profile opens again.
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    // Recovery is refused while running.
    assert_eq!(
        code(&invoke(
            &f,
            "recover_profile",
            json!({ "profileId": known, "action": "start_fresh" })
        ))
        .as_deref(),
        Some("NOT_RECOVERABLE")
    );
}

#[test]
fn downgrades_are_refused_and_engine_upgrades_take_a_backup_first() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let ud = user_data(&f, &known);
    std::fs::create_dir_all(&ud).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(ud.join("Last Version"), "156.0.1.1").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": known }))).as_deref(),
        Some("PROFILE_NEWER_THAN_RUNTIME")
    );
    std::fs::write(ud.join("Last Version"), "150.0.1.1").unwrap_or_else(|e| panic!("{e}"));
    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let s = status(&f, &known);
    assert_eq!(
        s["backup"]["runtime_version"],
        json!("150.0.1.1"),
        "copy made by the old version"
    );
    assert_eq!(s["profile"]["runtime_version"], json!(TEST_BROWSER_VERSION));
}

#[test]
fn audit_log_records_actions_without_urls() {
    let f = fixture();
    let known = workspace_with_profile(&f);
    let op = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": known, "startUrl": "https://bank.example/login?token=SECRET123" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": known })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    let d = invoke(&f, "get_diagnostics", json!({})).unwrap_or_else(|e| panic!("{e}"));
    let actions: Vec<String> = d["recent_activity"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["action"].as_str().map(str::to_owned))
        .collect();
    for a in ["start", "stop", "exit"] {
        assert!(actions.iter().any(|x| x == a), "{a} in {actions:?}");
    }
    let text = d.to_string();
    assert!(!text.contains("SECRET123") && !text.contains("bank.example"));
}

// ------------------------------------------------------------------ signed runtime manifest + install

fn test_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[42u8; 32])
}

fn runtime_zip(dir: &Path) -> (PathBuf, String, u64) {
    let path = dir.join("rt.zip");
    let file = std::fs::File::create(&path).unwrap_or_else(|e| panic!("{e}"));
    let mut w = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
    w.start_file("chrome-test/chrome", opts)
        .unwrap_or_else(|e| panic!("{e}"));
    std::io::Write::write_all(&mut w, b"#!fake").unwrap_or_else(|e| panic!("{e}"));
    w.finish().unwrap_or_else(|e| panic!("{e}"));
    let (sha, size) = pb_update::sha256_file(&path).unwrap_or_else(|e| panic!("{e}"));
    (path, sha, size)
}

fn signed_manifest(sha: &str, size: u64) -> ((Vec<u8>, Vec<u8>), String) {
    use ed25519_dalek::Signer;
    let platform = pb_desktop_lib::state::platform();
    let manifest = format!(
        r#"{{"schema":2,"channel":"internal-alpha","created_at":"2026-10-12T00:00:00Z","distribution":{{"id":"chrome-for-testing","name":"Chrome for Testing","license":"internal","customer_distribution":false,"source":"https://googlechromelabs.github.io/chrome-for-testing/"}},"runtime":{{"version":"{TEST_BROWSER_VERSION}","revision":"1","artifacts":[{{"platform":"{platform}","url":"https://storage.googleapis.com/chrome-for-testing-public/{TEST_BROWSER_VERSION}/x/chrome.zip","sha256":"{sha}","size_bytes":{size},"format":"zip","executable":"chrome-test/chrome"}}]}}}}"#
    );
    let key = test_key();
    let sig = format!(
        r#"{{"schema":1,"key_id":"test-key","algorithm":"ed25519","signature":"{}"}}"#,
        hex::encode(key.sign(manifest.as_bytes()).to_bytes())
    );
    let keys = format!(
        r#"{{"keys":[{{"key_id":"test-key","public_key":"{}","created":"2026-10-12"}}]}}"#,
        hex::encode(key.verifying_key().to_bytes())
    );
    ((manifest.into_bytes(), sig.into_bytes()), keys)
}

#[test]
fn runtime_installs_only_from_the_signed_manifest() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (zip_path, sha, size) = runtime_zip(tmp.path());
    let (manifest, keys) = signed_manifest(&sha, size);
    let f = fixture_with(
        tmp,
        Arc::new(FakeProcesses::default()),
        Options {
            manifest,
            trusted_keys: keys,
            dev_browser: false,
            archive: Some(zip_path),
        },
    );
    let known = workspace_with_profile(&f);
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": known }))).as_deref(),
        Some("RUNTIME_NOT_INSTALLED")
    );
    let rs = invoke(&f, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        rs["browser"]["manifest_status"]["status"],
        json!("verified")
    );
    assert_eq!(
        rs["browser"]["manifest"]["customer_distribution"],
        json!(false)
    );
    assert_eq!(
        code(&invoke(
            &f,
            "install_runtime",
            json!({ "version": "1.2.3.4" })
        ))
        .as_deref(),
        Some("RUNTIME_NOT_IN_MANIFEST")
    );
    let op = invoke(
        &f,
        "install_runtime",
        json!({ "version": TEST_BROWSER_VERSION }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let rs = invoke(&f, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (
            rs["browser"]["configured"].clone(),
            rs["browser"]["source"].clone()
        ),
        (json!(true), json!("manifest"))
    );
    assert_eq!(rs["installations"][0]["status"], json!("verified"));

    let op = invoke(&f, "launch_profile", json!({ "profileId": known }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let exe = f
        .launcher
        .last_executable
        .lock()
        .ok()
        .and_then(|e| e.clone())
        .unwrap_or_default();
    assert!(
        exe.starts_with(f.data().join("runtimes").join("installed"))
            && exe.ends_with("chrome-test/chrome")
    );
}

#[test]
fn tampered_downloads_and_unsigned_manifests_are_refused() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (zip_path, sha, size) = runtime_zip(tmp.path());
    let (manifest, keys) = signed_manifest(&sha, size);
    // The download is swapped for different bytes of the same size.
    let mut bytes = std::fs::read(&zip_path).unwrap_or_default();
    if let Some(b) = bytes.last_mut() {
        *b ^= 0xff;
    }
    let evil = tmp.path().join("evil.zip");
    std::fs::write(&evil, bytes).unwrap_or_else(|e| panic!("{e}"));
    let f = fixture_with(
        tmp,
        Arc::new(FakeProcesses::default()),
        Options {
            manifest: manifest.clone(),
            trusted_keys: keys,
            dev_browser: false,
            archive: Some(evil),
        },
    );
    let op = invoke(
        &f,
        "install_runtime",
        json!({ "version": TEST_BROWSER_VERSION }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Failed);
    assert!(
        f.state
            .ops
            .list()
            .iter()
            .any(|o| o.error_code == Some("ARTIFACT_QUARANTINED"))
    );
    let rs = invoke(&f, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (
            rs["quarantined"].clone(),
            rs["browser"]["configured"].clone()
        ),
        (json!(1), json!(false))
    );

    // A manifest signed by a key the build does not trust is not used at all.
    let f2 = fixture_with(
        tempfile::tempdir().unwrap_or_else(|e| panic!("{e}")),
        Arc::new(FakeProcesses::default()),
        Options {
            manifest,
            dev_browser: false,
            ..Options::default()
        },
    );
    let rs = invoke(&f2, "get_runtime_status", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(rs["browser"]["manifest_status"]["status"], json!("invalid"));
    assert_eq!(
        code(&invoke(
            &f2,
            "install_runtime",
            json!({ "version": TEST_BROWSER_VERSION })
        ))
        .as_deref(),
        Some("RUNTIME_UNAVAILABLE")
    );
}

// ---------------------------------------------------------------------------------------------- milestone 04

fn page(f: &Fixture, body: Value) -> Value {
    invoke(f, "query_profiles", body).unwrap_or_else(|e| panic!("{e}"))
}

fn names(v: &Value) -> Vec<String> {
    v["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|r| r["name"].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn create(f: &Fixture, name: &str, client: Option<&str>) -> String {
    let mut body = json!({ "name": name });
    if let Some(c) = client {
        body["client"] = json!(c);
    }
    invoke(f, "create_profile", body).unwrap_or_else(|e| panic!("{e}"))["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn profile_table_pages_filters_sorts_and_rejects_stale_cursors() {
    let f = fixture();
    invoke(&f, "create_workspace", json!({ "name": "Agency" })).unwrap_or_else(|e| panic!("{e}"));
    for i in 0..30 {
        create(
            &f,
            &format!("Profile {i:02}"),
            Some(if i % 2 == 0 { "North" } else { "South" }),
        );
    }
    create(&f, "Same name", None);
    create(&f, "Same name", None); // names need not be unique
    let first = page(&f, json!({ "limit": 10 }));
    assert_eq!(first["total"], json!(32));
    assert_eq!(names(&first)[0], "Profile 00");
    let cursor = first["next_cursor"].as_str().unwrap_or_default().to_owned();
    let second = page(&f, json!({ "limit": 10, "cursor": cursor }));
    assert_eq!(names(&second)[0], "Profile 10");
    // The virtualized table jumps straight to the page in view.
    let jumped = page(&f, json!({ "limit": 10, "offset": 25 }));
    assert_eq!(names(&jumped)[0], "Profile 25");
    assert_eq!(jumped["total"], json!(32));
    assert_eq!(page(&f, json!({ "offset": 9000 }))["rows"], json!([]));
    // A cursor belongs to its filter.
    assert_eq!(
        code(&invoke(
            &f,
            "query_profiles",
            json!({ "cursor": cursor, "filter": { "text": "north" } })
        ))
        .as_deref(),
        Some("CURSOR_STALE")
    );
    let lib = invoke(&f, "get_library", json!({})).unwrap_or_else(|e| panic!("{e}"));
    let north = lib["clients"]
        .as_array()
        .and_then(|c| c.iter().find(|c| c["name"] == "North"))
        .map(|c| c["id"].clone())
        .unwrap_or_default();
    assert_eq!(lib["counts"]["active"], json!(32));
    assert_eq!(lib["counts"]["without_client"], json!(2));
    let by_client = page(
        &f,
        json!({ "filter": { "client": { "kind": "ids", "ids": [north] } }, "limit": 500 }),
    );
    assert_eq!(by_client["total"], json!(15));
    let by_text = page(&f, json!({ "filter": { "text": "SOUTH" } }));
    assert_eq!(
        by_text["total"],
        json!(15),
        "client names are searchable, case-insensitively"
    );
    let desc = page(
        &f,
        json!({ "sort": { "key": "name", "descending": true }, "limit": 1 }),
    );
    assert_eq!(names(&desc), ["Same name"]);
    // Unknown filter fields and oversized text are refused before any query runs.
    assert!(invoke(&f, "query_profiles", json!({ "filter": { "sql": "1=1" } })).is_err());
    assert_eq!(
        code(&invoke(
            &f,
            "query_profiles",
            json!({ "filter": { "text": "x".repeat(201) } })
        ))
        .as_deref(),
        Some("INVALID_FILTER")
    );
}

#[test]
fn bulk_actions_report_each_profile_refuse_running_ones_and_undo() {
    let f = fixture();
    let running = workspace_with_profile(&f);
    let idle = create(&f, "Idle", Some("Client North"));
    let op = invoke(&f, "launch_profile", json!({ "profileId": running }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let ghost = "prf_01J9ZSEED0A010000000000000";

    let r = invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "trash" }, "selection": { "kind": "ids", "ids": [running, idle, ghost] } }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (r["requested"].clone(), r["changed"].clone()),
        (json!(3), json!(1))
    );
    let failed: Vec<(String, String)> = r["failed"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|x| {
            (
                x["id"].as_str().unwrap_or_default().to_owned(),
                x["code"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert!(
        failed.contains(&(running.clone(), "PROFILE_RUNNING".into())),
        "{failed:?}"
    );
    assert!(failed.contains(&(ghost.to_owned(), "UNKNOWN_PROFILE".into())));
    let trash = page(&f, json!({ "filter": { "view": "trash" } }));
    assert_eq!(names(&trash), ["Idle"]);
    assert!(trash["rows"][0]["purge_after"].is_string());
    assert_eq!(
        code(&invoke(&f, "launch_profile", json!({ "profileId": idle }))).as_deref(),
        Some("PROFILE_IN_TRASH")
    );

    // Undo restores exactly what changed.
    let undone = invoke(&f, "undo_action", json!({ "token": r["undo_token"] }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(undone["restored"], json!(1));
    assert_eq!(
        page(&f, json!({ "filter": { "view": "trash" } }))["total"],
        json!(0)
    );
    assert_eq!(
        code(&invoke(
            &f,
            "undo_action",
            json!({ "token": r["undo_token"] })
        ))
        .as_deref(),
        Some("UNDO_EXPIRED"),
        "one undo per action"
    );

    // "Select all matching": the count the user saw must still be true.
    let all = json!({ "kind": "filter", "filter": {}, "expected_total": 5 });
    assert_eq!(
        code(&invoke(
            &f,
            "bulk_profiles",
            json!({ "action": { "action": "favourite", "value": true }, "selection": all })
        ))
        .as_deref(),
        Some("SELECTION_CHANGED")
    );
    let all = json!({ "kind": "filter", "filter": {}, "expected_total": 2 });
    let tagged = invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "add_tag", "tag_name": "VIP" }, "selection": all }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(tagged["changed"], json!(2));
    let rows = page(&f, json!({}));
    assert!(
        rows["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .all(|r| r["tags"][0]["name"] == "VIP")
    );
    // Moving to a client of the same workspace; archiving hides from the active view.
    let lib = invoke(&f, "get_library", json!({})).unwrap_or_else(|e| panic!("{e}"));
    let client = lib["clients"][0]["id"].clone();
    let moved = invoke(&f, "bulk_profiles", json!({ "action": { "action": "move", "client_id": client }, "selection": { "kind": "ids", "ids": [running] } }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(moved["unchanged"], json!(1), "already in that client");
    invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "archive" }, "selection": { "kind": "ids", "ids": [idle] } }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        names(&page(&f, json!({ "filter": { "view": "archived" } }))),
        ["Idle"]
    );
    assert_eq!(
        code(&invoke(
            &f,
            "bulk_profiles",
            json!({ "action": { "action": "trash" }, "selection": { "kind": "ids", "ids": [] } })
        ))
        .as_deref(),
        Some("NOTHING_SELECTED")
    );
}

#[test]
fn permanent_deletion_needs_confirmation_the_trash_and_no_live_process() {
    let f = fixture();
    let _keep = workspace_with_profile(&f);
    let doomed = create(&f, "Doomed", None);
    let foreign = create(&f, "Used elsewhere", None);
    for id in [&doomed, &foreign] {
        let op = invoke(&f, "launch_profile", json!({ "profileId": id }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
        let stop = invoke(&f, "stop_profile", json!({ "profileId": id }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    }
    let pid = |id: &str| pb_runtime::ProfileId::parse(id).unwrap_or_else(|e| panic!("{e}"));
    let dirs = |id: &str| f.state.root.dirs(&pid(id));
    let backup = f.data().join("backups").join(&doomed).join("last-good");
    std::fs::create_dir_all(&backup).unwrap_or_else(|e| panic!("{e}"));
    let sel = |v: &[&String]| json!({ "kind": "ids", "ids": v });

    // Only from the trash.
    let r = invoke(
        &f,
        "delete_profiles",
        json!({ "selection": sel(&[&doomed]), "confirm": "DELETE", "expectedCount": 1 }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (r["changed"].clone(), r["failed"][0]["code"].clone()),
        (json!(0), json!("NOT_IN_TRASH"))
    );
    invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "trash" }, "selection": sel(&[&doomed, &foreign]) }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    // Exact confirmation of exactly the selected profiles.
    for (confirm, count) in [("delete", 2), ("DELETE", 1), ("", 2)] {
        assert_eq!(
            code(&invoke(&f, "delete_profiles", json!({ "selection": sel(&[&doomed, &foreign]), "confirm": confirm, "expectedCount": count }))).as_deref(),
            Some("CONFIRMATION_REQUIRED")
        );
    }
    // Another browser program is still writing into the second profile's folder.
    f.procs.add_full(
        9999,
        None,
        1,
        "/usr/bin/chromium",
        vec![format!(
            "--user-data-dir={}",
            dirs(&foreign).user_data.display()
        )],
    );
    let r = invoke(
        &f,
        "delete_profiles",
        json!({ "selection": sel(&[&doomed, &foreign]), "confirm": "DELETE", "expectedCount": 2 }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(r["changed"], json!(1));
    assert_eq!(
        (r["failed"][0]["id"].clone(), r["failed"][0]["code"].clone()),
        (json!(foreign), json!("PROFILE_RUNNING"))
    );
    assert!(!dirs(&doomed).root.exists(), "folder removed");
    assert!(!backup.exists(), "backups removed");
    assert!(
        dirs(&foreign).root.exists(),
        "a folder in use is never removed"
    );
    assert_eq!(
        code(&invoke(
            &f,
            "get_profile_status",
            json!({ "profileId": doomed })
        ))
        .as_deref(),
        Some("UNKNOWN_PROFILE")
    );
    assert_eq!(
        page(&f, json!({ "filter": { "view": "trash" } }))["total"],
        json!(1)
    );
    let leftovers = std::fs::read_dir(f.data().join("profiles"))
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".deleting"))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(leftovers, 0);

    // Retention: once the process is gone and the date has passed, the purge removes it.
    f.procs.remove(9999);
    {
        let conn =
            rusqlite::Connection::open(f.data().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
        conn.execute(
            "update trash_entries set purge_after = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    }
    assert_eq!(f.state.purge_expired_trash(), 1);
    assert!(!dirs(&foreign).root.exists());
    let audit = f
        .state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .list_audit(None, 50)
        .unwrap_or_default();
    assert!(audit.iter().any(|a| a.action == "delete"));
    assert!(audit.iter().any(|a| a.action == "purge"));
}

#[test]
fn trash_and_deletion_never_race_a_backup_of_the_profile() {
    let f = fixture();
    let id = workspace_with_profile(&f);
    let op =
        invoke(&f, "launch_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let stop =
        invoke(&f, "stop_profile", json!({ "profileId": id })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &stop), OpStatus::Succeeded);
    // A backup of the just-closed profile (the routine one after a clean close, or this requested one) is running.
    let backup = invoke(
        &f,
        "recover_profile",
        json!({ "profileId": id, "action": "backup_now" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let sel = json!({ "kind": "ids", "ids": [id] });
    // Trashing only changes metadata, so a backup does not block it.
    let r = invoke(
        &f,
        "bulk_profiles",
        json!({ "action": { "action": "trash" }, "selection": sel }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (r["changed"].clone(), r["failed"].clone()),
        (json!(1), json!([]))
    );
    // Recovery actions are refused while the profile is in the trash.
    assert_eq!(
        code(&invoke(
            &f,
            "recover_profile",
            json!({ "profileId": id, "action": "start_fresh" })
        ))
        .as_deref(),
        Some("PROFILE_IN_TRASH")
    );
    // Permanent deletion cancels the backup first and leaves nothing of the profile behind.
    let r = invoke(
        &f,
        "delete_profiles",
        json!({ "selection": sel, "confirm": "DELETE", "expectedCount": 1 }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (r["changed"].clone(), r["failed"].clone()),
        (json!(1), json!([]))
    );
    let _ = wait_op(&f, &backup);
    let pid = pb_runtime::ProfileId::parse(&id).unwrap_or_else(|e| panic!("{e}"));
    assert!(!f.state.root.dirs(&pid).root.exists());
    assert!(
        !f.data().join("backups").join(&id).exists(),
        "no backup of a deleted profile"
    );
    let leftovers = std::fs::read_dir(f.data().join("profiles"))
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".deleting"))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(leftovers, 0);
}

#[test]
fn templates_and_duplicates_copy_configuration_never_browser_data() {
    let f = fixture();
    let src = workspace_with_profile(&f);
    invoke(
        &f,
        "update_profile",
        json!({ "profileId": src, "expectedVersion": 1, "tags": ["Ads"], "startUrls": ["https://shop.example/"],
                "camera": "block", "notes": "only for this account" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    // The source profile has browser data (a signed-in session).
    let pid = |id: &str| pb_runtime::ProfileId::parse(id).unwrap_or_else(|e| panic!("{e}"));
    let src_dirs = f
        .state
        .root
        .ensure(&pid(&src))
        .unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(src_dirs.user_data.join("Default")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        src_dirs.user_data.join("Default").join("Cookies"),
        b"session",
    )
    .unwrap_or_else(|e| panic!("{e}"));

    let t = invoke(
        &f,
        "save_template",
        json!({ "profileId": src, "name": "Shop setup" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(t["config"]["camera"], json!("block"));
    assert_eq!(
        t["config"]["notes"],
        json!(""),
        "notes are per account, not template material"
    );
    let from_t = invoke(
        &f,
        "create_profile",
        json!({ "name": "From template", "templateId": t["id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let dup = invoke(
        &f,
        "duplicate_profile",
        json!({ "profileId": src, "name": "Copy" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    for p in [&from_t, &dup] {
        assert_eq!(p["start_urls"], json!(["https://shop.example/"]));
        assert_eq!(p["permissions"]["camera"], json!("block"));
        assert_eq!(p["tags"][0]["name"], json!("Ads"));
        let id = p["id"].as_str().unwrap_or_default();
        let ud = f.state.root.dirs(&pid(id)).user_data;
        assert!(
            !ud.join("Default").join("Cookies").exists(),
            "storage starts empty"
        );
    }
    assert_eq!(dup["client_name"], json!("Client North"));
    assert_eq!(dup["notes"], json!(""));
    invoke(&f, "delete_template", json!({ "templateId": t["id"] }))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        code(&invoke(
            &f,
            "create_profile",
            json!({ "name": "x", "templateId": t["id"] })
        ))
        .as_deref(),
        Some("UNKNOWN_TEMPLATE")
    );
}

fn write_file(f: &Fixture, name: &str, content: &[u8]) -> PathBuf {
    let p = f.tmp.path().join(name);
    std::fs::write(&p, content).unwrap_or_else(|e| panic!("{e}"));
    p
}

fn file_ref(f: &Fixture, path: &Path) -> String {
    f.state
        .register_import_file(path)
        .unwrap_or_else(|e| panic!("{e:?}"))
        .file_ref
        .unwrap_or_default()
}

fn job(f: &Fixture, id: &Value) -> Value {
    invoke(f, "list_imports", json!({}))
        .unwrap_or_else(|e| panic!("{e}"))
        .as_array()
        .and_then(|jobs| jobs.iter().find(|j| &j["id"] == id).cloned())
        .unwrap_or(Value::Null)
}

#[test]
fn import_preview_binds_the_file_reports_rows_and_never_duplicates_on_retry() {
    let f = fixture();
    let _existing = workspace_with_profile(&f); // "Known" of "Client North"
    let long_note = "n".repeat(2001);
    let csv = [
        "name,client,tags,notes,start_urls,camera",
        "Known,Client North,,,,",
        "École 😀,Ünïcode,Ads;VIP,,https://shop.example/,block",
        ",Missing name,,,,",
        "Bad url,,,,javascript:alert(1),",
        "'=SUM(1+1),,,,,",
        &format!("Long note,,,{long_note},,"),
        "Twice,North,,,,",
        "Twice,North,,,,",
    ]
    .join("\n")
        + "\n";
    let path = write_file(&f, "clients.csv", csv.as_bytes());
    let fr = file_ref(&f, &path);
    let preview =
        invoke(&f, "preview_import", json!({ "fileRef": fr })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(preview["format"], json!("csv"));
    assert_eq!(
        (
            preview["total"].clone(),
            preview["invalid"].clone(),
            preview["will_create"].clone(),
            preview["will_skip"].clone()
        ),
        (json!(8), json!(3), json!(3), json!(2)),
        "{preview}"
    );
    let errors: Vec<(u64, String)> = preview["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            (
                e["row"].as_u64().unwrap_or(0),
                e["code"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert!(errors.contains(&(4, "required".into())), "{errors:?}");
    assert!(errors.contains(&(5, "invalid_url".into())));
    assert!(errors.contains(&(7, "too_long".into())));
    assert_eq!(preview["new_clients"], json!(["Ünïcode", "North"]));
    // Nothing was written by the preview (dry run).
    assert_eq!(page(&f, json!({}))["total"], json!(1));

    // The file changes after the preview: the commit is refused.
    std::fs::write(&path, format!("{csv}Extra,,,,,\n")).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        code(&invoke(
            &f,
            "commit_import",
            json!({ "previewId": preview["preview_id"] })
        ))
        .as_deref(),
        Some("SOURCE_CHANGED")
    );
    std::fs::write(&path, &csv).unwrap_or_else(|e| panic!("{e}"));
    let op = invoke(
        &f,
        "commit_import",
        json!({ "previewId": preview["preview_id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let j = job(&f, &preview["preview_id"]);
    assert_eq!(
        (
            j["status"].clone(),
            j["succeeded"].clone(),
            j["failed"].clone(),
            j["skipped"].clone()
        ),
        (json!("completed_with_errors"), json!(3), json!(3), json!(2)),
        "{j}"
    );
    let all = page(&f, json!({ "limit": 50 }));
    assert_eq!(all["total"], json!(4));
    assert!(
        names(&all).contains(&"=SUM(1+1)".to_owned()),
        "formula text kept as text"
    );
    let ecole = all["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == "École 😀")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        (
            ecole["client_name"].clone(),
            ecole["permissions"]["camera"].clone()
        ),
        (json!("Ünïcode"), json!("block"))
    );
    assert_eq!(ecole["tags"].as_array().map(Vec::len), Some(2));

    // Retry of the same file: every row already imported is recognised, nothing is duplicated.
    let op = invoke(
        &f,
        "commit_import",
        json!({ "previewId": preview["preview_id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    assert_eq!(page(&f, json!({}))["total"], json!(4));
    let again =
        invoke(&f, "preview_import", json!({ "fileRef": fr })).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(again["already_imported"], json!(3));

    // Duplicate policy "update" changes the existing profile instead of skipping it.
    let doc = json!({
        "format": "project-browser.profiles", "schema_version": 1,
        "profiles": [{ "name": "known", "client": "client north", "tags": ["Updated"], "location": "allow" }]
    });
    let upd = write_file(&f, "update.json", doc.to_string().as_bytes());
    let pv = invoke(
        &f,
        "preview_import",
        json!({ "fileRef": file_ref(&f, &upd), "settings": { "duplicates": "update" } }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(pv["will_update"], json!(1), "{pv}");
    let op = invoke(
        &f,
        "commit_import",
        json!({ "previewId": pv["preview_id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(wait_op(&f, &op), OpStatus::Succeeded);
    let known = page(&f, json!({ "filter": { "text": "known" } }));
    assert_eq!(known["rows"][0]["permissions"]["location"], json!("allow"));
    assert_eq!(known["total"], json!(1));
}

#[test]
fn ten_thousand_row_import_can_be_cancelled_and_resumed_without_duplicates() {
    let f = fixture();
    invoke(&f, "create_workspace", json!({ "name": "Agency" })).unwrap_or_else(|e| panic!("{e}"));
    let mut csv = String::from("name,client,tags\n");
    for i in 0..10_000 {
        csv.push_str(&format!(
            "Account {i},Client {},Batch;Tag {}\n",
            i % 200,
            i % 7
        ));
    }
    let path = write_file(&f, "big.csv", csv.as_bytes());
    let started = std::time::Instant::now();
    let preview = invoke(
        &f,
        "preview_import",
        json!({ "fileRef": file_ref(&f, &path) }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(preview["will_create"], json!(10_000));
    assert_eq!(
        preview["rows"].as_array().map(Vec::len),
        Some(500),
        "the preview shows a bounded number of rows"
    );
    let op = invoke(
        &f,
        "commit_import",
        json!({ "previewId": preview["preview_id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let job_id = pb_runtime::ImportJobId::parse(preview["preview_id"].as_str().unwrap_or_default())
        .unwrap_or_else(|e| panic!("{e}"));
    // Cancel once some rows are in.
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while job(&f, &preview["preview_id"])["succeeded"]
        .as_u64()
        .unwrap_or(0)
        == 0
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = f.state.cancel_import(&job_id);
    assert_eq!(
        wait_op_for(&f, &op, Duration::from_secs(120)),
        OpStatus::Failed,
        "a cancelled import ends as cancelled"
    );
    let partial = job(&f, &preview["preview_id"]);
    assert_eq!(partial["status"], json!("cancelled"));
    let imported = partial["succeeded"].as_u64().unwrap_or(0);
    assert!(imported > 0 && imported < 10_000, "{partial}");
    assert_eq!(page(&f, json!({}))["total"], json!(imported));

    // Resume: only the remaining rows are created.
    let op = invoke(
        &f,
        "commit_import",
        json!({ "previewId": preview["preview_id"] }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    // Debug builds on Windows CI runners need well over 20 s for the remaining ~9,000 rows.
    assert_eq!(
        wait_op_for(&f, &op, Duration::from_secs(180)),
        OpStatus::Succeeded,
        "{:?}",
        job(&f, &preview["preview_id"])
    );
    let done = job(&f, &preview["preview_id"]);
    assert_eq!(done["status"], json!("completed"));
    assert_eq!(
        done["succeeded"].as_u64().unwrap_or(0) + done["skipped"].as_u64().unwrap_or(0),
        10_000
    );
    assert_eq!(page(&f, json!({}))["total"], json!(10_000), "no duplicates");
    let lib = invoke(&f, "get_library", json!({})).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(lib["clients"].as_array().map(Vec::len), Some(200));
    assert_eq!(lib["tags"].as_array().map(Vec::len), Some(8));
    let peak = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|t| {
            t.lines()
                .find(|l| l.starts_with("VmHWM"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "VmHWM n/a".into());
    eprintln!(
        "10,000-row preview + import + resume: {:.1} s ({} build); process peak memory {}",
        started.elapsed().as_secs_f64(),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        peak.split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ")
    );
}

#[test]
fn unsafe_or_unsupported_import_files_are_reported_not_imported() {
    let f = fixture();
    invoke(&f, "create_workspace", json!({ "name": "Agency" })).unwrap_or_else(|e| panic!("{e}"));
    let zip_with = |entries: &[(&str, &[u8])]| -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (n, d) in entries {
                w.start_file(*n, zip::write::SimpleFileOptions::default())
                    .unwrap_or_else(|e| panic!("{e}"));
                std::io::Write::write_all(&mut w, d).unwrap_or_else(|e| panic!("{e}"));
            }
            w.finish().unwrap_or_else(|e| panic!("{e}"));
        }
        buf.into_inner()
    };
    let manifest =
        json!({ "format": "project-browser.export", "schema_version": 1, "cookies": true })
            .to_string();
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "traversal.zip",
            zip_with(&[("../../evil.json", b"{}")]),
            "UNSAFE_ARCHIVE",
        ),
        (
            "session.zip",
            zip_with(&[
                ("manifest.json", manifest.as_bytes()),
                ("profiles.json", b"{}"),
            ]),
            "SESSION_DATA_NOT_SUPPORTED",
        ),
        (
            "schema.json",
            br#"{"format":"project-browser.profiles","schema_version":9,"profiles":[]}"#.to_vec(),
            "UNSUPPORTED_SCHEMA",
        ),
        ("cols.csv", b"name,cookie\nA,x\n".to_vec(), "BAD_COLUMNS"),
        (
            "binary.csv",
            b"name\n\xff\xfe\x00\n".to_vec(),
            "FILE_NOT_UTF8",
        ),
    ];
    for (name, bytes, expected) in cases {
        let path = write_file(&f, name, &bytes);
        let pv = invoke(
            &f,
            "preview_import",
            json!({ "fileRef": file_ref(&f, &path) }),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(pv["file_error"]["code"], json!(expected), "{name}: {pv}");
        assert!(pv["preview_id"].is_null(), "nothing can be committed");
    }
    let big = write_file(&f, "big.csv", &vec![b'a'; 21 * 1024 * 1024]);
    assert_eq!(
        code(&invoke(
            &f,
            "preview_import",
            json!({ "fileRef": file_ref(&f, &big) })
        ))
        .as_deref(),
        Some("FILE_TOO_LARGE")
    );
    assert_eq!(
        code(&invoke(
            &f,
            "preview_import",
            json!({ "fileRef": "0".repeat(32) })
        ))
        .as_deref(),
        Some("UNKNOWN_FILE")
    );
}

#[test]
fn export_holds_configuration_only_withholds_secret_notes_and_escapes_formulas() {
    let f = fixture();
    let a = workspace_with_profile(&f);
    let b = create(&f, "=HYPERLINK(\"http://evil\")", None);
    // New notes that look like secrets are refused; older data may still hold some, so export checks again.
    assert_eq!(
        code(&invoke(
            &f,
            "update_profile",
            json!({ "profileId": a, "expectedVersion": 1, "notes": "Password: hunter2" }),
        ))
        .as_deref(),
        Some("NOTES_LOOK_SECRET")
    );
    let pa = pb_runtime::ProfileId::parse(&a).unwrap_or_else(|e| panic!("{e}"));
    f.state
        .store()
        .unwrap_or_else(|e| panic!("{e:?}"))
        .update_profile(
            &pa,
            pb_storage::ProfileUpdate {
                notes: Some("Password: hunter2"),
                ..Default::default()
            },
            1,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    // Hidden characters are removed from notes.
    let saved = invoke(
        &f,
        "update_profile",
        json!({ "profileId": b, "expectedVersion": 1, "notes": "pay\u{202E}lbuod\u{7}" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(saved["notes"], json!("paylbuod"));
    invoke(
        &f,
        "update_profile",
        json!({ "profileId": b, "expectedVersion": 2, "notes": "Call on Mondays" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let downloads = f.tmp.path().join("dl");
    std::fs::create_dir_all(&downloads).unwrap_or_else(|e| panic!("{e}"));
    f.state
        .set_profile_download_directory(
            &pb_runtime::ProfileId::parse(&a).unwrap_or_else(|e| panic!("{e}")),
            &downloads,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    let sel: pb_desktop_lib::manage::Selection =
        serde_json::from_value(json!({ "kind": "filter", "filter": {}, "expected_total": 2 }))
            .unwrap_or_else(|e| panic!("{e}"));
    let csv = f
        .state
        .prepare_export(
            sel.clone(),
            pb_desktop_lib::transfer::ExportFormat::Csv,
            true,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!((csv.count, csv.notes_withheld), (2, 1));
    let text = String::from_utf8_lossy(&csv.bytes).into_owned();
    assert!(
        !text.contains("hunter2"),
        "secret-looking notes are withheld"
    );
    assert!(text.contains("Call on Mondays"));
    assert!(text.contains("'=HYPERLINK"), "formula neutralised");
    assert!(
        !text.contains(&downloads.display().to_string()),
        "no local paths"
    );
    let out = f.tmp.path().join("out.csv");
    let written = f
        .state
        .write_export(&out, &csv)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(written.exported, 2);
    // Round trip: the export is a valid import.
    let parsed = pb_import::parse("out.csv", &std::fs::read(&out).unwrap_or_default())
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(parsed.rows.iter().all(|r| r.outcome.is_ok()));
    for format in [
        pb_desktop_lib::transfer::ExportFormat::Json,
        pb_desktop_lib::transfer::ExportFormat::Bundle,
    ] {
        let e = f
            .state
            .prepare_export(sel.clone(), format, false)
            .unwrap_or_else(|e| panic!("{e:?}"));
        let parsed =
            pb_import::parse(&e.suggested_name, &e.bytes).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(parsed.rows.len(), 2);
        assert!(
            parsed
                .rows
                .iter()
                .all(|r| r.outcome.as_ref().is_ok_and(|p| p.notes.is_empty())),
            "notes excluded on request"
        );
    }
}
