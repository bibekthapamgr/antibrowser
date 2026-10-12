//! Desktop manager shell.
//!
//! Security boundary (roadmap stack decision): the system webview renders ONLY the bundled manager UI.
//! Untrusted websites are never loaded here; they run in separate Chromium processes with their own
//! user-data directories. The webview can call exactly three commands (see capabilities/default.json),
//! and every argument is validated in Rust before any filesystem change or process spawn.

use pb_runtime::{
    BrowserInstall, LaunchError, LaunchRequest, Launcher, ProfileId, ProfileState, ProfilesRoot,
    SystemLauncher, prepare_launch,
};
use pb_storage::{LocalProfile, LocalStore, NewProfile, StoreError};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct AppState {
    pub store: LocalStore,
    pub root: ProfilesRoot,
    pub browser: Option<BrowserInstall>,
    pub launcher: Arc<dyn Launcher>,
    /// Serialises launches so "is it already running?" and "record pid" cannot interleave.
    pub launch_lock: Mutex<()>,
}

/// Error returned over IPC: a stable code and a user-safe message. No paths, SQL or OS error text.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct IpcError {
    pub code: &'static str,
    pub message: &'static str,
}

impl From<LaunchError> for IpcError {
    fn from(e: LaunchError) -> Self {
        let message = match e {
            LaunchError::UnknownProfile => "This profile does not exist on this device.",
            LaunchError::AlreadyRunning => "This profile is already open.",
            LaunchError::BrowserNotConfigured => "The browser runtime is not installed.",
            LaunchError::BadStartUrl => "Start address must begin with http:// or https://.",
            LaunchError::Layout(_) => "The profile folder failed a safety check.",
            LaunchError::Spawn(_) => "The browser could not be started.",
        };
        Self {
            code: e.code(),
            message,
        }
    }
}

impl From<StoreError> for IpcError {
    fn from(_: StoreError) -> Self {
        Self {
            code: "LOCAL_STORE_ERROR",
            message: "Local profile data could not be read or written.",
        }
    }
}

const INVALID_LABEL: IpcError = IpcError {
    code: "INVALID_LABEL",
    message: "Names must be 1-120 visible characters.",
};

#[derive(Debug, Serialize)]
pub struct Launched {
    pub pid: u32,
}

fn clean_label(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > 120 || trimmed.chars().any(char::is_control) {
        return Err(INVALID_LABEL);
    }
    Ok(trimmed.to_owned())
}

pub fn list_profiles_impl(
    state: &AppState,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<LocalProfile>, IpcError> {
    let query = query.filter(|q| q.chars().count() <= 200);
    Ok(state
        .store
        .search_profiles(query.as_deref(), limit.unwrap_or(50))?)
}

pub fn create_local_profile_impl(
    state: &AppState,
    name: String,
    client_label: Option<String>,
) -> Result<LocalProfile, IpcError> {
    let name = clean_label(&name)?;
    let client = client_label.as_deref().map(clean_label).transpose()?;
    let id = ProfileId::generate().map_err(|_| IpcError {
        code: "RNG_UNAVAILABLE",
        message: "Try again.",
    })?;
    Ok(state.store.insert_profile(NewProfile {
        id: &id,
        name: &name,
        client_label: client.as_deref(),
        folder_label: None,
    })?)
}

pub fn launch_profile_impl(
    state: &AppState,
    profile_id: ProfileId,
    start_url: Option<String>,
) -> Result<Launched, IpcError> {
    let _guard = state
        .launch_lock
        .lock()
        .map_err(|_| IpcError::from(StoreError::Poisoned))?;
    let existing = state.store.get_profile(&profile_id)?;
    let profile_state = ProfileState {
        exists: existing.is_some(),
        running: existing.as_ref().is_some_and(|p| p.running_pid.is_some()),
    };
    let spec = prepare_launch(
        &state.root,
        state.browser.as_ref(),
        profile_state,
        LaunchRequest {
            profile_id: &profile_id,
            start_url: start_url.as_deref(),
        },
    )?;
    let pid = state.launcher.spawn(&spec)?;
    state.store.record_process(&profile_id, pid)?;
    Ok(Launched { pid })
}

#[tauri::command]
fn list_profiles(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<LocalProfile>, IpcError> {
    list_profiles_impl(&state, query, limit)
}

#[tauri::command]
fn create_local_profile(
    state: State<'_, AppState>,
    name: String,
    client_label: Option<String>,
) -> Result<LocalProfile, IpcError> {
    create_local_profile_impl(&state, name, client_label)
}

/// `profile_id` is typed as `ProfileId`: a malformed id or path fails deserialization inside Tauri's
/// IPC layer, so this function body (and therefore any spawn) is never reached.
#[tauri::command]
fn launch_profile(
    state: State<'_, AppState>,
    profile_id: ProfileId,
    start_url: Option<String>,
) -> Result<Launched, IpcError> {
    launch_profile_impl(&state, profile_id, start_url)
}

/// Browser location comes from trusted local configuration only. Milestone 03 replaces this with the
/// pinned runtime installed by the manager (see crates/update). Debug builds may point at a developer build.
fn resolve_browser() -> Option<BrowserInstall> {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("PB_DEV_BROWSER") {
        let install = BrowserInstall {
            executable: path.into(),
            revision: "dev".into(),
        };
        return install.validate().is_ok().then_some(install);
    }
    None
}

pub fn build_state(
    data_dir: &std::path::Path,
    browser: Option<BrowserInstall>,
    launcher: Arc<dyn Launcher>,
) -> Result<AppState, String> {
    let profiles_dir = data_dir.join("profiles");
    std::fs::create_dir_all(&profiles_dir)
        .map_err(|e| format!("cannot create profiles dir: {e}"))?;
    let root = ProfilesRoot::open(&profiles_dir).map_err(|e| e.to_string())?;
    let store = LocalStore::open(&data_dir.join("local.db")).map_err(|e| e.to_string())?;
    Ok(AppState {
        store,
        root,
        browser,
        launcher,
        launch_lock: Mutex::new(()),
    })
}

pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = build_state(&data_dir, resolve_browser(), Arc::new(SystemLauncher))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            create_local_profile,
            launch_profile
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod ipc_spike;
