//! Browser extensions installed in a profile, read from Chromium's own files, and the organization policy that
//! judges them (milestone 09, ADR-0016).
//!
//! Reading is passive: `Default/Preferences` and `Default/Secure Preferences` (`extensions.settings`) say which
//! extensions are installed, from where and whether they are enabled; each extension's `manifest.json` gives its name,
//! version and declared permissions. Nothing is installed, removed, loaded or re-signed here: installation stays with
//! Chromium's supported paths (the Chrome Web Store, or the user's own "Load unpacked" in developer mode), and
//! Chromium's signature and integrity checks are never bypassed. Each profile has its own user-data directory, so
//! extension files and extension data are never shared between profiles.
//!
//! The policy rules mirror `packages/contracts/src/agency.ts` exactly; both run the same test vectors
//! (`packages/contracts/fixtures/extension-policy-cases.json`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

const MAX_PREFS_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const MAX_EXTENSIONS: usize = 200;
pub const MAX_PERMISSIONS: usize = 100;
const MAX_NAME_CHARS: usize = 120;
const MAX_VERSION_CHARS: usize = 32;
const MAX_PERMISSION_CHARS: usize = 200;
const WEB_STORE_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";
/// Chromium's `Extension::FROM_WEBSTORE` creation flag.
const FROM_WEBSTORE_FLAG: i64 = 1 << 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionSource {
    /// Installed from the Chrome Web Store.
    WebStore,
    /// Installed by an enterprise policy on this computer.
    Policy,
    /// Installed by another program on this computer (external preferences or registry).
    External,
    /// Loaded from a folder in developer mode (no Web Store signature).
    Unpacked,
    Other,
}

impl ExtensionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WebStore => "web_store",
            Self::Policy => "policy",
            Self::External => "external",
            Self::Unpacked => "unpacked",
            Self::Other => "other",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "web_store" => Self::WebStore,
            "policy" => Self::Policy,
            "external" => Self::External,
            "unpacked" => Self::Unpacked,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: ExtensionSource,
    pub enabled: bool,
    /// Declared and granted API permissions and site access, sorted, without duplicates.
    pub permissions: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExtensionsError {
    #[error("the profile's browser settings file is unreadable")]
    Unreadable,
}

pub fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)
        .ok()?
        .take(cap)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

/// `Ok(None)`: the file does not exist. `Err`: it exists but is not a JSON object (or is too large).
fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, ExtensionsError> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(None);
    }
    let bytes = read_capped(path, MAX_PREFS_BYTES).ok_or(ExtensionsError::Unreadable)?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => Ok(Some(m)),
        _ => Err(ExtensionsError::Unreadable),
    }
}

fn settings_of(root: &Map<String, Value>) -> Map<String, Value> {
    root.get("extensions")
        .and_then(|e| e.get("settings"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn clean(text: &str, max: usize) -> String {
    let mut out = String::new();
    for word in text
        .chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .collect::<String>()
        .split_whitespace()
    {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.chars().take(max).collect()
}

/// Bidirectional overrides and other invisible formatting characters.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// The extension's folder: relative `<id>/<version>` paths live under `Default/Extensions`; unpacked extensions
/// keep the absolute folder they were loaded from. A relative path that tries to leave `Extensions` is ignored.
fn extension_dir(user_data: &Path, path: &str) -> Option<std::path::PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() {
        return Some(p.to_path_buf());
    }
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(user_data.join("Default").join("Extensions").join(p))
}

/// `__MSG_name__` resolved from `_locales/<default_locale>/messages.json` (keys are case-insensitive).
fn localized(dir: &Path, manifest: &Map<String, Value>, text: &str) -> Option<String> {
    let key = text.strip_prefix("__MSG_")?.strip_suffix("__")?;
    let locale = manifest.get("default_locale")?.as_str()?;
    if locale.is_empty()
        || !locale
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let bytes = read_capped(
        &dir.join("_locales").join(locale).join("messages.json"),
        MAX_MANIFEST_BYTES,
    )?;
    let messages: Map<String, Value> = serde_json::from_slice(&bytes).ok()?;
    messages
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| v.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn strings(v: Option<&Value>) -> impl Iterator<Item = &str> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn source_of(
    location: i64,
    entry: &Map<String, Value>,
    manifest: &Map<String, Value>,
) -> ExtensionSource {
    match location {
        1 => {
            let flags = entry
                .get("creation_flags")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let from_store = flags & FROM_WEBSTORE_FLAG != 0
                || entry.get("from_webstore").and_then(Value::as_bool) == Some(true)
                || manifest.get("update_url").and_then(Value::as_str) == Some(WEB_STORE_UPDATE_URL);
            if from_store {
                ExtensionSource::WebStore
            } else {
                ExtensionSource::Other
            }
        }
        2 | 3 | 6 => ExtensionSource::External,
        7 | 9 => ExtensionSource::Policy,
        4 | 8 => ExtensionSource::Unpacked,
        _ => ExtensionSource::Other,
    }
}

fn enabled(entry: &Map<String, Value>) -> bool {
    let reasons_clear = match entry.get("disable_reasons") {
        None | Some(Value::Null) => true,
        Some(Value::Array(a)) => a.is_empty(),
        Some(Value::Number(n)) => n.as_i64() == Some(0),
        Some(_) => false,
    };
    // Older Chromium versions record `state` (0 disabled, 1 enabled).
    reasons_clear && entry.get("state").and_then(Value::as_i64) != Some(0)
}

/// Extensions installed in the profile at `user_data`, sorted by id. Chromium's own built-in (component) extensions
/// are left out. A profile that was never opened has none.
pub fn read_installed(user_data: &Path) -> Result<Vec<InstalledExtension>, ExtensionsError> {
    let default = user_data.join("Default");
    let regular = read_object(&default.join("Preferences"))?.unwrap_or_default();
    // Protected preferences can be unreadable without the profile being damaged: then only the regular file counts.
    let secure = read_object(&default.join("Secure Preferences"))
        .ok()
        .flatten()
        .unwrap_or_default();
    let mut settings = settings_of(&secure);
    for (id, entry) in settings_of(&regular) {
        match (settings.get_mut(&id), entry) {
            (Some(Value::Object(existing)), Value::Object(more)) => {
                for (k, v) in more {
                    existing.insert(k, v);
                }
            }
            (_, entry) => {
                settings.insert(id, entry);
            }
        }
    }
    let mut out = vec![];
    for (id, entry) in settings {
        if out.len() >= MAX_EXTENSIONS {
            break;
        }
        let Value::Object(entry) = entry else {
            continue;
        };
        if !valid_extension_id(&id) {
            continue;
        }
        let location = entry.get("location").and_then(Value::as_i64).unwrap_or(0);
        if location == 5 || location == 10 {
            continue; // component extensions are part of the browser itself
        }
        let dir = entry
            .get("path")
            .and_then(Value::as_str)
            .and_then(|p| extension_dir(user_data, p));
        let manifest: Map<String, Value> = dir
            .as_ref()
            .and_then(|d| read_capped(&d.join("manifest.json"), MAX_MANIFEST_BYTES))
            .and_then(|b| serde_json::from_slice(&b).ok())
            .or_else(|| entry.get("manifest").and_then(Value::as_object).cloned())
            .unwrap_or_default();
        let raw_name = manifest.get("name").and_then(Value::as_str).unwrap_or("");
        let name = dir
            .as_ref()
            .and_then(|d| localized(d, &manifest, raw_name))
            .unwrap_or_else(|| raw_name.to_owned());
        let name = match clean(&name, MAX_NAME_CHARS) {
            n if n.is_empty() || n.starts_with("__MSG_") => id.clone(),
            n => n,
        };
        let mut permissions = BTreeSet::new();
        let mut add = |p: &str| {
            let p = clean(p, MAX_PERMISSION_CHARS);
            if !p.is_empty() {
                permissions.insert(p);
            }
        };
        strings(manifest.get("permissions")).for_each(&mut add);
        strings(manifest.get("host_permissions")).for_each(&mut add);
        for script in manifest
            .get("content_scripts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            strings(script.get("matches")).for_each(&mut add);
        }
        // What Chromium actually granted (also covers permissions accepted later at run time).
        if let Some(active) = entry.get("active_permissions") {
            for key in ["api", "explicit_host", "scriptable_host"] {
                strings(active.get(key)).for_each(&mut add);
            }
        }
        let version = manifest
            .get("version")
            .and_then(Value::as_str)
            .map(|v| clean(v, MAX_VERSION_CHARS))
            .unwrap_or_default();
        out.push(InstalledExtension {
            source: source_of(location, &entry, &manifest),
            enabled: enabled(&entry),
            id,
            name,
            version,
            permissions: permissions.into_iter().take(MAX_PERMISSIONS).collect(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

// ----------------------------------------------------------------------------- policy

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyMode {
    Off,
    Warn,
    Enforce,
}

impl PolicyMode {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "off" => Self::Off,
            "warn" => Self::Warn,
            "enforce" => Self::Enforce,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Warn => "warn",
            Self::Enforce => "enforce",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionRule {
    pub extension_id: String,
    #[serde(default)]
    pub name: String,
    /// `allowed` or `blocked`.
    pub decision: String,
    /// `web_store` or `any`.
    pub source: String,
    pub approved_version_range: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Verdict {
    Approved,
    Blocked,
    NotListed,
    SourceNotAllowed,
    VersionNotApproved { version: String },
    PermissionsNeedReview { permissions: Vec<String> },
}

impl Verdict {
    pub fn is_approved(&self) -> bool {
        matches!(self, Self::Approved)
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Blocked => "blocked",
            Self::NotListed => "not_listed",
            Self::SourceNotAllowed => "source_not_allowed",
            Self::VersionNotApproved { .. } => "version_not_approved",
            Self::PermissionsNeedReview { .. } => "permissions_need_review",
        }
    }
}

/// Permissions that let an extension read or change what people do on websites, or reach outside the browser
/// (same list as `SENSITIVE_EXTENSION_PERMISSIONS` in the contracts).
pub const SENSITIVE_PERMISSIONS: &[&str] = &[
    "<all_urls>",
    "activeTab",
    "bookmarks",
    "browsingData",
    "clipboardRead",
    "contentSettings",
    "cookies",
    "debugger",
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "desktopCapture",
    "downloads",
    "history",
    "identity",
    "management",
    "nativeMessaging",
    "pageCapture",
    "privacy",
    "proxy",
    "scripting",
    "tabCapture",
    "tabs",
    "topSites",
    "webNavigation",
    "webRequest",
    "webRequestBlocking",
];

/// A listed API, or a host pattern for every site (`*://*/*`, `https://*/*`, `file://*/*`, ...).
pub fn is_sensitive_permission(p: &str) -> bool {
    if SENSITIVE_PERMISSIONS.contains(&p) {
        return true;
    }
    let Some((scheme, rest)) = p.split_once("://") else {
        return false;
    };
    matches!(scheme, "*" | "http" | "https" | "file")
        && matches!(rest, "*/" | "*/*" | "*.*/" | "*.*/*")
}

fn number(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 9 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 1 to 4 dot-separated numbers of 1 to 9 digits.
fn parse_version(v: &str, max_parts: usize) -> Option<Vec<u64>> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.is_empty() || parts.len() > max_parts {
        return None;
    }
    parts.into_iter().map(number).collect()
}

fn compare(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for i in 0..4 {
        let o = a
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&b.get(i).copied().unwrap_or(0));
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    std::cmp::Ordering::Equal
}

enum RangePart {
    Prefix(Vec<u64>),
    Compare(&'static str, Vec<u64>),
}

fn parse_part(part: &str) -> Option<RangePart> {
    if let Some(prefix) = part.strip_suffix(".*") {
        return parse_version(prefix, 3).map(RangePart::Prefix);
    }
    for op in [">=", "<=", ">", "<", "="] {
        if let Some(v) = part.strip_prefix(op) {
            return parse_version(v, 4).map(|v| RangePart::Compare(op, v));
        }
    }
    parse_version(part, 4).map(|v| RangePart::Compare("=", v))
}

pub fn valid_version_range(range: &str) -> bool {
    let parts: Vec<&str> = range.split_whitespace().collect();
    (1..=4).contains(&parts.len()) && parts.iter().all(|p| parse_part(p).is_some())
}

/// Whether `version` is inside `range` (`None`: any version). An invalid range matches nothing.
pub fn version_in_range(version: &str, range: Option<&str>) -> bool {
    let Some(range) = range else {
        return true;
    };
    let Some(v) = parse_version(version, 4) else {
        return false;
    };
    let parts: Vec<&str> = range.split_whitespace().collect();
    if parts.is_empty() || parts.len() > 4 {
        return false;
    }
    parts.iter().all(|part| match parse_part(part) {
        Some(RangePart::Prefix(prefix)) => {
            prefix.iter().enumerate().all(|(i, n)| v.get(i) == Some(n))
        }
        Some(RangePart::Compare(op, target)) => {
            let c = compare(&v, &target);
            match op {
                ">=" => c.is_ge(),
                "<=" => c.is_le(),
                ">" => c.is_gt(),
                "<" => c.is_lt(),
                _ => c.is_eq(),
            }
        }
        None => false,
    })
}

/// How the policy judges one installed extension.
pub fn judge(
    rules: &[ExtensionRule],
    id: &str,
    version: &str,
    source: ExtensionSource,
    permissions: &[String],
) -> Verdict {
    let Some(rule) = rules.iter().find(|r| r.extension_id == id) else {
        return Verdict::NotListed;
    };
    if rule.decision == "blocked" {
        return Verdict::Blocked;
    }
    if rule.source == "web_store" && source != ExtensionSource::WebStore {
        return Verdict::SourceNotAllowed;
    }
    if !version_in_range(version, rule.approved_version_range.as_deref()) {
        return Verdict::VersionNotApproved {
            version: version.to_owned(),
        };
    }
    let extra: Vec<String> = permissions
        .iter()
        .filter(|p| is_sensitive_permission(p) && !rule.permissions.contains(p))
        .cloned()
        .collect();
    if extra.is_empty() {
        Verdict::Approved
    } else {
        Verdict::PermissionsNeedReview { permissions: extra }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CASES: &str =
        include_str!("../../../packages/contracts/fixtures/extension-policy-cases.json");

    #[test]
    fn shared_policy_vectors() {
        let cases: Value = serde_json::from_str(CASES).unwrap_or(Value::Null);
        let list = |k: &str| cases[k].as_array().cloned().unwrap_or_default();
        assert!(list("versions").len() > 10);
        for c in list("versions") {
            let got = version_in_range(c["version"].as_str().unwrap_or(""), c["range"].as_str());
            assert_eq!(got, c["in"].as_bool() == Some(true), "{c}");
        }
        for c in list("ranges") {
            let got = valid_version_range(c["range"].as_str().unwrap_or(""));
            assert_eq!(got, c["valid"].as_bool() == Some(true), "{c}");
        }
        for c in list("sensitive") {
            let got = is_sensitive_permission(c["permission"].as_str().unwrap_or(""));
            assert_eq!(got, c["sensitive"].as_bool() == Some(true), "{c}");
        }
        for c in list("judgements") {
            let rules: Vec<ExtensionRule> =
                serde_json::from_value(c["rules"].clone()).unwrap_or_default();
            let item = &c["item"];
            let permissions: Vec<String> =
                serde_json::from_value(item["permissions"].clone()).unwrap_or_default();
            let source = ExtensionSource::parse(item["source"].as_str().unwrap_or(""))
                .unwrap_or(ExtensionSource::Other);
            let got = judge(
                &rules,
                item["id"].as_str().unwrap_or(""),
                item["version"].as_str().unwrap_or(""),
                source,
                &permissions,
            );
            assert_eq!(
                serde_json::to_value(&got).unwrap_or(Value::Null),
                c["verdict"],
                "{}",
                c["name"]
            );
        }
    }

    fn write(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, serde_json::to_vec(value).unwrap_or_default());
    }

    /// A profile laid out like Chromium 141 leaves it (entries recorded from a real profile).
    #[test]
    fn reads_installed_extensions_like_chromium_records_them() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ud = dir.path().join("user-data");
        let unpacked = dir.path().join("my-tool");
        let store_id = "c".repeat(32);
        let unpacked_id = "d".repeat(32);
        let policy_id = "e".repeat(32);
        write(
            &ud.join("Default/Extensions")
                .join(&store_id)
                .join("4.2.0_0/manifest.json"),
            &json!({"manifest_version": 3, "name": "__MSG_appName__", "default_locale": "en", "version": "4.2.0",
                    "update_url": WEB_STORE_UPDATE_URL, "permissions": ["storage", "cookies"],
                    "host_permissions": ["<all_urls>"],
                    "content_scripts": [{"matches": ["https://*.shop.example/*"], "js": ["c.js"]}]}),
        );
        write(
            &ud.join("Default/Extensions")
                .join(&store_id)
                .join("4.2.0_0/_locales/en/messages.json"),
            &json!({"APPNAME": {"message": "Grammar\u{202e} helper"}}),
        );
        write(
            &unpacked.join("manifest.json"),
            &json!({"name": "My tool", "version": "0.1", "permissions": ["debugger"]}),
        );
        write(
            &ud.join("Default/Preferences"),
            &json!({"extensions": {"settings": {
                // Built into the browser: never listed.
                "ahfgeienlihckogmohjhadlkjgocpleb": {"location": 5, "path": "/opt/chromium/resources/web_store",
                    "manifest": {"name": "Web Store", "version": "0.2"}},
                store_id.clone(): {"location": 1, "creation_flags": 9, "disable_reasons": [],
                    "path": format!("{store_id}/4.2.0_0"),
                    "active_permissions": {"api": ["cookies", "storage"], "explicit_host": ["<all_urls>"],
                                           "manifest_permissions": [], "scriptable_host": ["https://*.shop.example/*"]}},
                unpacked_id.clone(): {"location": 4, "creation_flags": 38, "disable_reasons": [1],
                    "path": unpacked.to_string_lossy()},
                "not-an-id": {"location": 1},
                "ffffffffffffffffffffffffffffffff": {"location": 1, "path": "../../escape"},
            }}}),
        );
        write(
            &ud.join("Default/Secure Preferences"),
            &json!({"extensions": {"settings": {
                policy_id.clone(): {"location": 9, "manifest": {"name": "Agency SSO", "version": "2.0.1",
                                                                 "permissions": ["identity"]}}
            }}}),
        );
        let got = read_installed(&ud).unwrap_or_else(|e| panic!("{e}"));
        let ids: Vec<&str> = got.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                store_id.as_str(),
                unpacked_id.as_str(),
                policy_id.as_str(),
                "ffffffffffffffffffffffffffffffff"
            ]
        );
        assert_eq!(
            got[0],
            InstalledExtension {
                id: store_id,
                name: "Grammar helper".into(),
                version: "4.2.0".into(),
                source: ExtensionSource::WebStore,
                enabled: true,
                permissions: vec![
                    "<all_urls>".into(),
                    "cookies".into(),
                    "https://*.shop.example/*".into(),
                    "storage".into()
                ],
            }
        );
        assert_eq!(
            (got[1].source, got[1].enabled, got[1].name.as_str()),
            (ExtensionSource::Unpacked, false, "My tool")
        );
        assert_eq!(got[1].permissions, ["debugger"]);
        assert_eq!(
            (got[2].source, got[2].version.as_str()),
            (ExtensionSource::Policy, "2.0.1")
        );
        // A path outside the Extensions folder is never read: the entry is listed by id only.
        assert_eq!(
            (got[3].name.as_str(), got[3].version.as_str()),
            ("ffffffffffffffffffffffffffffffff", "")
        );
    }

    #[test]
    fn a_fresh_profile_has_none_and_a_damaged_file_is_reported() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(read_installed(dir.path()).map(|v| v.len()).ok(), Some(0));
        let _ = fs::create_dir_all(dir.path().join("Default"));
        let _ = fs::write(dir.path().join("Default/Preferences"), b"{not json");
        assert!(read_installed(dir.path()).is_err());
    }
}
