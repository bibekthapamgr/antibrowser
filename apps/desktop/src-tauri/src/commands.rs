//! Typed IPC commands. Each one:
//!  1. checks the caller is the bundled manager window (`main`), in addition to the capability ACL;
//!  2. relies on typed arguments (a malformed profile id fails deserialization before the body runs);
//!  3. validates sizes and values, then delegates to `AppState`.
//!
//! Long work returns an `operation_id`; progress arrives as events (see `events.rs`).

use crate::account::{AccountView, CloudResponse, OrgImportView, SignInStarted};
use crate::ipc::{self, IpcError};
use crate::lifecycle::ProfileStatus;
use crate::manage::{BulkAction, BulkResult, Library, ProfilePage, Selection, UndoResult};
use crate::network::{PrivacyOptions, PrivacyValidation, ProxyEdit, ProxyInput, ProxyView};
use crate::operations::Started;
use crate::state::{AppState, AppView, ProfileChanges, ProfileView, RuntimeStatus};
use crate::sync::{ConflictChoice, SyncStatus};
use crate::transfer::{ChosenImport, ExportFormat, ExportResult, ImportPreview, ImportSettings};
use pb_runtime::{
    ClientId, FilterId, ImportJobId, PrivacyConfig, ProfileId, ProxyId, TagId, TemplateId,
    WorkspaceId,
};
use pb_storage::Workspace;
use pb_storage::catalog::{Client, SavedFilter, TagRefOwned, Template};
use pb_storage::cloud::OrgLink;
use pb_storage::imports::ImportJob;
use pb_storage::network::NetworkCheck;
use pb_storage::query::{ProfileFilter, Sort};
use pb_storage::settings::SettingValue;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
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
    // Milestone 08: settings that travel with an organization profile's backups need the edit capability, and no
    // change is made while this computer cannot confirm it still holds the profile.
    let synced_settings = start_urls.is_some()
        || camera.is_some()
        || microphone.is_some()
        || location.is_some()
        || privacy.is_some();
    state.team_guard_edit(&profile_id, synced_settings)?;
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

/// Saves a previewed diagnostics report (exactly the text the person saw) where they choose in the save dialog.
#[tauri::command]
pub async fn export_diagnostics<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    preview_id: String,
) -> R<ChosenPath> {
    caller(&webview)?;
    if preview_id.len() > 40 {
        return Err(ipc::INVALID_ARGUMENT);
    }
    let state = app.state::<Arc<AppState>>().inner().clone();
    // Fail before the dialog if the preview is gone.
    if state.agency.previews.get(&preview_id).is_none() {
        return Err(ipc::PREVIEW_EXPIRED);
    }
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
    state.save_diagnostics(&preview_id, &path)?;
    Ok(ChosenPath {
        path: Some(crate::recovery::scrub(&path.to_string_lossy())),
    })
}

/// Builds the diagnostics report, removes personal and secret data and keeps it for 10 minutes for saving.
#[tauri::command]
pub fn preview_diagnostics<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
) -> R<crate::diagnostics::Preview> {
    caller(&webview)?;
    state.preview_diagnostics()
}

// ---------------------------------------------------------------------------------------------- milestone 09
#[tauri::command]
pub fn get_health<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<crate::agency::HealthView> {
    caller(&webview)?;
    state.health()
}

/// Runs a check again: `server` (the organization server and sign-in), `proxies` (every proxy of the workspace,
/// at most 20) or `extensions` (rescan stopped profiles, download the policies).
#[tauri::command]
pub async fn run_health_check<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    check: String,
) -> R<crate::agency::HealthView> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    match check.as_str() {
        "server" => {
            let s = state.clone();
            tauri::async_runtime::spawn_blocking(move || s.check_server())
                .await
                .map_err(|_| ipc::INTERNAL)?;
        }
        "proxies" => {
            let store = state.store()?;
            let proxies = match state.active_workspace(&store)? {
                Some(ws) => store.list_proxies(&ws)?,
                None => vec![],
            };
            for px in proxies.into_iter().take(20) {
                let _ = state.clone().test_proxy(px.id).await;
            }
        }
        "extensions" => {
            let s = state.clone();
            tauri::async_runtime::spawn_blocking(move || s.rescan_extensions(None))
                .await
                .map_err(|_| ipc::INTERNAL)??;
        }
        _ => return Err(ipc::INVALID_ARGUMENT),
    }
    state.health()
}

#[tauri::command]
pub fn get_resources<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
) -> R<crate::agency::ResourcesView> {
    caller(&webview)?;
    state.resources()
}

/// Before opening profiles: free memory against this computer's measured use, and extensions the organization's
/// policy will turn off or has not approved.
#[tauri::command]
pub fn check_launch<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_ids: Vec<ProfileId>,
) -> R<crate::agency::LaunchCheck> {
    caller(&webview)?;
    state.launch_check(&profile_ids)
}

/// Client names, counts and running/shared state of a selection, for a bulk action's confirmation.
#[tauri::command]
pub fn selection_summary<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    selection: Selection,
) -> R<crate::agency::SelectionSummary> {
    caller(&webview)?;
    state.selection_summary(selection)
}

#[tauri::command]
pub fn get_client_overview<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    client_id: ClientId,
) -> R<Value> {
    caller(&webview)?;
    state.client_overview(&client_id)
}

/// Native folder picker for a client's downloads (or `clear`: back to the usual folder). Applies the next time each
/// profile opens; files already downloaded and downloads in progress stay where they are.
#[tauri::command]
pub async fn select_client_download_directory<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    client_id: ClientId,
    clear: Option<bool>,
) -> R<ChosenPath> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    if clear == Some(true) {
        state.set_client_download_directory(&client_id, None)?;
        return Ok(ChosenPath { path: None });
    }
    let picker = app.clone();
    let chosen =
        tauri::async_runtime::spawn_blocking(move || picker.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| ipc::INTERNAL)?;
    let Some(chosen) = chosen.and_then(|p| p.into_path().ok()) else {
        return Ok(ChosenPath { path: None });
    };
    Ok(ChosenPath {
        path: state.set_client_download_directory(&client_id, Some(&chosen))?,
    })
}

#[tauri::command]
pub fn get_extensions<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: Option<ProfileId>,
) -> R<crate::agency::ExtensionsView> {
    caller(&webview)?;
    state.extensions_view(profile_id.as_ref())
}

#[tauri::command]
pub async fn rescan_extensions<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    profile_id: Option<ProfileId>,
) -> R<crate::agency::ExtensionsView> {
    caller(&webview)?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.rescan_extensions(profile_id.as_ref()))
        .await
        .map_err(|_| ipc::INTERNAL)?
}

/// The person reviewed what an extension update added (local profiles).
#[tauri::command]
pub fn review_extension<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    extension_id: String,
) -> R<crate::agency::ExtensionsView> {
    caller(&webview)?;
    state.review_extension(&profile_id, &extension_id)
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
    proxied: Option<bool>,
) -> R<PrivacyValidation> {
    caller(&webview)?;
    Ok(state.validate_privacy(&config, fail_closed_proxy.unwrap_or(false), proxied))
}

/// Languages, time zones, window limits and presets offered in the environment settings.
#[tauri::command]
pub fn get_privacy_options<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<PrivacyOptions> {
    caller(&webview)?;
    Ok(state.privacy_options())
}

// ----------------------------------------------------------------------------- account and organizations (06)
// Network work runs on a blocking thread; tokens never cross to the window.

fn blocking_state<Rt: Runtime>(app: &AppHandle<Rt>) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

#[tauri::command]
pub fn get_account<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<AccountView> {
    caller(&webview)?;
    state.account_view()
}

/// Sets or clears the organization server (https; http only to this computer). Changing it signs out.
#[tauri::command]
pub fn set_cloud_server<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    url: Option<String>,
) -> R<AccountView> {
    caller(&webview)?;
    state.set_cloud_server(url.as_deref())
}

/// Opens the identity provider's sign-in page in the system browser (never inside the manager).
#[tauri::command]
pub async fn begin_sign_in<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    reauth: Option<bool>,
    create: Option<bool>,
) -> R<SignInStarted> {
    caller(&webview)?;
    let state = blocking_state(&app);
    let url = tauri::async_runtime::spawn_blocking(move || {
        if create.unwrap_or(false) {
            state.begin_sign_up()
        } else {
            state.begin_sign_in(reauth.unwrap_or(false))
        }
    })
    .await
    .map_err(|_| ipc::INTERNAL)??;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| ipc::INTERNAL)?;
    Ok(SignInStarted { opened: true })
}

#[tauri::command]
pub fn cancel_sign_in<Rt: Runtime>(webview: Webview<Rt>, state: S<'_>) -> R<AccountView> {
    caller(&webview)?;
    state.cancel_sign_in();
    state.account_view()
}

#[tauri::command]
pub async fn sign_out<Rt: Runtime>(app: AppHandle<Rt>, webview: Webview<Rt>) -> R<AccountView> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || state.sign_out())
        .await
        .map_err(|_| ipc::INTERNAL)?
}

/// An allow-listed organization API request made by the shell with the session's token.
#[tauri::command]
pub async fn cloud_request<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
    if_match: Option<String>,
) -> R<CloudResponse> {
    caller(&webview)?;
    if query.as_ref().is_some_and(|q| q.len() > 10) {
        return Err(ipc::INVALID_ARGUMENT);
    }
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        state.cloud_request(
            &method,
            &path,
            query.as_deref().unwrap_or(&[]),
            body.as_ref(),
            if_match.as_deref(),
        )
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Previews (`dryRun`) or commits copying a local workspace's profiles into an organization.
#[tauri::command]
pub async fn org_import<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    workspace_id: String,
    org_id: String,
    mapping: Option<BTreeMap<String, String>>,
    dry_run: bool,
) -> R<OrgImportView> {
    caller(&webview)?;
    let workspace =
        pb_runtime::WorkspaceId::parse(&workspace_id).map_err(|_| ipc::UNKNOWN_WORKSPACE)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        state.org_import(&workspace, &org_id, &mapping.unwrap_or_default(), dry_run)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

#[tauri::command]
pub fn list_org_links<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    org_id: Option<String>,
) -> R<Vec<OrgLink>> {
    caller(&webview)?;
    state.org_links(org_id.as_deref())
}

// ----------------------------------------------------------------------------- encrypted backups and sync (07)
/// Backup state of one profile: organization link, last synchronized version, the current or last job, the local
/// last-good copy.
#[tauri::command]
pub fn get_sync_status<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<SyncStatus> {
    caller(&webview)?;
    state.sync_status(&profile_id)
}

/// Backs up a closed, organization-linked profile now (in the background; progress arrives as `sync` events).
#[tauri::command]
pub fn sync_backup_now<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<SyncStatus> {
    caller(&webview)?;
    state.sync_backup_now(&profile_id)
}

#[tauri::command]
pub async fn sync_cancel<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    profile_id: ProfileId,
) -> R<SyncStatus> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || state.sync_cancel(&profile_id))
        .await
        .map_err(|_| ipc::INTERNAL)?
}

#[tauri::command]
pub fn sync_set_auto_backup<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    enabled: bool,
) -> R<SyncStatus> {
    caller(&webview)?;
    state.sync_set_auto(&profile_id, enabled)
}

/// `upload_mine`, `use_newer` or `open_newer_as_copy`.
#[tauri::command]
pub fn sync_resolve_conflict<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    choice: String,
) -> R<SyncStatus> {
    caller(&webview)?;
    let choice = ConflictChoice::parse(&choice).ok_or(ipc::INVALID_ARGUMENT)?;
    state.sync_resolve(&profile_id, choice)
}

/// Restores the newest backup (or `snapshotId`) into this profile, or `asCopy` into a new local profile.
#[tauri::command]
pub fn sync_restore<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    snapshot_id: Option<String>,
    as_copy: bool,
) -> R<SyncStatus> {
    caller(&webview)?;
    if snapshot_id.as_ref().is_some_and(|s| s.len() > 40) {
        return Err(ipc::INVALID_ARGUMENT);
    }
    state.sync_restore(&profile_id, snapshot_id.as_deref(), as_copy)
}

/// Puts an organization profile on this computer for the first time (a new local profile, restored and linked).
#[tauri::command]
pub fn sync_restore_here<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    org_id: String,
    org_profile_id: String,
    name: String,
) -> R<ProfileView> {
    caller(&webview)?;
    state.sync_restore_here(&org_id, &org_profile_id, &name)
}

// ------------------------------------------------------------------------------- shared sessions (milestone 08)

/// The shared session of an organization profile on this computer: phase, requests from teammates, the note left by
/// the previous person, a copy kept aside, and why the last open was refused.
#[tauri::command]
pub fn get_team_status<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<crate::team::TeamStatus> {
    caller(&webview)?;
    state.team_status(&profile_id)
}

/// Close and hand off: the browser closes, the closing backup uploads, the lease is released with the note.
#[tauri::command]
pub fn team_close<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
    note: Option<String>,
) -> R<crate::team::TeamStatus> {
    caller(&webview)?;
    if note.as_ref().is_some_and(|n| n.len() > 2000) {
        return Err(ipc::HANDOFF_NOTE_INVALID);
    }
    state.team_close(&profile_id, note.as_deref())
}

/// Gives up a handoff: the newest backup stays as it was and this computer keeps its copy.
#[tauri::command]
pub fn team_abort<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<crate::team::TeamStatus> {
    caller(&webview)?;
    state.team_abort(&profile_id)
}

/// Tries a stalled or failed handoff again.
#[tauri::command]
pub fn team_retry<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<crate::team::TeamStatus> {
    caller(&webview)?;
    state.team_retry(&profile_id)
}

/// Clears the notice of a session that ended (taken over, or access removed).
#[tauri::command]
pub fn team_dismiss<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    profile_id: ProfileId,
) -> R<crate::team::TeamStatus> {
    caller(&webview)?;
    state.team_dismiss(&profile_id)
}

/// Restores a recovery copy (kept from a device that lost its session) as a new local profile. Owners and admins.
#[tauri::command]
pub fn team_restore_recovery_copy<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    org_id: String,
    org_profile_id: String,
    snapshot_id: String,
    name: String,
) -> R<ProfileView> {
    caller(&webview)?;
    state.restore_recovery_copy(&org_id, &org_profile_id, &snapshot_id, &name)
}

// ------------------------------------------------------------------------------- R1 migration (ADR-0020)

/// Plans this device's migration of a workspace into the unified model: what is linked, what the server already
/// mapped, what is local-only (adoptable with opt-in) and what is blocked. Nothing changes.
#[tauri::command]
pub async fn migration_plan<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    workspace_id: String,
    org_id: String,
) -> R<crate::migration::MigrationPlan> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let ws = WorkspaceId::parse(&workspace_id).map_err(|_| ipc::INVALID_ARGUMENT)?;
        state.migration_plan(&ws, &org_id)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Runs (or resumes) the migration: links mapped profiles and adopts the chosen local-only ones in bounded
/// batches. Profile data uploads only when `sync` is chosen. Running it again never duplicates.
#[tauri::command]
pub async fn migration_run<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    workspace_id: String,
    org_id: String,
    adopt: Vec<String>,
    sync: bool,
    batch_size: Option<u32>,
) -> R<crate::migration::MigrationReport> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let ws = WorkspaceId::parse(&workspace_id).map_err(|_| ipc::INVALID_ARGUMENT)?;
        let adopt = adopt
            .iter()
            .map(|id| ProfileId::parse(id).map_err(|_| ipc::INVALID_ARGUMENT))
            .collect::<Result<Vec<_>, _>>()?;
        state.migration_run(
            &ws,
            &org_id,
            &adopt,
            sync,
            batch_size.unwrap_or(50) as usize,
        )
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Rolls the workspace back to the earlier screens (here and for the workspace); the identity map stays.
#[tauri::command]
pub async fn migration_rollback<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
) -> R<crate::migration::MigrationReport> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || state.migration_rollback(&org_id))
        .await
        .map_err(|_| ipc::INTERNAL)?
}

/// The latest run of a workspace on this device with the local → workspace profile mapping.
#[tauri::command]
pub fn migration_report<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    org_id: String,
) -> R<crate::migration::MigrationReport> {
    caller(&webview)?;
    state.migration_report(&org_id)
}

// ------------------------------------------------------------------------------- R3 unified profiles (ADR-0022)

/// This computer's copies of an account workspace's profiles (run state, shared session, backup/restore status).
#[tauri::command]
pub fn workspace_copies<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    org_id: String,
) -> R<Vec<crate::unified::WorkspaceCopy>> {
    caller(&webview)?;
    state.workspace_copies(&org_id)
}

/// A copy of a workspace profile on this computer (restored from its newest backup, or empty when it has none yet),
/// optionally with a proxy of this computer (`match_proxy`, default on: time zone and language follow the proxy).
#[tauri::command]
pub async fn workspace_profile_prepare<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    org_profile_id: String,
    name: String,
    proxy_id: Option<String>,
    match_proxy: Option<bool>,
) -> R<ProfileView> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let proxy = proxy_id
            .as_deref()
            .map(ProxyId::parse)
            .transpose()
            .map_err(|_| ipc::INVALID_ARGUMENT)?;
        state.workspace_profile_prepare(
            &org_id,
            &org_profile_id,
            &name,
            proxy.as_ref(),
            match_proxy.unwrap_or(true),
        )
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Opens a workspace profile through the session lease (downloading it first when it is not on this computer).
#[tauri::command]
pub async fn workspace_profile_open<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    org_profile_id: String,
    name: String,
) -> R<crate::unified::WorkspaceOpen> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        state.workspace_profile_open(&org_id, &org_profile_id, &name)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

// ------------------------------------------------------------------------------- automation (milestone 10)

/// Automation on this computer: the organizations it runs jobs for, whether Playwright connections are allowed,
/// and the jobs it ran recently.
#[tauri::command]
pub fn get_automation_status<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
) -> R<crate::automation::AutomationStatus> {
    caller(&webview)?;
    state.automation_status()
}

/// Lets this computer run an organization's automation jobs (as the person signed in here).
#[tauri::command]
pub async fn automation_enroll<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    accepts: String,
    max_jobs: u32,
) -> R<crate::automation::AutomationStatus> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        state.automation_enroll(&org_id, &accepts, max_jobs)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

/// Stops taking an organization's jobs on this computer.
#[tauri::command]
pub async fn automation_unenroll<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
) -> R<crate::automation::AutomationStatus> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || state.automation_unenroll(&org_id))
        .await
        .map_err(|_| ipc::INTERNAL)?
}

/// Stops a job running on this computer (reported as canceled; the profile closes as usual).
#[tauri::command]
pub fn automation_stop_job<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    job_id: String,
) -> R<crate::automation::AutomationStatus> {
    caller(&webview)?;
    state.automation_stop_job(&job_id)
}

/// "Allow Playwright connections" on this computer (off by default; audited).
#[tauri::command]
pub fn automation_set_debugging<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
    allow: bool,
) -> R<crate::automation::AutomationStatus> {
    caller(&webview)?;
    state.automation_set_debugging(allow)
}

/// A job's screenshot (a `data:` URL), downloaded by the shell.
#[tauri::command]
pub async fn automation_screenshot<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    job_id: String,
    artifact_id: String,
) -> R<String> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || {
        state.automation_screenshot(&org_id, &job_id, &artifact_id)
    })
    .await
    .map_err(|_| ipc::INTERNAL)?
}

// ---------------------------------------------------------------- milestone 11: billing pages

/// Opens a page of the payment provider in the default browser after checking its host (never in the manager).
fn open_payment_page<Rt: Runtime>(app: &AppHandle<Rt>, url: url::Url) -> R<()> {
    let url = crate::billing::payment_url(url.as_str()).ok_or(ipc::DISALLOWED_URL)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| ipc::INTERNAL)
}

/// Starts the provider's checkout for a plan (owners) and opens it. The subscription changes only when the provider
/// confirms the payment.
#[tauri::command]
pub async fn billing_open_checkout<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    plan_id: String,
) -> R<()> {
    caller(&webview)?;
    let state = blocking_state(&app);
    let url =
        tauri::async_runtime::spawn_blocking(move || state.billing_checkout(&org_id, &plan_id))
            .await
            .map_err(|_| ipc::INTERNAL)??;
    open_payment_page(&app, url)
}

/// Opens the provider's customer portal (plan changes, payment methods, cancellation, invoices).
#[tauri::command]
pub async fn billing_open_portal<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
) -> R<()> {
    caller(&webview)?;
    let state = blocking_state(&app);
    let url = tauri::async_runtime::spawn_blocking(move || state.billing_portal(&org_id))
        .await
        .map_err(|_| ipc::INTERNAL)??;
    open_payment_page(&app, url)
}

/// Opens one invoice's page or PDF from the provider.
#[tauri::command]
pub async fn billing_open_invoice<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
    org_id: String,
    invoice_id: String,
    pdf: bool,
) -> R<()> {
    caller(&webview)?;
    let state = blocking_state(&app);
    let url = tauri::async_runtime::spawn_blocking(move || {
        state.billing_invoice(&org_id, &invoice_id, pdf)
    })
    .await
    .map_err(|_| ipc::INTERNAL)??;
    open_payment_page(&app, url)
}

// ---------------------------------------------------------------- milestone 12: manager updates

/// The manager's own update state: channel, last check, what is offered, download progress, and whether this
/// version must be updated (revoked or below the channel's minimum).
#[tauri::command]
pub fn get_update_status<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
) -> R<crate::app_update::UpdateStatus> {
    caller(&webview)?;
    Ok(state.update_status())
}

/// Checks the selected channel's signed manifest now.
#[tauri::command]
pub async fn check_for_updates<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
) -> R<crate::app_update::UpdateStatus> {
    caller(&webview)?;
    let state = blocking_state(&app);
    tauri::async_runtime::spawn_blocking(move || state.update_check())
        .await
        .map_err(|_| ipc::INTERNAL)?
}

/// Downloads the offered update in the background (progress in the `update` and `operation` events).
#[tauri::command]
pub fn download_update<Rt: Runtime>(
    app: AppHandle<Rt>,
    webview: Webview<Rt>,
) -> R<crate::app_update::UpdateStatus> {
    caller(&webview)?;
    blocking_state(&app).update_download()
}

/// Stops a running download (it continues from there next time).
#[tauri::command]
pub fn cancel_update_download<Rt: Runtime>(
    webview: Webview<Rt>,
    state: S<'_>,
) -> R<crate::app_update::UpdateStatus> {
    caller(&webview)?;
    Ok(state.update_cancel())
}

/// Installs the downloaded, verified update: profiles must be closed. Windows runs the installer and quits (the
/// installer starts the new version); macOS replaces the app and restarts.
#[tauri::command]
pub async fn install_update<Rt: Runtime>(app: AppHandle<Rt>, webview: Webview<Rt>) -> R<()> {
    caller(&webview)?;
    let state = blocking_state(&app);
    let plan = tauri::async_runtime::spawn_blocking(move || state.update_install())
        .await
        .map_err(|_| ipc::INTERNAL)??;
    match plan {
        crate::app_update::InstallPlan::RunInstaller(path) => {
            crate::app_update::run_installer(&path)?;
            app.exit(0);
        }
        crate::app_update::InstallPlan::Restart => app.request_restart(),
    }
    Ok(())
}
