//! Spike (milestone 01, step 5): Tauri-to-Rust launch IPC with invalid profile/path requests.
//! Requirement: reject before starting any process.
//!
//! These tests drive the real Tauri IPC pipeline (mock runtime, real capability/ACL and argument
//! deserialization) and count calls to the process launcher.

use pb_desktop_lib::{build_state, context, create_local_profile_impl, handler};
use pb_runtime::{BrowserInstall, LaunchError, LaunchSpec, Launcher, ProfileId};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

#[derive(Default)]
struct CountingLauncher {
    spawns: AtomicUsize,
    last_executable: Mutex<Option<PathBuf>>,
}

impl Launcher for CountingLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<u32, LaunchError> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut last) = self.last_executable.lock() {
            *last = Some(spec.executable.clone());
        }
        Ok(4242)
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    webview: tauri::WebviewWindow<MockRuntime>,
    _app: tauri::App<MockRuntime>,
    launcher: Arc<CountingLauncher>,
    known: ProfileId,
    browser: PathBuf,
    profiles_dir: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let browser = tmp.path().join("trusted-browser");
    std::fs::write(&browser, b"").unwrap_or_else(|e| panic!("{e}"));
    let launcher = Arc::new(CountingLauncher::default());
    let state = build_state(
        &tmp.path().join("data"),
        Some(BrowserInstall {
            executable: browser.clone(),
            revision: "test".into(),
        }),
        launcher.clone(),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let known = create_local_profile_impl(&state, "Known".into(), None)
        .unwrap_or_else(|e| panic!("{e:?}"))
        .id;

    let app = mock_builder()
        .manage(state)
        .invoke_handler(handler())
        .build(context())
        .unwrap_or_else(|e| panic!("{e}"));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap_or_else(|e| panic!("{e}"));
    let profiles_dir = tmp.path().join("data").join("profiles");
    Fixture {
        _tmp: tmp,
        webview,
        _app: app,
        launcher,
        known,
        browser,
        profiles_dir,
    }
}

fn invoke(f: &Fixture, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        &f.webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost"
                .parse()
                .unwrap_or_else(|e| panic!("{e}")),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap_or(Value::Null))
}

fn dir_entries(p: &std::path::Path) -> usize {
    std::fs::read_dir(p).map(|d| d.count()).unwrap_or(0)
}

#[test]
fn invalid_profile_ids_and_paths_never_reach_the_launcher() {
    let f = fixture();
    let malicious: Vec<Value> = vec![
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
        // Well-formed but unknown on this device.
        json!({ "profileId": "prf_01J9ZSEED0ZZZZ000000000000" }),
        // Known profile, unsafe start URLs.
        json!({ "profileId": f.known.as_str(), "startUrl": "file:///etc/passwd" }),
        json!({ "profileId": f.known.as_str(), "startUrl": "--utility-cmd-prefix=/bin/sh" }),
        json!({ "profileId": f.known.as_str(), "startUrl": "javascript:alert(1)" }),
    ];

    for (i, body) in malicious.iter().enumerate() {
        let result = invoke(&f, "launch_profile", body.clone());
        let Err(err) = result else {
            panic!("must be rejected: {body}")
        };
        if i < 14 {
            // Rejected by argument deserialization inside the IPC layer: the command body never ran.
            let text = err.as_str().unwrap_or_default();
            assert!(
                text.contains("profileId"),
                "expected an IPC argument error for {body}, got {err}"
            );
        } else {
            assert!(
                err.get("code").is_some(),
                "expected a validated command error for {body}, got {err}"
            );
        }
    }
    assert_eq!(
        f.launcher.spawns.load(Ordering::SeqCst),
        0,
        "no process may be started"
    );
    assert_eq!(
        dir_entries(&f.profiles_dir),
        0,
        "no profile directory may be created"
    );
}

#[test]
fn ipc_errors_are_codes_not_internal_detail() {
    let f = fixture();
    let unknown = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": "prf_01J9ZSEED0ZZZZ000000000000" }),
    );
    assert_eq!(
        unknown,
        Err(
            json!({ "code": "UNKNOWN_PROFILE", "message": "This profile does not exist on this device." })
        )
    );
    let url = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": f.known.as_str(), "startUrl": "file:///x" }),
    );
    assert_eq!(
        url.err().and_then(|e| e.get("code").cloned()),
        Some(json!("BAD_START_URL"))
    );
}

#[test]
fn the_executable_cannot_be_chosen_by_the_webview() {
    let f = fixture();
    let ok = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": f.known.as_str(), "executable": "/bin/sh", "args": ["-c", "id"] }),
    );
    assert_eq!(ok, Ok(json!({ "pid": 4242 })));
    assert_eq!(f.launcher.spawns.load(Ordering::SeqCst), 1);
    let used = f
        .launcher
        .last_executable
        .lock()
        .ok()
        .and_then(|g| g.clone());
    assert_eq!(
        used,
        Some(f.browser.clone()),
        "only the trusted configured browser is ever launched"
    );

    // A second launch of the same profile is refused while it is recorded as running.
    let again = invoke(
        &f,
        "launch_profile",
        json!({ "profileId": f.known.as_str() }),
    );
    assert_eq!(
        again.err().and_then(|e| e.get("code").cloned()),
        Some(json!("ALREADY_RUNNING"))
    );
    assert_eq!(f.launcher.spawns.load(Ordering::SeqCst), 1);
}

#[test]
fn commands_outside_the_capability_are_denied() {
    let f = fixture();
    for cmd in [
        "plugin:shell|execute",
        "plugin:fs|read_file",
        "plugin:http|fetch",
        "not_a_command",
    ] {
        assert!(invoke(&f, cmd, json!({})).is_err(), "{cmd} must be denied");
    }
}

#[test]
fn labels_are_validated_and_never_become_paths() {
    let f = fixture();
    let bad = invoke(&f, "create_local_profile", json!({ "name": "  " }));
    assert_eq!(
        bad.err().and_then(|e| e.get("code").cloned()),
        Some(json!("INVALID_LABEL"))
    );
    let created = invoke(
        &f,
        "create_local_profile",
        json!({ "name": "../../escape", "clientLabel": "C:\\x" }),
    );
    let created = created.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(created["name"], json!("../../escape"));
    let id = created["id"].as_str().unwrap_or_default().to_owned();
    assert!(
        ProfileId::parse(&id).is_ok(),
        "directory name is the generated id, not the label"
    );
    assert_eq!(
        dir_entries(&f.profiles_dir),
        0,
        "creating metadata does not touch disk layout"
    );
}
