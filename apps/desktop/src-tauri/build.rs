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
