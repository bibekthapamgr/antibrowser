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
