//! Runtime pipeline helper: installs a downloaded archive through the SAME installer the manager uses
//! (size + SHA-256 check, safe extraction including macOS bundle links, executable check, macOS code signature),
//! then prints the absolute path of the browser executable.
//!
//! Usage: install_runtime <artifact.json> <archive.zip> <version> <runtimes-root>
//! `artifact.json` is one entry produced by `scripts/runtime/manifest.mjs artifact`.

use pb_update::RuntimeArtifact;
use pb_update::install::{FsSpace, Installer, LocalFile};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, artifact, archive, version, root] = args.as_slice() else {
        eprintln!("usage: install_runtime <artifact.json> <archive.zip> <version> <runtimes-root>");
        std::process::exit(2);
    };
    let artifact: RuntimeArtifact = match std::fs::read(artifact)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad artifact entry: {e}");
            std::process::exit(2);
        }
    };
    let installer = Installer {
        root: PathBuf::from(root),
        space: &FsSpace,
    };
    match installer.install(
        &LocalFile(PathBuf::from(archive)),
        &artifact,
        version,
        &mut |_| {},
    ) {
        Ok(installed) => println!("{}", installed.executable.display()),
        Err(e) => {
            eprintln!("install failed: {} ({e})", e.code());
            std::process::exit(1);
        }
    }
}
