//! Browser runtime selection and installation (milestone 03, steps 1 and 7).
//!
//! - Release builds run only the runtime listed in the signed manifest embedded at build time
//!   (`runtimes/manifest.json` + `.sig`, verified against `runtimes/trusted-keys.json`). There is no setting, IPC
//!   argument or environment variable that changes the executable in a release build.
//! - Debug builds may use `PB_DEV_BROWSER` (a developer's local Chromium); tests inject their own configuration.
//! - Installing downloads the pinned archive over https, verifies size and SHA-256 before extracting, checks the
//!   executable (and on macOS the code signature) and records the installation.

use pb_runtime::BrowserInstall;
use pb_update::install::ArtifactSource;
use pb_update::{RuntimeManifest, TrustedKeys};
use serde::Serialize;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

pub const EMBEDDED_MANIFEST: &[u8] = include_bytes!("../../../../runtimes/manifest.json");
pub const EMBEDDED_SIGNATURE: &[u8] = include_bytes!("../../../../runtimes/manifest.json.sig");
pub const TRUSTED_KEYS: &str = include_str!("../../../../runtimes/trusted-keys.json");

/// Produces the byte stream for a runtime archive. Real builds use HTTPS; tests serve local bytes.
pub trait Fetcher: Send + Sync {
    fn source(
        &self,
        url: &str,
        size: u64,
        cancel: Arc<AtomicBool>,
    ) -> io::Result<Box<dyn ArtifactSource>>;
}

pub struct HttpsFetcher;

impl Fetcher for HttpsFetcher {
    fn source(
        &self,
        url: &str,
        size: u64,
        cancel: Arc<AtomicBool>,
    ) -> io::Result<Box<dyn ArtifactSource>> {
        Ok(Box::new(pb_update::download::HttpsSource::new(
            url, size, cancel,
        )?))
    }
}

pub struct RuntimeConfig {
    /// (manifest bytes, detached signature bytes)
    pub manifest: (Vec<u8>, Vec<u8>),
    pub trusted_keys: String,
    /// Debug builds / tests only: a local browser used instead of the manifest runtime.
    pub dev_override: Option<BrowserInstall>,
    pub fetcher: Arc<dyn Fetcher>,
    /// Extra launch switches from the manager's own test configuration (validated against an allowlist).
    pub switches: Vec<String>,
}

impl RuntimeConfig {
    /// The configuration compiled into this build.
    pub fn embedded() -> Self {
        Self {
            manifest: (EMBEDDED_MANIFEST.to_vec(), EMBEDDED_SIGNATURE.to_vec()),
            trusted_keys: TRUSTED_KEYS.to_owned(),
            dev_override: dev_override(),
            fetcher: Arc::new(HttpsFetcher),
            switches: vec![],
        }
    }
}

/// Debug builds only: `PB_DEV_BROWSER=/path/to/chrome` (optionally `PB_DEV_BROWSER_VERSION=155.0.1.2`).
fn dev_override() -> Option<BrowserInstall> {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("PB_DEV_BROWSER") {
        let install = BrowserInstall {
            executable: path.into(),
            revision: std::env::var("PB_DEV_BROWSER_VERSION").unwrap_or_else(|_| "dev".into()),
        };
        return install.validate().is_ok().then_some(install);
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ManifestStatus {
    Verified {
        version: String,
    },
    /// This build carries no manifest (development builds before the pipeline ran).
    Missing,
    Invalid {
        reason: String,
    },
}

pub fn verify(config: &RuntimeConfig) -> (ManifestStatus, Option<RuntimeManifest>) {
    let (bytes, sig) = &config.manifest;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return (ManifestStatus::Missing, None);
    }
    let keys = match TrustedKeys::parse(&config.trusted_keys) {
        Ok(k) => k,
        Err(e) => {
            return (
                ManifestStatus::Invalid {
                    reason: e.to_string(),
                },
                None,
            );
        }
    };
    match pb_update::verify_manifest(bytes, sig, &keys) {
        Ok(m) => (
            ManifestStatus::Verified {
                version: m.runtime.version.clone(),
            },
            Some(m),
        ),
        Err(e) => (
            ManifestStatus::Invalid {
                reason: e.to_string(),
            },
            None,
        ),
    }
}

/// The browser a launch will use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRuntime {
    pub executable: PathBuf,
    /// Dotted version when known (manifest runtimes always; dev overrides only if configured).
    pub version: Option<String>,
    pub source: &'static str,
}
