//! Runtime manifest: which exact browser build each manager release is pinned to (roadmap: "Maintained
//! Chromium stable distribution, pinned per release"), and integrity verification of downloaded artifacts.
//!
//! Milestone 01 scope: data model, strict parsing and SHA-256 verification. Manifest signatures, staged
//! rollout and rollback are milestone 12; the Tauri updater handles the manager itself.

pub mod install;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("manifest is invalid: {0}")]
    Invalid(String),
    #[error("artifact hash mismatch")]
    HashMismatch,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema: u32,
    /// Upstream browser version, e.g. "153.0.7790.12".
    pub browser_version: String,
    /// Where the build comes from (see docs/adr/0001-runtime-distribution.md).
    pub distribution: String,
    pub artifacts: Vec<RuntimeArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeArtifact {
    pub platform: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

const PLATFORMS: &[&str] = &["windows-x64", "macos-arm64", "macos-x64", "linux-x64"];

impl RuntimeManifest {
    pub fn parse(json: &str) -> Result<Self, UpdateError> {
        let m: Self =
            serde_json::from_str(json).map_err(|e| UpdateError::Invalid(e.to_string()))?;
        if m.schema != 1 {
            return Err(UpdateError::Invalid(format!(
                "unsupported schema {}",
                m.schema
            )));
        }
        if m.browser_version.is_empty()
            || !m
                .browser_version
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.')
        {
            return Err(UpdateError::Invalid(
                "browser_version must be dotted digits".into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for a in &m.artifacts {
            if !PLATFORMS.contains(&a.platform.as_str()) || !seen.insert(a.platform.clone()) {
                return Err(UpdateError::Invalid(format!(
                    "bad or duplicate platform {}",
                    a.platform
                )));
            }
            if !a.url.starts_with("https://") {
                return Err(UpdateError::Invalid("artifact urls must be https".into()));
            }
            if a.sha256.len() != 64
                || !a
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err(UpdateError::Invalid(
                    "sha256 must be 64 lowercase hex chars".into(),
                ));
            }
            if a.size_bytes == 0 {
                return Err(UpdateError::Invalid("size_bytes must be positive".into()));
            }
        }
        Ok(m)
    }

    pub fn artifact_for(&self, platform: &str) -> Option<&RuntimeArtifact> {
        self.artifacts.iter().find(|a| a.platform == platform)
    }
}

/// Streams the file through SHA-256 and compares with the pinned digest.
pub fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<(), UpdateError> {
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() != artifact.size_bytes {
        return Err(UpdateError::HashMismatch);
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex == artifact.sha256 {
        Ok(())
    } else {
        Err(UpdateError::HashMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SHA_HELLO: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn manifest(url: &str) -> String {
        format!(
            r#"{{"schema":1,"browser_version":"153.0.1","distribution":"tbd","artifacts":[{{"platform":"windows-x64","url":"{url}","sha256":"{SHA_HELLO}","size_bytes":5}}]}}"#
        )
    }

    #[test]
    fn parses_and_verifies() -> Result<(), UpdateError> {
        let m = RuntimeManifest::parse(&manifest("https://downloads.example/rt.zip"))?;
        let artifact = m
            .artifact_for("windows-x64")
            .ok_or(UpdateError::HashMismatch)?;
        let mut f = tempfile::NamedTempFile::new()?;
        f.write_all(b"hello")?;
        verify_artifact(f.path(), artifact)?;
        let mut g = tempfile::NamedTempFile::new()?;
        g.write_all(b"hellO")?;
        assert!(matches!(
            verify_artifact(g.path(), artifact),
            Err(UpdateError::HashMismatch)
        ));
        Ok(())
    }

    #[test]
    fn rejects_insecure_or_unknown_input() {
        assert!(RuntimeManifest::parse(&manifest("http://downloads.example/rt.zip")).is_err());
        assert!(
            RuntimeManifest::parse(
                r#"{"schema":1,"browser_version":"1","distribution":"x","artifacts":[],"extra":1}"#
            )
            .is_err()
        );
        assert!(
            RuntimeManifest::parse(
                r#"{"schema":2,"browser_version":"1","distribution":"x","artifacts":[]}"#
            )
            .is_err()
        );
    }
}
