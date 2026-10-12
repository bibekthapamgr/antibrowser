fn main() {
    // Declaring the app's commands generates per-command permissions (allow-<command>), so the capability
    // file is the single allow-list for what the manager UI may invoke.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "list_profiles",
            "create_local_profile",
            "launch_profile",
        ]));
    if let Err(e) = tauri_build::try_build(attributes) {
        panic!("tauri build failed: {e:#}");
    }
}
