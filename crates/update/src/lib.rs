//! Browser runtime distribution (milestone 03, ADR-0001/ADR-0010).
//!
//! The manager only ever runs a browser build that is listed in a **signed runtime manifest**:
//!  - the manifest is produced by the `runtime pipeline` workflow, which pins the exact upstream build, records its
//!    SHA-256 and size, runs the compatibility test set on every supported OS, and signs the result (Ed25519);
//!  - the manager embeds the manifest and its detached signature at build time ("pinned per release") and verifies
//!    the signature against compiled-in trusted keys before using any field;
//!  - artifact URLs must be https and start with the prefix compiled in for the named distribution;
//!  - the downloaded archive is verified (size + SHA-256) before anything is extracted (see `install`).
//!
//! There is no way to point the manager at an arbitrary executable in release builds.

pub mod download;
pub mod install;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path};

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("manifest is invalid: {0}")]
    Invalid(String),
    #[error("manifest signature is missing, malformed or not from a trusted key")]
    BadSignature,
    #[error("artifact hash mismatch")]
    HashMismatch,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub const MANIFEST_SCHEMA: u32 = 2;

/// Platforms the manifest may list. Windows x64 and macOS arm64 are supported (ADR-0006); linux-x64 exists for
/// development and CI only.
pub const PLATFORMS: &[&str] = &["windows-x64", "macos-arm64", "linux-x64"];

/// Download prefixes compiled into the manager per distribution. A signed manifest cannot widen these.
pub const DISTRIBUTIONS: &[(&str, &[&str])] = &[(
    "chrome-for-testing",
    &["https://storage.googleapis.com/chrome-for-testing-public/"],
)];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema: u32,
    /// Release channel this manifest belongs to, e.g. "internal-alpha".
    pub channel: String,
    pub created_at: String,
    pub distribution: Distribution,
    pub runtime: RuntimeRelease,
    /// Evidence from the pipeline's compatibility test set (one entry per platform).
    #[serde(default)]
    pub compatibility: Vec<CompatResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Distribution {
    pub id: String,
    pub name: String,
    /// Licence terms as reviewed when the distribution was approved (ADR-0010).
    pub license: String,
    /// False means: engineering/internal use only, never shipped to customers.
    pub customer_distribution: bool,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRelease {
    /// Chromium version, four dotted numbers, e.g. "155.0.8059.39".
    pub version: String,
    /// Upstream build revision (informational).
    pub revision: String,
    pub artifacts: Vec<RuntimeArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeArtifact {
    pub platform: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// Archive format. Only "zip" is accepted.
    pub format: String,
    /// Path of the browser executable inside the extracted archive (relative, forward slashes).
    pub executable: String,
    /// macOS only: "required" makes the manager run `codesign --verify --deep --strict` on the app bundle.
    #[serde(default)]
    pub macos_codesign: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompatResult {
    pub platform: String,
    pub result: String,
    pub tests: u32,
    pub run_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestSignature {
    pub schema: u32,
    pub key_id: String,
    pub algorithm: String,
    /// Ed25519 signature over the exact manifest bytes, lowercase hex (128 chars).
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedKeys {
    pub keys: Vec<TrustedKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedKey {
    pub key_id: String,
    /// Raw Ed25519 public key, lowercase hex (64 chars).
    pub public_key: String,
    pub created: String,
    #[serde(default)]
    pub note: String,
}

impl TrustedKeys {
    pub fn parse(json: &str) -> Result<Self, UpdateError> {
        let keys: Self =
            serde_json::from_str(json).map_err(|e| UpdateError::Invalid(e.to_string()))?;
        for k in &keys.keys {
            decode_hex::<32>(&k.public_key)
                .ok_or_else(|| UpdateError::Invalid(format!("bad public key {}", k.key_id)))?;
        }
        Ok(keys)
    }

    fn get(&self, key_id: &str) -> Option<VerifyingKey> {
        let k = self.keys.iter().find(|k| k.key_id == key_id)?;
        VerifyingKey::from_bytes(&decode_hex::<32>(&k.public_key)?).ok()
    }
}

/// Verifies the detached signature over the exact bytes, then parses and validates the manifest.
pub fn verify_manifest(
    manifest_bytes: &[u8],
    signature_json: &[u8],
    trusted: &TrustedKeys,
) -> Result<RuntimeManifest, UpdateError> {
    let sig: ManifestSignature =
        serde_json::from_slice(signature_json).map_err(|_| UpdateError::BadSignature)?;
    if sig.schema != 1 || sig.algorithm != "ed25519" {
        return Err(UpdateError::BadSignature);
    }
    let key = trusted.get(&sig.key_id).ok_or(UpdateError::BadSignature)?;
    let bytes = decode_hex::<64>(&sig.signature).ok_or(UpdateError::BadSignature)?;
    key.verify_strict(manifest_bytes, &Signature::from_bytes(&bytes))
        .map_err(|_| UpdateError::BadSignature)?;
    let text = std::str::from_utf8(manifest_bytes)
        .map_err(|_| UpdateError::Invalid("not utf-8".into()))?;
    RuntimeManifest::parse(text)
}

impl RuntimeManifest {
    /// Structural validation. Call through [`verify_manifest`] for anything that will be used.
    pub fn parse(json: &str) -> Result<Self, UpdateError> {
        let m: Self =
            serde_json::from_str(json).map_err(|e| UpdateError::Invalid(e.to_string()))?;
        if m.schema != MANIFEST_SCHEMA {
            return Err(UpdateError::Invalid(format!(
                "unsupported schema {}",
                m.schema
            )));
        }
        if parse_version(&m.runtime.version).is_none() {
            return Err(UpdateError::Invalid(
                "runtime.version must be four dotted numbers".into(),
            ));
        }
        let prefixes = DISTRIBUTIONS
            .iter()
            .find(|(id, _)| *id == m.distribution.id)
            .map(|(_, p)| *p)
            .ok_or_else(|| UpdateError::Invalid("unknown distribution".into()))?;
        let mut seen = std::collections::HashSet::new();
        for a in &m.runtime.artifacts {
            if !PLATFORMS.contains(&a.platform.as_str()) || !seen.insert(a.platform.clone()) {
                return Err(UpdateError::Invalid(format!(
                    "bad or duplicate platform {}",
                    a.platform
                )));
            }
            if !prefixes.iter().any(|p| a.url.starts_with(p))
                || a.url.contains("..")
                || a.url.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(UpdateError::Invalid(
                    "artifact url is outside the distribution's allowed location".into(),
                ));
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
            if a.size_bytes == 0 || a.size_bytes > 2 * 1024 * 1024 * 1024 {
                return Err(UpdateError::Invalid("size_bytes out of range".into()));
            }
            if a.format != "zip" {
                return Err(UpdateError::Invalid(
                    "only zip archives are accepted".into(),
                ));
            }
            if !safe_relative_path(&a.executable) {
                return Err(UpdateError::Invalid(
                    "executable path must be relative".into(),
                ));
            }
            if let Some(c) = &a.macos_codesign
                && !(c == "required" || c == "none")
            {
                return Err(UpdateError::Invalid(
                    "macos_codesign must be required|none".into(),
                ));
            }
        }
        Ok(m)
    }

    pub fn artifact_for(&self, platform: &str) -> Option<&RuntimeArtifact> {
        self.runtime
            .artifacts
            .iter()
            .find(|a| a.platform == platform)
    }
}

/// Parses "155.0.8059.39" into comparable parts.
pub fn parse_version(v: &str) -> Option<[u32; 4]> {
    let parts: Vec<u32> = v
        .split('.')
        .map(|p| {
            (!p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect::<Option<_>>()?;
    parts.try_into().ok()
}

/// Major version of a dotted version string ("155.0.8059.39" -> 155).
pub fn major(v: &str) -> Option<u32> {
    v.split('.').next()?.trim().parse().ok()
}

fn safe_relative_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 512
        && !p.contains('\\')
        && !p.contains('\0')
        && Path::new(p)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn decode_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || s.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

pub fn sha256_file(path: &Path) -> Result<(String, u64), UpdateError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// Streams the file through SHA-256 and compares with the pinned digest and size.
pub fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<(), UpdateError> {
    let (digest, size) = sha256_file(path)?;
    if size == artifact.size_bytes && digest == artifact.sha256 {
        Ok(())
    } else {
        Err(UpdateError::HashMismatch)
    }
}

#[cfg(test)]
mod tests;
