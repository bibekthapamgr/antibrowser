//! Milestone 02/03 IPC acceptance tests. They drive the real Tauri pipeline (mock runtime, real capability/ACL and
//! argument deserialization, real command bodies and SQLite) with a fake process table instead of a browser.
//! Real-browser isolation tests are in `tests/browser.rs`.
//!
//! Covers: invalid IPC path, oversized requests and disallowed URLs are rejected; only allow-listed commands are
//! reachable and only from the bundled origin; workspace -> profile -> profile settings flow; operation ids and
//! events for launch/stop; migration failure and crash recovery; interrupted installs; re-attaching profiles that
//! kept running while the manager was closed.

use pb_desktop_lib::events::RecordingSink;
use pb_desktop_lib::operations::OpStatus;
use pb_desktop_lib::runtime::{Fetcher, RuntimeConfig, TRUSTED_KEYS};
use pb_desktop_lib::state::AppState;
use pb_desktop_lib::supervisor::fake::FakeProcesses;
use pb_desktop_lib::{context, handler};
use pb_runtime::{BrowserInstall, LaunchError, LaunchSpec, Launcher, Spawned};
use pb_update::install::{ArtifactSource, LocalFile};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

#[cfg(windows)]
const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const APP_ORIGIN: &str = "tauri://localhost";

/// Starts nothing real: records the spec and registers a fake browser (main process with the real argument list
/// plus one renderer), so tree discovery, readiness and adoption run as with a real browser.
struct FakeLauncher {
    procs: Arc<FakeProcesses>,
    spawns: AtomicUsize,
    next_pid: AtomicU32,
    last_executable: Mutex<Option<PathBuf>>,
    last_args: Mutex<Vec<String>>,
    /// The next browser "crashes" immediately (its process never appears).
    die_immediately: AtomicBool,
}

impl Launcher for FakeLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Spawned, LaunchError> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        if let Ok(mut l) = self.last_executable.lock() {
            *l = Some(spec.executable.clone());
        }
        if let Ok(mut l) = self.last_args.lock() {
            *l = args.clone();
        }
        let pid = self.next_pid.fetch_add(10, Ordering::SeqCst);
        if self.die_immediately.swap(false, Ordering::SeqCst) {
            return Ok(Spawned { pid, child: None });
        }
        let exe = spec.executable.to_string_lossy().into_owned();
        let mut main_args = vec![exe.clone()];
        main_args.extend(args);
        self.procs
            .add_full(pid, Some(1), 1_000 + u64::from(pid), &exe, main_args);
        self.procs.add_full(
            pid + 1,
            Some(pid),
            1_000 + u64::from(pid),
            &exe,
            vec![exe.clone(), "--type=renderer".into()],
        );
        Ok(Spawned { pid, child: None })
    }
}

/// Serves runtime archives from local files instead of the network.
struct FakeFetcher {
    archive: Mutex<Option<PathBuf>>,
}

impl Fetcher for FakeFetcher {
    fn source(
        &self,
        _url: &str,
        _size: u64,
        _cancel: Arc<AtomicBool>,
    ) -> std::io::Result<Box<dyn ArtifactSource>> {
        let path = self
            .archive
            .lock()
            .ok()
            .and_then(|a| a.clone())
            .ok_or_else(|| std::io::Error::other("offline"))?;
        Ok(Box::new(LocalFile(path)))
    }
}

struct Options {
    manifest: (Vec<u8>, Vec<u8>),
    trusted_keys: String,
    dev_browser: bool,
    archive: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            manifest: (vec![], vec![]),
            trusted_keys: TRUSTED_KEYS.to_owned(),
            dev_browser: true,
            archive: None,
        }
    }
}

struct Fixture {
    tmp: tempfile::TempDir,
    webview: tauri::WebviewWindow<MockRuntime>,
    _app: tauri::App<MockRuntime>,
    state: Arc<AppState>,
    launcher: Arc<FakeLauncher>,
    procs: Arc<FakeProcesses>,
    browser: PathBuf,
    events: Arc<RecordingSink>,
}

impl Fixture {
    fn data(&self) -> PathBuf {
        self.tmp.path().join("data")
    }
}

const TEST_BROWSER_VERSION: &str = "155.0.8059.39";

fn fixture_in(tmp: tempfile::TempDir, procs: Arc<FakeProcesses>) -> Fixture {
    fixture_with(tmp, procs, Options::default())
}

fn fixture_with(tmp: tempfile::TempDir, procs: Arc<FakeProcesses>, opts: Options) -> Fixture {
    let browser = tmp.path().join("trusted-browser");
    std::fs::write(&browser, b"").unwrap_or_else(|e| panic!("{e}"));
    let launcher = Arc::new(FakeLauncher {
        procs: procs.clone(),
        spawns: AtomicUsize::new(0),
        next_pid: AtomicU32::new(4000),
        last_executable: Mutex::new(None),
        last_args: Mutex::new(vec![]),
        die_immediately: AtomicBool::new(false),
    });
    let events = Arc::new(RecordingSink::default());
    let state = AppState::build(
        &tmp.path().join("data"),
        RuntimeConfig {
            manifest: opts.manifest,
            trusted_keys: opts.trusted_keys,
            dev_override: opts.dev_browser.then(|| BrowserInstall {
                executable: browser.clone(),
                revision: TEST_BROWSER_VERSION.into(),
            }),
            fetcher: Arc::new(FakeFetcher {
                archive: Mutex::new(opts.archive),
            }),
            switches: vec![],
        },
        launcher.clone(),
        procs.clone(),
        events.clone(),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    // The real plugins are registered (as in the app) so the capability ACL, not their absence, is what denies them.
    let app = mock_builder()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .invoke_handler(handler())
        .build(context())
        .unwrap_or_else(|e| panic!("{e}"));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap_or_else(|e| panic!("{e}"));
    Fixture {
        tmp,
        webview,
        _app: app,
        state,
        launcher,
        procs,
        browser,
        events,
    }
}

fn fixture() -> Fixture {
    fixture_in(
        tempfile::tempdir().unwrap_or_else(|e| panic!("{e}")),
        Arc::new(FakeProcesses::default()),
    )
}

fn invoke_from(f: &Fixture, origin: &str, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        &f.webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap_or_else(|e| panic!("{e}")),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap_or(Value::Null))
}

fn invoke(f: &Fixture, cmd: &str, body: Value) -> Result<Value, Value> {
    invoke_from(f, APP_ORIGIN, cmd, body)
}

fn code(r: &Result<Value, Value>) -> Option<String> {
    r.as_ref()
        .err()
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Creates a workspace and one profile; returns the profile id.
fn workspace_with_profile(f: &Fixture) -> String {
    invoke(f, "create_workspace", json!({ "name": "Agency" })).unwrap_or_else(|e| panic!("{e}"));
    let p = invoke(
        f,
        "create_profile",
        json!({ "name": "Known", "clientLabel": "Client North" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    p["id"].as_str().unwrap_or_default().to_owned()
}

fn wait_op(f: &Fixture, op: &Value) -> OpStatus {
    let id = op["operation_id"].as_str().unwrap_or_default();
    f.state
        .ops
        .wait(id, Duration::from_secs(20))
        .map(|o| o.status)
        .unwrap_or(OpStatus::Failed)
}

fn dir_entries(p: &Path) -> usize {
    std::fs::read_dir(p).map(|d| d.count()).unwrap_or(0)
}

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
        json!({ "profileId": id, "expectedVersion": 1, "name": "Renamed", "clearClientLabel": true, "notes": "line1\nline2" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (
            updated["name"].clone(),
            updated["client_label"].clone(),
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
            json!({ "name": "ok", "clientLabel": huge }),
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
        (json!({ "clientColour": "red" }), "INVALID_COLOUR"),
        (json!({ "clientColour": "#GGGGGG" }), "INVALID_COLOUR"),
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
        json!({ "profileId": known, "expectedVersion": 1, "clientColour": "#7c3aed",
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
