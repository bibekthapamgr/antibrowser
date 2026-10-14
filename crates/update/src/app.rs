//! Manager (desktop app) updates (milestone 12, ADR-0019).
//!
//! Two independent checks protect every update, in addition to whatever OS code signature the installer carries:
//!  1. A **signed channel manifest** (`<channel>.json` + `.sig`, Tauri/minisign format) published for each channel
//!     (`dev`, `canary`, `stable`). It names the release, every artifact's URL, size and SHA-256, the lowest version
//!     that is still safe (`minimum_version`) and revoked versions, and it carries an increasing `sequence` and an
//!     expiry. The manager rejects a manifest that is unsigned, signed by an unknown or expired key, expired, or older
//!     than one it has already accepted (replay / freeze), and never installs an older version (no rollback).
//!  2. Each artifact's own **Tauri update signature** (minisign over the file, bound to the release version), checked
//!     after the SHA-256 from the manifest.
//!
//! Trusted keys are compiled into the build with a validity window. Downloads are https only, from the project's
//! release URL prefix, size-capped, resumable, and nothing is kept or run unless both checks pass.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const PRODUCT: &str = "project-browser-manager";
pub const CHANNELS: &[&str] = &["dev", "canary", "stable"];
pub const MANIFEST_SCHEMA: u32 = 1;
/// Where releases and channel manifests are published (GitHub Releases of the project repository).
pub const RELEASE_URL_PREFIX: &str =
    "https://github.com/bibekthapamgr/antibrowser/releases/download/";
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
pub const MAX_SIGNATURE_BYTES: u64 = 4 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
/// A manifest may not claim to stay valid longer than this after it was issued.
pub const MAX_VALIDITY_SECONDS: i64 = 120 * 86_400;
/// Tolerated difference between the publisher's clock and this computer's.
pub const CLOCK_SKEW_SECONDS: i64 = 10 * 60;

pub fn manifest_url(channel: &str) -> String {
    format!("{RELEASE_URL_PREFIX}channel-{channel}/{channel}.json")
}

pub fn signature_url(channel: &str) -> String {
    format!("{}.sig", manifest_url(channel))
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppUpdateError {
    #[error("this build has no trusted release key")]
    NoKeys,
    #[error("the update information is not signed by a trusted release key")]
    BadSignature,
    #[error("the release signing key expired on {0}")]
    KeyExpired(String),
    #[error("the update information is invalid: {0}")]
    Invalid(String),
    #[error("the update information expired on {0}")]
    Expired(String),
    #[error("the update information is older than what this computer already saw ({got} < {seen})")]
    Replayed { seen: u64, got: u64 },
    #[error("the download does not match the signed update information")]
    Corrupt,
    #[error("download failed: {0}")]
    Download(String),
    #[error("download cancelled")]
    Cancelled,
    #[error("install failed: {0}")]
    Install(String),
    #[error("file error: {0}")]
    Io(String),
}

impl AppUpdateError {
    /// Stable machine code for the manager UI and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKeys => "UPDATES_NOT_CONFIGURED",
            Self::BadSignature => "UPDATE_SIGNATURE_INVALID",
            Self::KeyExpired(_) => "UPDATE_KEY_EXPIRED",
            Self::Invalid(_) => "UPDATE_MANIFEST_INVALID",
            Self::Expired(_) => "UPDATE_MANIFEST_EXPIRED",
            Self::Replayed { .. } => "UPDATE_MANIFEST_REPLAYED",
            Self::Corrupt => "UPDATE_CORRUPT",
            Self::Download(_) => "UPDATE_DOWNLOAD_FAILED",
            Self::Cancelled => "UPDATE_CANCELLED",
            Self::Install(_) => "UPDATE_INSTALL_FAILED",
            Self::Io(_) => "UPDATE_IO",
        }
    }
}

impl From<io::Error> for AppUpdateError {
    fn from(e: io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

// ================================================================================================ time
/// Seconds since the Unix epoch for `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS[.fff]Z` (UTC only).
pub fn parse_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = s.get(r)?;
        if !t.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (mut hh, mut mm, mut ss) = (0, 0, 0);
    if b.len() > 10 {
        if b.len() < 20 || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
            return None;
        }
        hh = num(11..13)?;
        mm = num(14..16)?;
        ss = num(17..19)?;
        let frac = s.get(19..b.len() - 1)?;
        if !(frac.is_empty()
            || (frac.len() >= 2
                && frac.starts_with('.')
                && frac[1..].bytes().all(|c| c.is_ascii_digit())))
        {
            return None;
        }
        if hh > 23 || mm > 59 || ss > 60 {
            return None;
        }
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ================================================================================================ keys
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseKeysFile {
    keys: Vec<ReleaseKeyEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseKeyEntry {
    /// minisign key id, 16 uppercase hex characters (as `tauri signer generate` prints it).
    key_id: String,
    /// The `.pub` file content as `tauri signer generate` writes it (base64 of the minisign public key text).
    public_key: String,
    not_before: String,
    not_after: String,
    #[serde(default)]
    #[allow(dead_code)]
    note: String,
}

struct LoadedKey {
    key_id: String,
    key: PublicKey,
    not_before: i64,
    not_after: i64,
    not_after_text: String,
}

/// Release signing keys compiled into the manager, each with a validity window (like a certificate's).
#[derive(Default)]
pub struct ReleaseKeys {
    keys: Vec<LoadedKey>,
}

/// The minisign key id of a public key line (little-endian u64 after the 2-byte algorithm), as uppercase hex.
fn key_id_of(key_line: &str) -> Option<String> {
    let raw = B64.decode(key_line.trim()).ok()?;
    if raw.len() != 42 || &raw[0..2] != b"Ed" {
        return None;
    }
    Some(
        raw[2..10]
            .iter()
            .rev()
            .map(|b| format!("{b:02X}"))
            .collect(),
    )
}

impl ReleaseKeys {
    pub fn parse(json: &str) -> Result<Self, AppUpdateError> {
        let file: ReleaseKeysFile = serde_json::from_str(json)
            .map_err(|e| AppUpdateError::Invalid(format!("release keys: {e}")))?;
        let mut keys = Vec::new();
        for e in file.keys {
            let text = B64
                .decode(e.public_key.trim())
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .ok_or_else(|| {
                    AppUpdateError::Invalid(format!("release key {}: not base64", e.key_id))
                })?;
            let key_line = text
                .lines()
                .find(|l| !l.starts_with("untrusted comment:") && !l.trim().is_empty())
                .ok_or_else(|| {
                    AppUpdateError::Invalid(format!("release key {}: empty", e.key_id))
                })?;
            if key_id_of(key_line).as_deref() != Some(e.key_id.as_str()) {
                return Err(AppUpdateError::Invalid(format!(
                    "release key {}: the key id does not match the key",
                    e.key_id
                )));
            }
            let key = PublicKey::decode(&text).map_err(|_| {
                AppUpdateError::Invalid(format!("release key {}: not a minisign key", e.key_id))
            })?;
            let not_before = parse_utc(&e.not_before).ok_or_else(|| {
                AppUpdateError::Invalid(format!("release key {}: not_before", e.key_id))
            })?;
            let not_after = parse_utc(&e.not_after).ok_or_else(|| {
                AppUpdateError::Invalid(format!("release key {}: not_after", e.key_id))
            })?;
            if not_after <= not_before {
                return Err(AppUpdateError::Invalid(format!(
                    "release key {}: empty validity",
                    e.key_id
                )));
            }
            keys.push(LoadedKey {
                key_id: e.key_id,
                key,
                not_before,
                not_after,
                not_after_text: e.not_after,
            });
        }
        Ok(Self { keys })
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn key_ids(&self) -> Vec<String> {
        self.keys.iter().map(|k| k.key_id.clone()).collect()
    }

    fn decode_signature(sig_b64: &str) -> Result<Signature, AppUpdateError> {
        if sig_b64.len() as u64 > MAX_SIGNATURE_BYTES {
            return Err(AppUpdateError::BadSignature);
        }
        let text = B64
            .decode(sig_b64.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or(AppUpdateError::BadSignature)?;
        Signature::decode(&text).map_err(|_| AppUpdateError::BadSignature)
    }

    /// The trusted key whose check passes, if it is valid at `now` (an expired key fails like an expired
    /// certificate: its signatures are no longer accepted).
    fn signer(
        &self,
        check: impl Fn(&PublicKey) -> bool,
        now: i64,
    ) -> Result<&LoadedKey, AppUpdateError> {
        for k in &self.keys {
            if check(&k.key) {
                if now > k.not_after {
                    return Err(AppUpdateError::KeyExpired(k.not_after_text.clone()));
                }
                if now < k.not_before {
                    return Err(AppUpdateError::BadSignature);
                }
                return Ok(k);
            }
        }
        Err(AppUpdateError::BadSignature)
    }

    /// Verifies a Tauri-format signature (base64 of the minisign signature text) over `data` and returns the
    /// trusted comment's `key:value` fields (only after the signature, which covers them, has been checked).
    pub fn verify(
        &self,
        data: &[u8],
        sig_b64: &str,
        now: i64,
    ) -> Result<BTreeMap<String, String>, AppUpdateError> {
        if self.keys.is_empty() {
            return Err(AppUpdateError::NoKeys);
        }
        let sig = Self::decode_signature(sig_b64)?;
        self.signer(|k| k.verify(data, &sig, false).is_ok(), now)?;
        Ok(comment_fields(sig.trusted_comment()))
    }

    /// Like [`verify`](Self::verify) for a file, hashed in a stream (artifacts can be large).
    pub fn verify_file(
        &self,
        path: &Path,
        sig_b64: &str,
        now: i64,
    ) -> Result<BTreeMap<String, String>, AppUpdateError> {
        if self.keys.is_empty() {
            return Err(AppUpdateError::NoKeys);
        }
        let sig = Self::decode_signature(sig_b64)?;
        let check = |k: &PublicKey| -> bool {
            let Ok(mut v) = k.verify_stream(&sig) else {
                return false;
            };
            let Ok(mut f) = std::fs::File::open(path) else {
                return false;
            };
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match f.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => v.update(&buf[..n]),
                    Err(_) => return false,
                }
            }
            v.finalize().is_ok()
        };
        self.signer(check, now)?;
        Ok(comment_fields(sig.trusted_comment()))
    }
}

/// `timestamp:…\tfile:…\tversion:…` → map.
fn comment_fields(comment: &str) -> BTreeMap<String, String> {
    comment
        .split('\t')
        .filter_map(|kv| kv.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

// ================================================================================================ manifest
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelManifest {
    pub schema: u32,
    pub product: String,
    pub channel: String,
    /// Strictly increasing per channel; a smaller one than already accepted is a replay.
    pub sequence: u64,
    pub issued_at: String,
    pub expires_at: String,
    /// Distribution paused (a release under investigation): no update is offered.
    #[serde(default)]
    pub paused: bool,
    /// Versions below this are known to be unsafe: the manager says an update is required.
    #[serde(default)]
    pub minimum_version: Option<String>,
    /// Known-bad versions: never installed, and a manager running one says an update is required.
    #[serde(default)]
    pub revoked_versions: Vec<String>,
    /// Known-bad browser runtime archives (SHA-256): never installed, and not launched.
    #[serde(default)]
    pub revoked_runtime_sha256: Vec<String>,
    #[serde(default)]
    pub release: Option<Release>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub published_at: String,
    pub notes_url: String,
    pub artifacts: Vec<AppArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppArtifact {
    /// `windows-x64` or `macos-arm64` (`linux-x64` for development builds only).
    pub platform: String,
    /// `nsis` (Windows installer, per-user) or `app-tar-gz` (macOS app bundle archive).
    pub kind: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// The artifact's Tauri update signature (base64 of the minisign signature text), bound to the version.
    pub signature: String,
}

impl AppArtifact {
    pub fn file_name(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or("")
    }
}

pub fn parse_version(v: &str) -> Option<Version> {
    Version::parse(v).ok()
}

fn https_release_url(url: &str) -> bool {
    url.len() <= 512
        && url.starts_with(RELEASE_URL_PREFIX)
        && !url.contains("..")
        && !url.contains(['?', '#', '\\', ' '])
        && url[RELEASE_URL_PREFIX.len()..].split('/').count() == 2
}

impl ChannelManifest {
    /// Structural validation (types, ranges, URLs). Signature, freshness and replay are checked by
    /// [`verify_channel_manifest`] and [`evaluate`].
    pub fn parse(bytes: &[u8]) -> Result<Self, AppUpdateError> {
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(AppUpdateError::Invalid("too large".into()));
        }
        let m: Self =
            serde_json::from_slice(bytes).map_err(|e| AppUpdateError::Invalid(e.to_string()))?;
        let bad = |s: &str| Err(AppUpdateError::Invalid(s.to_owned()));
        if m.schema != MANIFEST_SCHEMA {
            return bad("unsupported schema");
        }
        if m.product != PRODUCT {
            return bad("another product");
        }
        if !CHANNELS.contains(&m.channel.as_str()) {
            return bad("unknown channel");
        }
        if m.sequence == 0 {
            return bad("sequence must be positive");
        }
        let issued =
            parse_utc(&m.issued_at).ok_or_else(|| AppUpdateError::Invalid("issued_at".into()))?;
        let expires =
            parse_utc(&m.expires_at).ok_or_else(|| AppUpdateError::Invalid("expires_at".into()))?;
        if expires <= issued || expires - issued > MAX_VALIDITY_SECONDS {
            return bad("validity window out of range");
        }
        if let Some(min) = &m.minimum_version
            && parse_version(min).is_none()
        {
            return bad("minimum_version");
        }
        if m.revoked_versions.len() > 200
            || m.revoked_versions
                .iter()
                .any(|v| parse_version(v).is_none())
        {
            return bad("revoked_versions");
        }
        if m.revoked_runtime_sha256.len() > 200
            || m.revoked_runtime_sha256.iter().any(|h| !is_sha256(h))
        {
            return bad("revoked_runtime_sha256");
        }
        if let Some(r) = &m.release {
            if parse_version(&r.version).is_none() {
                return bad("release.version");
            }
            parse_utc(&r.published_at)
                .ok_or_else(|| AppUpdateError::Invalid("published_at".into()))?;
            if !r
                .notes_url
                .starts_with("https://github.com/bibekthapamgr/antibrowser/")
                || r.notes_url.len() > 512
            {
                return bad("notes_url");
            }
            if r.artifacts.is_empty() || r.artifacts.len() > 8 {
                return bad("artifacts");
            }
            let mut seen = std::collections::HashSet::new();
            for a in &r.artifacts {
                let kind_ok = matches!(
                    (a.platform.as_str(), a.kind.as_str()),
                    ("windows-x64", "nsis")
                        | ("macos-arm64", "app-tar-gz")
                        | ("linux-x64", "app-tar-gz")
                );
                if !kind_ok || !seen.insert(a.platform.clone()) {
                    return bad("artifact platform or kind");
                }
                if !https_release_url(&a.url) {
                    return bad("artifact url");
                }
                if !is_sha256(&a.sha256) {
                    return bad("artifact sha256");
                }
                if a.size_bytes == 0 || a.size_bytes > MAX_ARTIFACT_BYTES {
                    return bad("artifact size");
                }
                if a.signature.is_empty() || a.signature.len() as u64 > MAX_SIGNATURE_BYTES {
                    return bad("artifact signature");
                }
            }
        }
        Ok(m)
    }

    pub fn artifact_for(&self, platform: &str) -> Option<&AppArtifact> {
        self.release
            .as_ref()?
            .artifacts
            .iter()
            .find(|a| a.platform == platform)
    }
}

fn is_sha256(h: &str) -> bool {
    h.len() == 64
        && h.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Verifies the channel manifest's signature (trusted, unexpired key; signed for this channel's file) and its
/// structure. Freshness and replay are judged by [`evaluate`] with this computer's state.
pub fn verify_channel_manifest(
    bytes: &[u8],
    sig_b64: &str,
    keys: &ReleaseKeys,
    now: i64,
) -> Result<ChannelManifest, AppUpdateError> {
    let fields = keys.verify(bytes, sig_b64, now)?;
    let m = ChannelManifest::parse(bytes)?;
    // The release job signs `<channel>.json`; a signature made for another file (another channel's manifest, or
    // any other signed file) is refused.
    if fields.get("file") != Some(&format!("{}.json", m.channel)) {
        return Err(AppUpdateError::Invalid(
            "signed for another channel file".into(),
        ));
    }
    Ok(m)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum Blocked {
    /// This version is below the channel's minimum safe version.
    BelowMinimum { minimum_version: String },
    /// This version was revoked.
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Offer {
    pub version: String,
    pub notes_url: String,
    pub artifact: AppArtifact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Assessment {
    pub channel: String,
    pub sequence: u64,
    pub expires_at: String,
    pub paused: bool,
    pub current_blocked: Option<Blocked>,
    pub offer: Option<Offer>,
    /// Newest version on the channel (also when it is not newer than this one).
    pub latest_version: Option<String>,
    pub revoked_runtime_sha256: Vec<String>,
}

/// Judges a verified manifest for this computer: the expected channel, freshness, replay (sequence below the last
/// accepted one), whether this version must be updated, and what may be installed — never an older version, a
/// revoked one, or one below the minimum.
pub fn evaluate(
    m: &ChannelManifest,
    expected_channel: &str,
    current_version: &str,
    platform: &str,
    last_sequence: Option<u64>,
    now: i64,
) -> Result<Assessment, AppUpdateError> {
    if m.channel != expected_channel {
        return Err(AppUpdateError::Invalid("another channel".into()));
    }
    let issued = parse_utc(&m.issued_at).unwrap_or(i64::MAX);
    let expires = parse_utc(&m.expires_at).unwrap_or(i64::MIN);
    if issued > now + CLOCK_SKEW_SECONDS {
        return Err(AppUpdateError::Invalid(
            "issued in the future (check this computer's clock)".into(),
        ));
    }
    if now > expires {
        return Err(AppUpdateError::Expired(m.expires_at.clone()));
    }
    if let Some(seen) = last_sequence
        && m.sequence < seen
    {
        return Err(AppUpdateError::Replayed {
            seen,
            got: m.sequence,
        });
    }
    let current = parse_version(current_version)
        .ok_or_else(|| AppUpdateError::Invalid("this build's version is not semver".into()))?;
    let revoked: Vec<Version> = m
        .revoked_versions
        .iter()
        .filter_map(|v| parse_version(v))
        .collect();
    let minimum = m.minimum_version.as_deref().and_then(parse_version);
    let current_blocked = if revoked.contains(&current) {
        Some(Blocked::Revoked)
    } else {
        minimum
            .as_ref()
            .filter(|min| current < **min)
            .map(|min| Blocked::BelowMinimum {
                minimum_version: min.to_string(),
            })
    };
    let mut offer = None;
    let mut latest_version = None;
    if let Some(r) = &m.release
        && let Some(v) = parse_version(&r.version)
    {
        latest_version = Some(v.to_string());
        let safe = !revoked.contains(&v) && minimum.as_ref().is_none_or(|min| v >= *min);
        if !m.paused
            && safe
            && v > current
            && let Some(a) = m.artifact_for(platform)
        {
            offer = Some(Offer {
                version: v.to_string(),
                notes_url: r.notes_url.clone(),
                artifact: a.clone(),
            });
        }
    }
    Ok(Assessment {
        channel: m.channel.clone(),
        sequence: m.sequence,
        expires_at: m.expires_at.clone(),
        paused: m.paused,
        current_blocked,
        offer,
        latest_version,
        revoked_runtime_sha256: m.revoked_runtime_sha256.clone(),
    })
}

// ================================================================================================ local state
/// What this computer remembers between checks: the highest sequence accepted per channel (replay protection).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateState {
    #[serde(default)]
    pub sequences: BTreeMap<String, u64>,
    #[serde(default)]
    pub revoked_runtime_sha256: Vec<String>,
}

impl UpdateState {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Written to a temporary file and renamed, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
            f.sync_all()?;
        }
        std::fs::rename(tmp, path)
    }

    /// Records an accepted manifest (never lowers a channel's sequence).
    pub fn accept(&mut self, a: &Assessment) {
        let e = self.sequences.entry(a.channel.clone()).or_insert(0);
        *e = (*e).max(a.sequence);
        self.revoked_runtime_sha256 = a.revoked_runtime_sha256.clone();
    }
}

// ================================================================================================ transport
/// How the manager reaches the release host (https in the app; files in tests).
pub trait Transport: Send + Sync {
    /// A small document (manifest, signature), at most `max_bytes`.
    fn get(&self, url: &str, max_bytes: u64) -> io::Result<Vec<u8>>;
    /// The body from `offset` (an HTTP range request). Returns the reader and the offset actually served:
    /// 0 when the server ignored the range.
    fn open_from(&self, url: &str, offset: u64) -> io::Result<(Box<dyn Read + Send>, u64)>;
}

/// https only (also across redirects), the system's trust store, bounded sizes and timeouts.
pub struct HttpsTransport;

impl HttpsTransport {
    fn agent() -> ureq::Agent {
        use ureq::tls::{RootCerts, TlsConfig};
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(5)
            .http_status_as_error(true)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .user_agent(concat!(
                "project-browser-manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into()
    }

    fn check(url: &str) -> io::Result<()> {
        if !url.starts_with(RELEASE_URL_PREFIX) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a release address",
            ));
        }
        Ok(())
    }
}

impl Transport for HttpsTransport {
    fn get(&self, url: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
        Self::check(url)?;
        let response = Self::agent()
            .get(url)
            .call()
            .map_err(|e| io::Error::other(e.to_string()))?;
        response
            .into_body()
            .into_with_config()
            .limit(max_bytes)
            .read_to_vec()
            .map_err(|e| io::Error::other(e.to_string()))
    }

    fn open_from(&self, url: &str, offset: u64) -> io::Result<(Box<dyn Read + Send>, u64)> {
        Self::check(url)?;
        let mut req = Self::agent().get(url);
        if offset > 0 {
            req = req.header("Range", &format!("bytes={offset}-"));
        }
        let response = req.call().map_err(|e| io::Error::other(e.to_string()))?;
        let served = if offset > 0 && response.status().as_u16() == 206 {
            offset
        } else {
            0
        };
        let reader = response
            .into_body()
            .into_with_config()
            .limit(MAX_ARTIFACT_BYTES + 1)
            .reader();
        Ok((Box::new(reader), served))
    }
}

/// Fetches, verifies and judges a channel's manifest.
pub fn check_channel(
    transport: &dyn Transport,
    keys: &ReleaseKeys,
    channel: &str,
    current_version: &str,
    platform: &str,
    state: &UpdateState,
    now: i64,
) -> Result<Assessment, AppUpdateError> {
    if keys.is_empty() {
        return Err(AppUpdateError::NoKeys);
    }
    if !CHANNELS.contains(&channel) {
        return Err(AppUpdateError::Invalid("unknown channel".into()));
    }
    let bytes = transport
        .get(&manifest_url(channel), MAX_MANIFEST_BYTES)
        .map_err(|e| AppUpdateError::Download(e.to_string()))?;
    let sig = transport
        .get(&signature_url(channel), MAX_SIGNATURE_BYTES)
        .map_err(|e| AppUpdateError::Download(e.to_string()))?;
    let sig = String::from_utf8(sig).map_err(|_| AppUpdateError::BadSignature)?;
    let m = verify_channel_manifest(&bytes, &sig, keys, now)?;
    evaluate(
        &m,
        channel,
        current_version,
        platform,
        state.sequences.get(channel).copied(),
        now,
    )
}

// ================================================================================================ download
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    pub path: PathBuf,
    pub version: String,
    pub sha256: String,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct PartMeta {
    url: String,
    sha256: String,
    size_bytes: u64,
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Checks a finished file against the manifest (size, SHA-256) and its Tauri signature (trusted key, bound to this
/// version and file name). Also run again right before installing, so a file changed after its download is refused.
pub fn verify_artifact_file(
    path: &Path,
    offer: &Offer,
    keys: &ReleaseKeys,
    now: i64,
) -> Result<String, AppUpdateError> {
    let a = &offer.artifact;
    if std::fs::metadata(path)?.len() != a.size_bytes {
        return Err(AppUpdateError::Corrupt);
    }
    let digest = sha256_file(path)?;
    if digest != a.sha256 {
        return Err(AppUpdateError::Corrupt);
    }
    let fields = keys.verify_file(path, &a.signature, now)?;
    match fields.get("version").and_then(|v| parse_version(v)) {
        Some(v) if Some(&v) == parse_version(&offer.version).as_ref() => {}
        _ => return Err(AppUpdateError::BadSignature),
    }
    if fields.get("file").map(String::as_str) != Some(a.file_name()) {
        return Err(AppUpdateError::BadSignature);
    }
    Ok(digest)
}

/// Downloads the offered artifact into `dir` (resuming an interrupted download of the same file), then verifies it.
/// On any mismatch the partial or complete file is deleted; nothing unverified is ever returned.
pub fn download_verified(
    transport: &dyn Transport,
    keys: &ReleaseKeys,
    offer: &Offer,
    dir: &Path,
    now: i64,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Downloaded, AppUpdateError> {
    let a = &offer.artifact;
    if !https_release_url(&a.url) || a.size_bytes > MAX_ARTIFACT_BYTES {
        return Err(AppUpdateError::Invalid("artifact url".into()));
    }
    let name = a.file_name();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) {
        return Err(AppUpdateError::Invalid("artifact name".into()));
    }
    std::fs::create_dir_all(dir)?;
    let final_path = dir.join(name);
    let part = dir.join(format!("{name}.part"));
    let meta_path = dir.join(format!("{name}.part.json"));
    let done = |digest: String| Downloaded {
        path: final_path.clone(),
        version: offer.version.clone(),
        sha256: digest,
    };

    // Already downloaded and still valid (e.g. the install was postponed).
    if final_path.exists() {
        match verify_artifact_file(&final_path, offer, keys, now) {
            Ok(d) => return Ok(done(d)),
            Err(_) => std::fs::remove_file(&final_path)?,
        }
    }

    let meta = PartMeta {
        url: a.url.clone(),
        sha256: a.sha256.clone(),
        size_bytes: a.size_bytes,
    };
    let resumable = std::fs::read(&meta_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<PartMeta>(&b).ok())
        .is_some_and(|m| m == meta);
    let mut offset = if resumable {
        std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    if offset >= a.size_bytes {
        offset = 0;
    }
    std::fs::write(
        &meta_path,
        serde_json::to_vec(&meta).map_err(io::Error::other)?,
    )?;

    let (mut reader, served) = transport
        .open_from(&a.url, offset)
        .map_err(|e| AppUpdateError::Download(e.to_string()))?;
    if served != offset {
        offset = 0; // the server sent the whole file: start over
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&part)?;
    file.set_len(offset)?;
    io::Seek::seek(&mut file, io::SeekFrom::Start(offset))?;
    let mut written = offset;
    let mut buf = vec![0u8; 64 * 1024];
    progress(written, a.size_bytes);
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.sync_all()?;
            return Err(AppUpdateError::Cancelled);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                // Kept for a resume: the next attempt continues from here.
                let _ = file.sync_all();
                return Err(AppUpdateError::Download(e.to_string()));
            }
        };
        if written + n as u64 > a.size_bytes {
            drop(file);
            discard(&part, &meta_path);
            return Err(AppUpdateError::Corrupt);
        }
        file.write_all(&buf[..n])?;
        written += n as u64;
        progress(written, a.size_bytes);
    }
    file.sync_all()?;
    drop(file);
    if written != a.size_bytes {
        // The connection ended early: keep the part for a resume.
        return Err(AppUpdateError::Download("the download ended early".into()));
    }
    match verify_artifact_file(&part, offer, keys, now) {
        Ok(digest) => {
            std::fs::rename(&part, &final_path)?;
            let _ = std::fs::remove_file(&meta_path);
            Ok(done(digest))
        }
        Err(e) => {
            discard(&part, &meta_path);
            Err(e)
        }
    }
}

fn discard(part: &Path, meta: &Path) {
    let _ = std::fs::remove_file(part);
    let _ = std::fs::remove_file(meta);
}

/// Removes downloaded updates other than `keep` (old versions, abandoned parts).
pub fn clean_downloads(dir: &Path, keep: Option<&Path>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if Some(p.as_path()) != keep
                && p.file_name().is_some_and(|n| n != "state.json")
                && p.is_file()
            {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

// ================================================================================================ install
/// The Windows (NSIS, per-user) installer runs in passive mode as an update and starts the manager again.
pub const WINDOWS_INSTALLER_ARGS: &[&str] = &["/P", "/UPDATE", "/R"];

pub const BUNDLE_ID: &str = "dev.projectbrowser.manager";

fn plist_value_is(plist: &str, key: &str, value: &str) -> bool {
    let Some(i) = plist.find(&format!("<key>{key}</key>")) else {
        return false;
    };
    let rest = plist[i..]
        .split_once("</key>")
        .map(|(_, r)| r.trim_start())
        .unwrap_or("");
    rest.starts_with(&format!("<string>{value}</string>"))
}

/// Normalises a relative path inside the archive; None for absolute paths or `..` escapes.
fn inside(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Extracts a verified macOS app archive (`<Name>.app/...`) into `staging` (the bundle's root), refusing absolute
/// paths, `..`, hard links, device files and symbolic links that point outside the bundle.
pub fn extract_app_archive(archive: &Path, staging: &Path) -> Result<(), AppUpdateError> {
    let bad = |s: &str| AppUpdateError::Install(format!("unexpected archive content: {s}"));
    std::fs::create_dir_all(staging)?;
    let gz = flate2::read::GzDecoder::new(std::fs::File::open(archive)?);
    let mut tar = tar::Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(false);
    let mut top: Option<std::ffi::OsString> = None;
    for entry in tar.entries()? {
        let mut entry = entry?;
        let raw = entry.path()?.into_owned();
        let mut comps = raw.components().filter(|c| !matches!(c, Component::CurDir));
        let first = match comps.next() {
            Some(Component::Normal(f)) => f.to_owned(),
            _ => return Err(bad("path")),
        };
        if !first.to_string_lossy().ends_with(".app") {
            return Err(bad("not an app bundle"));
        }
        match &top {
            None => top = Some(first.clone()),
            Some(t) if *t != first => return Err(bad("more than one bundle")),
            Some(_) => {}
        }
        let rel: PathBuf = comps.collect();
        let rel = inside(&rel).ok_or_else(|| bad("path escapes the bundle"))?;
        let kind = entry.header().entry_type();
        if kind.is_hard_link()
            || kind.is_block_special()
            || kind.is_character_special()
            || kind.is_fifo()
        {
            return Err(bad("special file"));
        }
        if kind.is_symlink() {
            let target = entry
                .link_name()?
                .ok_or_else(|| bad("symlink"))?
                .into_owned();
            if target.is_absolute() {
                return Err(bad("absolute symlink"));
            }
            let resolved = rel.parent().unwrap_or(Path::new("")).join(&target);
            inside(&resolved).ok_or_else(|| bad("symlink escapes the bundle"))?;
        }
        if rel.as_os_str().is_empty() {
            continue; // the bundle directory itself
        }
        let dest = staging.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&dest)?;
    }
    if top.is_none() {
        return Err(bad("empty"));
    }
    Ok(())
}

/// Checks the staged bundle is this app at the expected version.
pub fn check_staged_bundle(staging: &Path, expected_version: &str) -> Result<(), AppUpdateError> {
    let plist = std::fs::read_to_string(staging.join("Contents/Info.plist"))
        .map_err(|_| AppUpdateError::Install("the update has no Info.plist".into()))?;
    if !plist_value_is(&plist, "CFBundleIdentifier", BUNDLE_ID) {
        return Err(AppUpdateError::Install("the update is not this app".into()));
    }
    if !plist_value_is(&plist, "CFBundleShortVersionString", expected_version) {
        return Err(AppUpdateError::Install(
            "the update's version is not the signed one".into(),
        ));
    }
    let has_exe = std::fs::read_dir(staging.join("Contents/MacOS"))
        .map(|mut d| d.next().is_some())
        .unwrap_or(false);
    if !has_exe {
        return Err(AppUpdateError::Install(
            "the update has no executable".into(),
        ));
    }
    Ok(())
}

/// Replaces the app bundle at `bundle` with a verified archive: extracted next to it (same volume), checked, then
/// moved into place with the previous bundle kept until the move succeeded (restored if it did not).
pub fn install_app_bundle(
    archive: &Path,
    bundle: &Path,
    expected_version: &str,
) -> Result<(), AppUpdateError> {
    let parent = bundle
        .parent()
        .ok_or_else(|| AppUpdateError::Install("no folder for the app".into()))?;
    let name = bundle
        .file_name()
        .ok_or_else(|| AppUpdateError::Install("no app name".into()))?
        .to_string_lossy()
        .into_owned();
    let staging = parent.join(format!(".{name}.update-new"));
    let previous = parent.join(format!(".{name}.update-previous"));
    for p in [&staging, &previous] {
        if p.exists() {
            std::fs::remove_dir_all(p)?;
        }
    }
    let result = (|| {
        extract_app_archive(archive, &staging)?;
        check_staged_bundle(&staging, expected_version)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(bundle, &previous).map_err(|e| {
            if e.kind() == io::ErrorKind::PermissionDenied {
                AppUpdateError::Install(
                    "no permission to replace the app; install the new version by hand".into(),
                )
            } else {
                AppUpdateError::from(e)
            }
        })?;
        if let Err(e) = std::fs::rename(&staging, bundle) {
            let _ = std::fs::rename(&previous, bundle);
            return Err(AppUpdateError::from(e));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(&previous);
    }
    result
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;

#[cfg(feature = "testing")]
#[path = "app_testing.rs"]
pub mod testing;
