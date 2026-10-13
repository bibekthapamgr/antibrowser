//! Typed IPC commands. Each one:
//!  1. checks the caller is the bundled manager window (`main`), in addition to the capability ACL;
//!  2. relies on typed arguments (a malformed profile id fails deserialization before the body runs);
//!  3. validates sizes and values, then delegates to `AppState`.
//!
//! Long work returns an `operation_id`; progress arrives as events (see `events.rs`).

use crate::ipc::{self, IpcError};
use crate::lifecycle::ProfileStatus;
use crate::manage::{BulkAction, BulkResult, Library, ProfilePage, Selection, UndoResult};
use crate::network::{PrivacyOptions, PrivacyValidation, ProxyEdit, ProxyInput, ProxyView};
use crate::operations::Started;
use crate::state::{AppState, AppView, ProfileChanges, ProfileView, RuntimeStatus};
use crate::transfer::{ChosenImport, ExportFormat, ExportResult, ImportPreview, ImportSettings};
use pb_runtime::{
    ClientId, FilterId, ImportJobId, PrivacyConfig, ProfileId, ProxyId, TagId, TemplateId,
};
use pb_storage::Workspace;
use pb_storage::catalog::{Client, SavedFilter, TagRefOwned, Template};
use pb_storage::imports::ImportJob;
use pb_storage::network::NetworkCheck;
use pb_storage::query::{ProfileFilter, Sort};
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

/// Basic creation: a name and, optionally, a client (by name; created if new) and a template.
#[tauri::command]
pub fn create_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    name: String,
    client: Option<String>,
    template_id: Option<TemplateId>,
) -> R<ProfileView> {
    caller(&webview)?;
    state.create_profile(&name, client.as_deref(), template_id.as_ref())
}

/// Profile settings (`profiles.update(id, expected_version)`). Start URLs, tags and permission defaults are
/// validated in Rust; the download folder is set only through the native picker.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    expected_version: i64,
    name: Option<String>,
    client_id: Option<ClientId>,
    clear_client: Option<bool>,
    notes: Option<String>,
    favourite: Option<bool>,
    tags: Option<Vec<String>>,
    start_urls: Option<Vec<String>>,
    clear_download_dir: Option<bool>,
    camera: Option<String>,
    microphone: Option<String>,
    location: Option<String>,
    privacy: Option<PrivacyConfig>,
) -> R<ProfileView> {
    caller(&webview)?;
    state.update_profile(
        &profile_id,
        expected_version,
        ProfileChanges {
            name: name.as_deref(),
            client_id: client_id.as_ref(),
            clear_client: clear_client.unwrap_or(false),
            notes: notes.as_deref(),
            favourite,
            tags: tags.as_deref(),
            start_urls: start_urls.as_deref(),
            clear_download_dir: clear_download_dir.unwrap_or(false),
            camera: camera.as_deref(),
            microphone: microphone.as_deref(),
            location: location.as_deref(),
            privacy: privacy.as_ref(),
        },
    )
}

// ------------------------------------------------------------------------------------- milestone 04
/// `profiles.query(cursor, filters)`: one page of the profile table.
#[tauri::command]
pub fn query_profiles<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    filter: Option<ProfileFilter>,
    sort: Option<Sort>,
    cursor: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> R<ProfilePage> {
    caller(&webview)?;
    if cursor.as_ref().is_some_and(|c| c.len() > 64) {
        return Err(ipc::CURSOR_STALE);
    }
    state.query_profiles(filter, sort, cursor.as_deref(), offset, limit)
}

/// Sidebar data: counts, clients (folders), tags, templates, saved filters.
#[tauri::command]
pub fn get_library<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Library> {
    caller(&webview)?;
    state.library()
}

#[tauri::command]
pub fn create_client<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    name: String,
    colour: Option<String>,
) -> R<Client> {
    caller(&webview)?;
    state.create_client(&name, colour.as_deref())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_client<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    client_id: ClientId,
    expected_version: i64,
    name: Option<String>,
    colour: Option<String>,
    clear_colour: Option<bool>,
    archived: Option<bool>,
) -> R<Client> {
    caller(&webview)?;
    state.update_client(
        &client_id,
        expected_version,
        name.as_deref(),
        colour.as_deref(),
        clear_colour.unwrap_or(false),
        archived,
    )
}

#[tauri::command]
pub fn create_tag<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>, name: String) -> R<TagRefOwned> {
    caller(&webview)?;
    state.create_tag(&name)
}

#[tauri::command]
pub fn rename_tag<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    tag_id: TagId,
    name: String,
) -> R<()> {
    caller(&webview)?;
    state.rename_tag(&tag_id, &name)
}

#[tauri::command]
pub fn delete_tag<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>, tag_id: TagId) -> R<()> {
    caller(&webview)?;
    state.delete_tag(&tag_id)
}

#[tauri::command]
pub fn save_filter<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    name: String,
    filter: ProfileFilter,
    sort: Option<Sort>,
) -> R<SavedFilter> {
    caller(&webview)?;
    state.save_filter(&name, filter, sort)
}

#[tauri::command]
pub fn delete_filter<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    filter_id: FilterId,
) -> R<()> {
    caller(&webview)?;
    state.delete_filter(&filter_id)
}

/// Saves a profile's configuration as a template (never its browser data).
#[tauri::command]
pub fn save_template<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    name: String,
) -> R<Template> {
    caller(&webview)?;
    state.save_template_from_profile(&profile_id, &name)
}

#[tauri::command]
pub fn delete_template<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    template_id: TemplateId,
) -> R<()> {
    caller(&webview)?;
    state.delete_template(&template_id)
}

/// New profile with the same configuration and empty browser storage (sign-ins are never copied).
#[tauri::command]
pub fn duplicate_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    name: String,
) -> R<ProfileView> {
    caller(&webview)?;
    state.duplicate_profile(&profile_id, &name)
}

/// `profiles.bulk(action, ids)`: per-profile results; reversible actions return an undo token.
#[tauri::command]
pub async fn bulk_profiles<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    action: BulkAction,
    selection: Selection,
) -> R<BulkResult> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.bulk(action, selection))
        .await
        .map_err(|_| ipc::INTERNAL)?
}

#[tauri::command]
pub fn undo_action<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    token: String,
) -> R<UndoResult> {
    caller(&webview)?;
    if token.len() != 32 {
        return Err(ipc::UNDO_EXPIRED);
    }
    state.undo(&token)
}

/// Permanent deletion from the trash; `confirm` must be "DELETE" and `expected_count` the number confirmed.
#[tauri::command]
pub async fn delete_profiles<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    selection: Selection,
    confirm: String,
    expected_count: usize,
) -> R<BulkResult> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.delete_permanently(selection, &confirm, expected_count)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Native file picker for an import (CSV, JSON or a Project Browser export). Returns an opaque reference.
#[tauri::command]
pub async fn choose_import_file<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
) -> R<ChosenImport> {
    caller(&webview)?;
    let picker = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Profile configuration", &["csv", "json", "zip"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| ipc::INTERNAL)?;
    let Some(path) = chosen.and_then(|p| p.into_path().ok()) else {
        return Ok(ChosenImport {
            file_ref: None,
            name: None,
            size: None,
        });
    };
    app.state::<Arc<AppState>>().register_import_file(&path)
}

/// `imports.preview(file_ref)`: validates every row and plans the import (dry run; nothing is written).
#[tauri::command]
pub async fn preview_import<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    file_ref: String,
    settings: Option<ImportSettings>,
) -> R<ImportPreview> {
    caller(&webview)?;
    if file_ref.len() != 32 {
        return Err(ipc::UNKNOWN_FILE);
    }
    let state = app.state::<Arc<AppState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.preview_import(&file_ref, settings.unwrap_or_default())
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// `imports.commit(preview_id)`: refused if the file changed since the preview.
#[tauri::command]
pub fn commit_import<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    preview_id: ImportJobId,
) -> R<Started> {
    caller(&webview)?;
    state.commit_import(&preview_id)
}

#[tauri::command]
pub fn cancel_import<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    job_id: ImportJobId,
) -> R<()> {
    caller(&webview)?;
    state.cancel_import(&job_id)
}

#[tauri::command]
pub fn list_imports<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Vec<ImportJob>> {
    caller(&webview)?;
    state.list_imports()
}

/// `exports.configuration(ids)`: configuration only, saved where the user picks in the native dialog.
#[tauri::command]
pub async fn export_profiles<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    selection: Selection,
    format: ExportFormat,
    include_notes: Option<bool>,
) -> R<ExportResult> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    let prepare = state.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare.prepare_export(selection, format, include_notes.unwrap_or(true))
    })
    .await
    .map_err(|_| ipc::INTERNAL)??;
    let picker = app.clone();
    let name = prepared.suggested_name.clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| ipc::INTERNAL)?;
    let Some(path) = target.and_then(|p| p.into_path().ok()) else {
        return Ok(ExportResult {
            path: None,
            exported: 0,
            notes_withheld: 0,
        });
    };
    state.write_export(&path, &prepared)
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

/// Graceful close; `force: true` is the explicit force close offered after a graceful close timed out.
#[tauri::command]
pub fn stop_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    force: Option<bool>,
) -> R<Started> {
    caller(&webview)?;
    state.stop_profile(&profile_id, force.unwrap_or(false))
}

#[tauri::command]
pub fn close_all_profiles<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    force: Option<bool>,
) -> R<Started> {
    caller(&webview)?;
    state.close_all(force.unwrap_or(false), None)
}

#[tauri::command]
pub fn get_profile_status<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<ProfileStatus> {
    caller(&webview)?;
    state.profile_status(&profile_id)
}

/// `reopen`, `restore_backup`, `start_fresh` or `backup_now` (see `AppState::recover_profile`).
#[tauri::command]
pub fn recover_profile<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    action: String,
) -> R<Started> {
    caller(&webview)?;
    state.recover_profile(&profile_id, &action)
}

/// Installs the runtime version pinned in this build's signed manifest. Any other version is refused.
#[tauri::command]
pub fn install_runtime<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    version: String,
) -> R<Started> {
    caller(&webview)?;
    if version.len() > 32 {
        return Err(ipc::RUNTIME_NOT_IN_MANIFEST);
    }
    state.install_runtime(&version)
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

/// Native folder picker for one profile's downloads.
#[tauri::command]
pub async fn select_profile_download_directory<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    profile_id: ProfileId,
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
        path: Some(state.set_profile_download_directory(&profile_id, &chosen)?),
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
/// start), `close_all` (close every profile gracefully, then quit) or `force_close_all` (offered after profiles did
/// not respond: force-close those, then quit).
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
        "close_all" | "force_close_all" => {
            let handle = app.clone();
            state
                .close_all(
                    choice == "force_close_all",
                    Some(Box::new(move || handle.exit(0))),
                )
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

// ------------------------------------------------------------------------------------- milestone 05
/// Proxies of the active workspace. Logins are never returned (`has_login` only).
#[tauri::command]
pub fn list_proxies<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<Vec<ProxyView>> {
    caller(&webview)?;
    state.list_proxies()
}

/// The login, if any, goes straight to the OS keychain.
#[tauri::command]
pub fn create_proxy<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    proxy: ProxyInput,
) -> R<ProxyView> {
    caller(&webview)?;
    state.create_proxy(proxy)
}

#[tauri::command]
pub fn update_proxy<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    proxy_id: ProxyId,
    expected_version: i64,
    changes: ProxyEdit,
) -> R<ProxyView> {
    caller(&webview)?;
    state.update_proxy(&proxy_id, expected_version, changes)
}

#[tauri::command]
pub fn delete_proxy<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>, proxy_id: ProxyId) -> R<()> {
    caller(&webview)?;
    state.delete_proxy(&proxy_id)
}

/// `proxies.test(id)`: user-started connectivity check (latency, exit address, time).
#[tauri::command]
pub async fn test_proxy<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    proxy_id: ProxyId,
) -> R<NetworkCheck> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    state.test_proxy(proxy_id).await
}

#[tauri::command]
pub fn list_proxy_checks<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    proxy_id: ProxyId,
) -> R<Vec<NetworkCheck>> {
    caller(&webview)?;
    state.list_proxy_checks(&proxy_id)
}

/// `profiles.assign_proxy(id, proxy_id, expected_version)`; no `proxy_id` removes the proxy.
#[tauri::command]
pub fn assign_proxy<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    proxy_id: Option<ProxyId>,
    fail_closed: bool,
    expected_version: i64,
) -> R<ProfileView> {
    caller(&webview)?;
    state.assign_proxy(
        &profile_id,
        proxy_id.as_ref(),
        fail_closed,
        expected_version,
    )
}

/// `privacy.validate(config)`.
#[tauri::command]
pub fn validate_privacy<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    config: PrivacyConfig,
    fail_closed_proxy: Option<bool>,
) -> R<PrivacyValidation> {
    caller(&webview)?;
    Ok(state.validate_privacy(&config, fail_closed_proxy.unwrap_or(false)))
}

/// Languages, time zones, window limits and presets offered in the environment settings.
#[tauri::command]
pub fn get_privacy_options<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<PrivacyOptions> {
    caller(&webview)?;
    Ok(state.privacy_options())
}
