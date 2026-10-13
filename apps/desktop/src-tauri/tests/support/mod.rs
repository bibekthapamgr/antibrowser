//! Shared harness for the IPC integration tests: the real Tauri pipeline (mock runtime, capability ACL, argument
//! deserialization, command bodies, SQLite) with a fake process table and launcher instead of a browser.
#![allow(dead_code)]

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
pub const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
pub const APP_ORIGIN: &str = "tauri://localhost";

/// Starts nothing real: records the spec and registers a fake browser (main process with the real argument list
/// plus one renderer), so tree discovery, readiness and adoption run as with a real browser.
pub struct FakeLauncher {
    pub procs: Arc<FakeProcesses>,
    pub spawns: AtomicUsize,
    pub next_pid: AtomicU32,
    pub last_executable: Mutex<Option<PathBuf>>,
    pub last_args: Mutex<Vec<String>>,
    /// Environment the browser was given on top of the minimal inherited one (e.g. `TZ`).
    pub last_env: Mutex<Vec<(String, String)>>,
    /// The next browser "crashes" immediately (its process never appears).
    pub die_immediately: AtomicBool,
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
        if let Ok(mut l) = self.last_env.lock() {
            *l = spec.env.clone();
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
pub struct FakeFetcher {
    pub archive: Mutex<Option<PathBuf>>,
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

pub struct Options {
    pub manifest: (Vec<u8>, Vec<u8>),
    pub trusted_keys: String,
    pub dev_browser: bool,
    pub archive: Option<PathBuf>,
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

pub struct Fixture {
    pub tmp: tempfile::TempDir,
    pub webview: tauri::WebviewWindow<MockRuntime>,
    pub _app: tauri::App<MockRuntime>,
    pub state: Arc<AppState>,
    pub launcher: Arc<FakeLauncher>,
    pub procs: Arc<FakeProcesses>,
    pub browser: PathBuf,
    pub events: Arc<RecordingSink>,
}

impl Fixture {
    pub fn data(&self) -> PathBuf {
        self.tmp.path().join("data")
    }
}

pub const TEST_BROWSER_VERSION: &str = "155.0.8059.39";

pub fn fixture_in(tmp: tempfile::TempDir, procs: Arc<FakeProcesses>) -> Fixture {
    fixture_with(tmp, procs, Options::default())
}

pub fn fixture_with(tmp: tempfile::TempDir, procs: Arc<FakeProcesses>, opts: Options) -> Fixture {
    let browser = tmp.path().join("trusted-browser");
    std::fs::write(&browser, b"").unwrap_or_else(|e| panic!("{e}"));
    let launcher = Arc::new(FakeLauncher {
        procs: procs.clone(),
        spawns: AtomicUsize::new(0),
        next_pid: AtomicU32::new(4000),
        last_executable: Mutex::new(None),
        last_args: Mutex::new(vec![]),
        last_env: Mutex::new(vec![]),
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

pub fn fixture() -> Fixture {
    fixture_in(
        tempfile::tempdir().unwrap_or_else(|e| panic!("{e}")),
        Arc::new(FakeProcesses::default()),
    )
}

pub fn invoke_from(f: &Fixture, origin: &str, cmd: &str, body: Value) -> Result<Value, Value> {
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

pub fn invoke(f: &Fixture, cmd: &str, body: Value) -> Result<Value, Value> {
    invoke_from(f, APP_ORIGIN, cmd, body)
}

pub fn code(r: &Result<Value, Value>) -> Option<String> {
    r.as_ref()
        .err()
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Creates a workspace and one profile; returns the profile id.
pub fn workspace_with_profile(f: &Fixture) -> String {
    invoke(f, "create_workspace", json!({ "name": "Agency" })).unwrap_or_else(|e| panic!("{e}"));
    let p = invoke(
        f,
        "create_profile",
        json!({ "name": "Known", "client": "Client North" }),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    p["id"].as_str().unwrap_or_default().to_owned()
}

pub fn wait_op(f: &Fixture, op: &Value) -> OpStatus {
    let id = op["operation_id"].as_str().unwrap_or_default();
    f.state
        .ops
        .wait(id, Duration::from_secs(20))
        .map(|o| o.status)
        .unwrap_or(OpStatus::Failed)
}

pub fn dir_entries(p: &Path) -> usize {
    std::fs::read_dir(p).map(|d| d.count()).unwrap_or(0)
}
