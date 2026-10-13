//! Desktop manager shell (milestone 02) and browser runtime lifecycle (milestone 03).
//!
//! Security boundary (roadmap): the system webview renders ONLY the bundled manager UI. Navigation away from it and
//! new windows are refused; external links open in the default browser; websites run only in separate Chromium
//! processes. The webview can invoke only the commands listed in `capabilities/default.json`, each of which checks
//! its caller and validates its inputs in Rust.

pub mod account;
pub mod agency;
pub mod authz;
pub mod commands;
pub mod deeplink;
pub mod diagnostics;
pub mod events;
pub mod external;
pub mod ipc;
pub mod lifecycle;
pub mod manage;
pub mod network;
pub mod operations;
pub mod recovery;
pub mod runtime;
pub mod secrets;
pub mod state;
pub mod supervisor;
pub mod sync;
pub mod team;
pub mod transfer;

use crate::events::{DEEP_LINK, QUIT_REQUESTED};
use crate::state::AppState;
use pb_runtime::{SystemInspector, SystemLauncher};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

/// The tauri context (config, capabilities/ACL, assets). `generate_context!` must be expanded exactly once per
/// crate: on macOS it embeds the Info.plist in a fixed linker section. Tests reuse this with the mock runtime.
pub fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// The full IPC handler set. Integration tests drive exactly this set.
pub fn handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::get_app_state,
        commands::create_workspace,
        commands::set_active_workspace,
        commands::list_profiles,
        commands::create_profile,
        commands::update_profile,
        commands::launch_profile,
        commands::stop_profile,
        commands::close_all_profiles,
        commands::get_runtime_status,
        commands::select_download_directory,
        commands::update_setting,
        commands::get_diagnostics,
        commands::export_diagnostics,
        commands::report_ui_ready,
        commands::recovery_action,
        commands::resolve_quit,
        commands::open_external,
        commands::remove_local_data,
        commands::get_profile_status,
        commands::recover_profile,
        commands::install_runtime,
        commands::select_profile_download_directory,
        commands::query_profiles,
        commands::get_library,
        commands::create_client,
        commands::update_client,
        commands::create_tag,
        commands::rename_tag,
        commands::delete_tag,
        commands::save_filter,
        commands::delete_filter,
        commands::save_template,
        commands::delete_template,
        commands::duplicate_profile,
        commands::bulk_profiles,
        commands::undo_action,
        commands::delete_profiles,
        commands::choose_import_file,
        commands::preview_import,
        commands::commit_import,
        commands::cancel_import,
        commands::list_imports,
        commands::export_profiles,
        commands::list_proxies,
        commands::create_proxy,
        commands::update_proxy,
        commands::delete_proxy,
        commands::test_proxy,
        commands::list_proxy_checks,
        commands::assign_proxy,
        commands::validate_privacy,
        commands::get_privacy_options,
        commands::get_account,
        commands::set_cloud_server,
        commands::begin_sign_in,
        commands::cancel_sign_in,
        commands::sign_out,
        commands::cloud_request,
        commands::org_import,
        commands::list_org_links,
        commands::get_sync_status,
        commands::sync_backup_now,
        commands::sync_cancel,
        commands::sync_set_auto_backup,
        commands::sync_resolve_conflict,
        commands::sync_restore,
        commands::sync_restore_here,
        commands::get_team_status,
        commands::team_close,
        commands::team_abort,
        commands::team_retry,
        commands::team_dismiss,
        commands::team_restore_recovery_copy,
        commands::preview_diagnostics,
        commands::get_health,
        commands::run_health_check,
        commands::get_resources,
        commands::check_launch,
        commands::selection_summary,
        commands::get_client_overview,
        commands::select_client_download_directory,
        commands::get_extensions,
        commands::rescan_extensions,
        commands::review_extension,
    ]
}

/// The manager window: bundled UI only; no navigation away, no new windows.
pub fn build_main_window<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    WebviewWindowBuilder::new(manager, "main", WebviewUrl::App("index.html".into()))
        .title("Project Browser")
        .inner_size(1200.0, 780.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(external::is_app_url)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .build()
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Quit policy: with profiles open, follow `manager.close_behavior` (ask by default).
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let running = state.supervisor.running_count();
    if running == 0 {
        app.exit(0);
        return;
    }
    let behavior = state
        .store()
        .ok()
        .and_then(|s| s.get_setting(pb_storage::settings::CLOSE_BEHAVIOR).ok())
        .and_then(|v| v.value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "ask".into());
    match behavior.as_str() {
        "keep_running" => app.exit(0),
        "close_all" => {
            let handle = app.clone();
            let _ = state.close_all(false, Some(Box::new(move || handle.exit(0))));
        }
        _ => {
            show_main(app);
            let _ = app.emit_to(
                "main",
                QUIT_REQUESTED,
                json!({ "running": running, "unresponsive": 0 }),
            );
        }
    }
}

fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, raw: &str) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let store = state.store().ok();
    let (outcome, callback) = deeplink::handle(raw, store.as_deref());
    // The link itself is never logged or echoed back.
    let _ = app.emit_to(
        "main",
        DEEP_LINK,
        json!({ "kind": "auth-callback", "outcome": outcome }),
    );
    if let Some(callback) = callback {
        show_main(app);
        // The code exchange talks to the network: never on the UI thread.
        std::thread::spawn(move || state.finish_sign_in(&callback));
    }
}

fn build_tray<R: Runtime>(app: &tauri::App<R>, state: &Arc<AppState>) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "No profiles open", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open manager", true, None::<&str>)?;
    let close_all = MenuItem::with_id(app, "close_all", "Close all profiles", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Project Browser", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &close_all,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Project Browser")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "close_all" => {
                let state = app.state::<Arc<AppState>>().inner().clone();
                let _ = state.close_all(false, None);
            }
            "quit" => request_quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    let update = move |n: usize| {
        let text = match n {
            0 => "No profiles open".to_owned(),
            1 => "1 profile open".to_owned(),
            n => format!("{n} profiles open"),
        };
        let _ = status.set_text(&text);
        let _ = tray.set_tooltip(Some(format!("Project Browser — {text}")));
    };
    update(state.supervisor.running_count());
    if let Ok(mut slot) = state.on_running_changed.write() {
        *slot = Some(Box::new(update));
    }
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch focuses this instance (and forwards deep links) instead of opening a
        // second writer on the same local database.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Local (non-roaming) app data: browser profiles are large and device-bound, so they must not follow
            // Windows roaming profiles. macOS: ~/Library/Application Support/<identifier>; Windows: %LOCALAPPDATA%.
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Exclusive lock on the data directory: one manager process writes local data at a time.
            let lock = std::fs::File::create(data_dir.join("manager.lock"))?;
            if lock.try_lock().is_err() {
                return Err(
                    "Another Project Browser manager is already using this data folder.".into(),
                );
            }
            app.manage(lock);
            recovery::install_panic_hook(data_dir.clone(), state::APP_VERSION);

            let events: Arc<dyn events::EventSink> = Arc::new(app.handle().clone());
            let state = AppState::build(
                &data_dir,
                runtime::RuntimeConfig::embedded(),
                Arc::new(SystemLauncher),
                Arc::new(SystemInspector::default()),
                events,
            )?;
            app.manage(state.clone());

            // Keychain availability is probed off the UI thread; until then secrets are disabled.
            let probe_state = state.clone();
            // Then the proxy gateways of profiles that kept running while the manager was closed are restored (their
            // logins come from the keychain).
            std::thread::spawn(move || {
                let status = secrets::probe();
                if let Ok(mut k) = probe_state.keychain.write() {
                    *k = status;
                }
                // The device key for sealed local backups lives in the keychain (milestone 07).
                probe_state.load_backup_key();
                probe_state.restore_networks();
            });
            // Unfinished organization backups and restores resume in the background (milestone 07).
            state.start_sync_worker();
            // Shared sessions this computer held resume: heartbeats, handoffs, lost connections (milestone 08).
            state.resume_team_sessions();
            state.start_team_worker();
            // The health page's server card starts from a fresh check (milestone 09).
            state.check_server_later();

            // Supervisor monitor: keeps the process table true even while the window is hidden.
            let monitor = state.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(1500));
                    monitor.poll_once();
                }
            });

            build_main_window(app)?;
            build_tray(app, &state)?;

            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            let _ = app.deep_link().register_all();
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&handle, url.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link(app.handle(), url.as_str());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                request_quit(window.app_handle());
            }
        })
        .invoke_handler(handler())
        .build(context());

    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("fatal: {e}");
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Arc<AppState>>() {
                state.supervisor.detach_all();
                state.stop_all_gateways();
            }
            if let Ok(dir) = handle.path().app_local_data_dir() {
                recovery::end_session(&dir);
            }
        }
    });
}
