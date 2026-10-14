/// Every IPC command the manager UI may call. tauri-build generates an `allow-<command>` permission per entry;
/// capabilities/default.json grants them to the `main` window only.
const COMMANDS: &[&str] = &[
    "get_app_state",
    "create_workspace",
    "set_active_workspace",
    "list_profiles",
    "create_profile",
    "update_profile",
    "launch_profile",
    "stop_profile",
    "close_all_profiles",
    "get_runtime_status",
    "select_download_directory",
    "update_setting",
    "get_diagnostics",
    "export_diagnostics",
    "report_ui_ready",
    "recovery_action",
    "resolve_quit",
    "open_external",
    "remove_local_data",
    "get_profile_status",
    "recover_profile",
    "install_runtime",
    "select_profile_download_directory",
    "query_profiles",
    "get_library",
    "create_client",
    "update_client",
    "create_tag",
    "rename_tag",
    "delete_tag",
    "save_filter",
    "delete_filter",
    "save_template",
    "delete_template",
    "duplicate_profile",
    "bulk_profiles",
    "undo_action",
    "delete_profiles",
    "choose_import_file",
    "preview_import",
    "commit_import",
    "cancel_import",
    "list_imports",
    "export_profiles",
    "list_proxies",
    "create_proxy",
    "update_proxy",
    "delete_proxy",
    "test_proxy",
    "list_proxy_checks",
    "assign_proxy",
    "validate_privacy",
    "get_privacy_options",
    "get_account",
    "set_cloud_server",
    "begin_sign_in",
    "cancel_sign_in",
    "sign_out",
    "cloud_request",
    "org_import",
    "list_org_links",
    "get_sync_status",
    "sync_backup_now",
    "sync_cancel",
    "sync_set_auto_backup",
    "sync_resolve_conflict",
    "sync_restore",
    "sync_restore_here",
    "get_team_status",
    "team_close",
    "team_abort",
    "team_retry",
    "team_dismiss",
    "team_restore_recovery_copy",
    "preview_diagnostics",
    "get_health",
    "run_health_check",
    "get_resources",
    "check_launch",
    "selection_summary",
    "get_client_overview",
    "select_client_download_directory",
    "get_extensions",
    "rescan_extensions",
    "review_extension",
    "get_automation_status",
    "automation_enroll",
    "automation_unenroll",
    "automation_stop_job",
    "automation_set_debugging",
    "automation_screenshot",
    "migration_plan",
    "migration_run",
    "migration_rollback",
    "migration_report",
    "billing_open_checkout",
    "billing_open_portal",
    "billing_open_invoice",
    "get_update_status",
    "check_for_updates",
    "download_update",
    "cancel_update_download",
    "install_update",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(e) = tauri_build::try_build(attributes) {
        panic!("tauri build failed: {e:#}");
    }

    // Windows (MSVC): give integration-test executables the Common Controls v6 manifest that the real app
    // receives from tauri-build; otherwise they abort with STATUS_ENTRYPOINT_NOT_FOUND before any test runs.
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
