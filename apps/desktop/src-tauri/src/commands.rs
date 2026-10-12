//! Typed IPC commands. Each one:
//!  1. checks the caller is the bundled manager window (`main`), in addition to the capability ACL;
//!  2. relies on typed arguments (a malformed profile id fails deserialization before the body runs);
//!  3. validates sizes and values, then delegates to `AppState`.
//!
//! Long work returns an `operation_id`; progress arrives as events (see `events.rs`).

use crate::ipc::{self, IpcError};
use crate::operations::Started;
use crate::state::{AppState, AppView, ProfileView, RuntimeStatus};
use pb_runtime::ProfileId;
use pb_storage::Workspace;
use pb_storage::settings::SettingValue;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, State, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type S<'a> = State<'a, Arc<AppState>>;
type R<T> = Result<T, IpcError>;

fn caller<Rt: Runtime>(webview: &Webview<Rt>) -> R<()> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err(ipc::WRONG_CALLER)
    }
}

#[tauri::command]
pub fn get_app_state<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<AppView> {
    caller(&webview)?;
    Ok(state.app_view())
}

#[tauri::command]
pub fn create_workspace<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    name: String,
) -> R<Workspace> {
    caller(&webview)?;
    state.create_workspace(&name)
}

#[tauri::command]
pub fn set_active_workspace<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    workspace_id: String,
) -> R<()> {
    caller(&webview)?;
    state.set_active_workspace(&workspace_id)
}

#[tauri::command]
pub fn list_profiles<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    query: Option<String>,
    limit: Option<u32>,
) -> R<Vec<ProfileView>> {
    caller(&webview)?;
    state.list_profiles(query.as_deref(), limit)
}

#[tauri::command]
pub fn create_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    name: String,
    client_label: Option<String>,
) -> R<ProfileView> {
    caller(&webview)?;
    state.create_profile(&name, client_label.as_deref())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    expected_version: i64,
    name: Option<String>,
    client_label: Option<String>,
    clear_client_label: Option<bool>,
    notes: Option<String>,
) -> R<ProfileView> {
    caller(&webview)?;
    state.update_profile(
        &profile_id,
        expected_version,
        name.as_deref(),
        client_label.as_deref(),
        clear_client_label.unwrap_or(false),
        notes.as_deref(),
    )
}

/// `profile_id` is typed: a malformed id or path fails inside the IPC layer and this body never runs.
#[tauri::command]
pub fn launch_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    start_url: Option<String>,
) -> R<Started> {
    caller(&webview)?;
    state.launch_profile(&profile_id, start_url.as_deref())
}

#[tauri::command]
pub fn stop_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<Started> {
    caller(&webview)?;
    state.stop_profile(&profile_id)
}

#[tauri::command]
pub fn close_all_profiles<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Started> {
    caller(&webview)?;
    state.close_all(None)
}

#[tauri::command]
pub fn get_runtime_status<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<RuntimeStatus> {
    caller(&webview)?;
    Ok(state.runtime_status())
}

#[derive(Serialize)]
pub struct ChosenPath {
    pub path: Option<String>,
}

/// Opens the native folder picker. The path never comes from the webview, so no arbitrary path is accepted.
#[tauri::command]
pub async fn select_download_directory<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
) -> R<ChosenPath> {
    caller(&webview)?;
    let picker = app.clone();
    let chosen =
        tauri::async_runtime::spawn_blocking(move || picker.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| ipc::INTERNAL)?;
    let Some(chosen) = chosen.and_then(|p| p.into_path().ok()) else {
        return Ok(ChosenPath { path: None });
    };
    let state = app.state::<Arc<AppState>>();
    Ok(ChosenPath {
        path: Some(state.set_download_directory(&chosen)?),
    })
}

#[tauri::command]
pub fn update_setting<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    key: String,
    value: Value,
    expected_version: Option<i64>,
) -> R<SettingValue> {
    caller(&webview)?;
    state.update_setting(&key, &value, expected_version)
}

#[tauri::command]
pub fn get_diagnostics<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Value> {
    caller(&webview)?;
    Ok(state.diagnostics())
}

/// Saves a scrubbed diagnostics report to a location the user picks in the native save dialog.
#[tauri::command]
pub async fn export_diagnostics<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
) -> R<ChosenPath> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    let report = serde_json::to_vec_pretty(&state.diagnostics()).map_err(|_| ipc::INTERNAL)?;
    let picker = app.clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name("project-browser-diagnostics.json")
            .blocking_save_file()
    })
    .await
    .map_err(|_| ipc::INTERNAL)?;
    let Some(path) = target.and_then(|p| p.into_path().ok()) else {
        return Ok(ChosenPath { path: None });
    };
    std::fs::write(&path, report).map_err(|_| ipc::INVALID_DIRECTORY)?;
    Ok(ChosenPath {
        path: Some(crate::recovery::scrub(&path.to_string_lossy())),
    })
}

#[tauri::command]
pub fn report_ui_ready<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Option<f64>> {
    caller(&webview)?;
    state.report_ui_ready()
}

#[tauri::command]
pub fn recovery_action<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    action: String,
    target: Option<String>,
) -> R<()> {
    caller(&webview)?;
    state.recovery_action(&action, target.as_deref())
}

/// Answer to the quit prompt: `cancel`, `leave_running` (quit; profiles keep running and are re-attached at next
/// start) or `close_all` (close every profile gracefully, then quit).
#[tauri::command]
pub fn resolve_quit<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    state: S<'_>,
    choice: String,
) -> R<()> {
    caller(&webview)?;
    match choice.as_str() {
        "cancel" => Ok(()),
        "leave_running" => {
            app.exit(0);
            Ok(())
        }
        "close_all" => {
            let handle = app.clone();
            state
                .close_all(Some(Box::new(move || handle.exit(0))))
                .map(|_| ())
        }
        _ => Err(ipc::INVALID_ARGUMENT),
    }
}

/// Opens an allow-listed https link in the user's default browser (never inside the manager).
#[tauri::command]
pub fn open_external<Rt: Runtime>(app: AppHandle<Rt>, webview: Webview<Rt>, url: String) -> R<()> {
    caller(&webview)?;
    let url = crate::external::allowed_external(&url).ok_or(ipc::DISALLOWED_URL)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| ipc::INTERNAL)
}

#[tauri::command]
pub fn remove_local_data<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    state: S<'_>,
    confirm: String,
) -> R<()> {
    caller(&webview)?;
    state.remove_local_data(&confirm)?;
    app.request_restart();
    Ok(())
}
