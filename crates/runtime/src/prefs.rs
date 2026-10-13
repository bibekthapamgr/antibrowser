//! Per-profile browser settings written into Chromium's own `Default/Preferences` file.
//!
//! Applied only while the profile is stopped and its manager lock is held, immediately before launch:
//!  - display name (Chromium's profile menu shows it) and optional client colour (`browser.theme.user_color`);
//!  - download folder;
//!  - camera / microphone / location defaults (ask = Chromium default, block = 2, allow = 1);
//!  - privacy (milestone 05): WebRTC IP handling, third-party cookies, Do Not Track, page languages, default text
//!    size, and network prediction (pre-resolving/pre-connecting) switched off for proxied profiles.
//!
//! A setting returned to the browser default is removed from the file rather than written with a value.
//!
//! Start URLs are NOT written here: Chromium protects its startup-page preferences with a MAC ("Secure
//! Preferences") and resets externally edited values, so start URLs are passed on the command line instead.
//!
//! The file is replaced atomically (write temporary file, then rename). An unreadable Preferences file is treated as
//! possible corruption: it is left untouched and reported, so the recovery flow can preserve it as evidence.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MAX_PREFS_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDefault {
    Ask,
    Block,
    Allow,
}

impl PermissionDefault {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Block => "block",
            Self::Allow => "allow",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ask" => Self::Ask,
            "block" => Self::Block,
            "allow" => Self::Allow,
            _ => return None,
        })
    }
    /// Chromium content-setting value, or `None` for "use the browser default (ask)".
    fn content_setting(self) -> Option<i64> {
        match self {
            Self::Ask => None,
            Self::Allow => Some(1),
            Self::Block => Some(2),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserPrefs {
    pub display_name: String,
    /// `#rrggbb`
    pub colour: Option<String>,
    pub download_dir: Option<PathBuf>,
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
    pub privacy: PrivacyPrefs,
}

/// Privacy preferences; `Default` leaves every one at the browser's default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PrivacyPrefs {
    /// `webrtc.ip_handling_policy` value.
    pub webrtc_policy: Option<&'static str>,
    pub block_third_party_cookies: bool,
    pub do_not_track: bool,
    /// `intl.accept_languages`, e.g. `de-DE,de`.
    pub accept_languages: Option<String>,
    /// (default, fixed-width) font sizes.
    pub font_sizes: Option<(u32, u32)>,
    pub disable_network_prediction: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PrefsError {
    #[error("the profile's browser settings file is unreadable")]
    Unreadable,
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
}

pub fn preferences_path(user_data: &Path) -> PathBuf {
    user_data.join("Default").join("Preferences")
}

fn read_json(path: &Path) -> Result<Option<Map<String, Value>>, PrefsError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(m) if !m.is_file() || m.len() > MAX_PREFS_BYTES => return Err(PrefsError::Unreadable),
        Ok(_) => {}
    }
    let bytes = fs::read(path)?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        _ => Err(PrefsError::Unreadable),
    }
}

/// Checks that Chromium's settings files parse. Run before launch so corruption is detected before Chromium
/// silently resets them.
pub fn check_readable(user_data: &Path) -> Result<(), PrefsError> {
    read_json(&preferences_path(user_data))?;
    read_json(&user_data.join("Local State"))?;
    Ok(())
}

fn set_path(root: &mut Map<String, Value>, path: &[&str], value: Option<Value>) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cur = root;
    for p in parents {
        let entry = cur.entry((*p).to_owned()).or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        let Some(next) = entry.as_object_mut() else {
            return;
        };
        cur = next;
    }
    match value {
        Some(v) => {
            cur.insert((*last).to_owned(), v);
        }
        None => {
            cur.remove(*last);
        }
    }
}

/// Chromium stores colours as a signed 32-bit ARGB integer.
fn argb(colour: &str) -> Option<i64> {
    let hex = colour.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let rgb = u32::from_str_radix(hex, 16).ok()?;
    Some(i64::from((0xFF00_0000 | rgb) as i32))
}

pub fn apply(user_data: &Path, prefs: &BrowserPrefs) -> Result<(), PrefsError> {
    let path = preferences_path(user_data);
    let mut root = read_json(&path)?.unwrap_or_default();

    set_path(
        &mut root,
        &["profile", "name"],
        Some(json!(prefs.display_name)),
    );
    set_path(
        &mut root,
        &["browser", "theme", "user_color"],
        prefs.colour.as_deref().and_then(argb).map(Value::from),
    );
    let downloads = prefs
        .download_dir
        .as_ref()
        .map(|d| json!(d.to_string_lossy()));
    set_path(
        &mut root,
        &["download", "default_directory"],
        downloads.clone(),
    );
    set_path(&mut root, &["savefile", "default_directory"], downloads);
    for (key, value) in [
        ("media_stream_camera", prefs.camera),
        ("media_stream_mic", prefs.microphone),
        ("geolocation", prefs.location),
    ] {
        set_path(
            &mut root,
            &["profile", "default_content_setting_values", key],
            value.content_setting().map(Value::from),
        );
    }

    let p = &prefs.privacy;
    set_path(
        &mut root,
        &["webrtc", "ip_handling_policy"],
        p.webrtc_policy.map(Value::from),
    );
    set_path(
        &mut root,
        &["profile", "cookie_controls_mode"],
        p.block_third_party_cookies.then(|| json!(1)),
    );
    set_path(
        &mut root,
        &["profile", "block_third_party_cookies"],
        p.block_third_party_cookies.then_some(json!(true)),
    );
    set_path(
        &mut root,
        &["enable_do_not_track"],
        p.do_not_track.then_some(json!(true)),
    );
    set_path(
        &mut root,
        &["intl", "accept_languages"],
        p.accept_languages.as_deref().map(Value::from),
    );
    set_path(
        &mut root,
        &["webkit", "webprefs", "default_font_size"],
        p.font_sizes.map(|(d, _)| json!(d)),
    );
    set_path(
        &mut root,
        &["webkit", "webprefs", "default_fixed_font_size"],
        p.font_sizes.map(|(_, f)| json!(f)),
    );
    set_path(
        &mut root,
        &["net", "network_prediction_options"],
        p.disable_network_prediction.then(|| json!(2)),
    );

    let dir = path.parent().ok_or(PrefsError::Unreadable)?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join("Preferences.pb-tmp");
    let bytes = serde_json::to_vec(&Value::Object(root)).map_err(io::Error::other)?;
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// How the last browser session for the profile ended, according to Chromium itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitRecord {
    pub exit_type: String,
    pub clean: bool,
}

/// Reads `profile.exit_type` ("Normal", "SessionEnded" or "Crashed"). Chromium sets "Crashed" at startup and
/// replaces it during an orderly shutdown, so a hard kill or crash leaves "Crashed" behind.
pub fn exit_record(user_data: &Path) -> Option<ExitRecord> {
    let root = read_json(&preferences_path(user_data)).ok()??;
    let exit_type = root.get("profile")?.get("exit_type")?.as_str()?.to_owned();
    let clean = matches!(exit_type.as_str(), "Normal" | "SessionEnded");
    Some(ExitRecord { exit_type, clean })
}

/// The browser version that last opened this profile, from Chromium's `Last Version` file.
pub fn last_version(user_data: &Path) -> Option<String> {
    let text = fs::read_to_string(user_data.join("Last Version")).ok()?;
    let v = text.trim();
    (!v.is_empty() && v.len() <= 32 && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .then(|| v.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs() -> BrowserPrefs {
        BrowserPrefs {
            display_name: "Shop admin · Client North".into(),
            colour: Some("#7c3aed".into()),
            download_dir: Some(PathBuf::from("/downloads/north")),
            camera: PermissionDefault::Block,
            microphone: PermissionDefault::Allow,
            location: PermissionDefault::Ask,
            privacy: PrivacyPrefs::default(),
        }
    }

    #[test]
    fn privacy_preferences_are_written_and_removed_again() -> Result<(), PrefsError> {
        let dir = tempfile::tempdir()?;
        let mut p = prefs();
        p.privacy = PrivacyPrefs {
            webrtc_policy: Some("disable_non_proxied_udp"),
            block_third_party_cookies: true,
            do_not_track: true,
            accept_languages: Some("de-DE,de".into()),
            font_sizes: Some((20, 16)),
            disable_network_prediction: true,
        };
        apply(dir.path(), &p)?;
        let read = || -> Result<Value, PrefsError> {
            serde_json::from_slice(&fs::read(preferences_path(dir.path()))?)
                .map_err(|_| PrefsError::Unreadable)
        };
        let v = read()?;
        assert_eq!(v["webrtc"]["ip_handling_policy"], "disable_non_proxied_udp");
        assert_eq!(v["profile"]["cookie_controls_mode"], 1);
        assert_eq!(v["enable_do_not_track"], true);
        assert_eq!(v["intl"]["accept_languages"], "de-DE,de");
        assert_eq!(v["webkit"]["webprefs"]["default_font_size"], 20);
        assert_eq!(v["net"]["network_prediction_options"], 2);
        p.privacy = PrivacyPrefs::default();
        apply(dir.path(), &p)?;
        let v = read()?;
        assert!(v["webrtc"].get("ip_handling_policy").is_none());
        assert!(v["profile"].get("cookie_controls_mode").is_none());
        assert!(v.get("enable_do_not_track").is_none());
        assert!(v["intl"].get("accept_languages").is_none());
        assert!(v["webkit"]["webprefs"].get("default_font_size").is_none());
        assert!(v["net"].get("network_prediction_options").is_none());
        Ok(())
    }

    #[test]
    fn writes_a_fresh_preferences_file() -> Result<(), PrefsError> {
        let dir = tempfile::tempdir()?;
        apply(dir.path(), &prefs())?;
        let v: Value = serde_json::from_slice(&fs::read(preferences_path(dir.path()))?)
            .map_err(|_| PrefsError::Unreadable)?;
        assert_eq!(v["profile"]["name"], "Shop admin · Client North");
        assert_eq!(v["download"]["default_directory"], "/downloads/north");
        let cs = &v["profile"]["default_content_setting_values"];
        assert_eq!(cs["media_stream_camera"], 2);
        assert_eq!(cs["media_stream_mic"], 1);
        assert!(cs.get("geolocation").is_none(), "ask = browser default");
        assert_eq!(
            v["browser"]["theme"]["user_color"],
            i64::from(0xFF7C_3AEDu32 as i32)
        );
        Ok(())
    }

    #[test]
    fn preserves_unrelated_browser_state_and_clears_removed_settings() -> Result<(), PrefsError> {
        let dir = tempfile::tempdir()?;
        let path = preferences_path(dir.path());
        fs::create_dir_all(path.parent().ok_or(PrefsError::Unreadable)?)?;
        fs::write(
            &path,
            r#"{"profile":{"exit_type":"Normal","default_content_setting_values":{"geolocation":2,"notifications":2}},"session":{"restore_on_startup":1}}"#,
        )?;
        let mut p = prefs();
        p.download_dir = None;
        p.colour = None;
        apply(dir.path(), &p)?;
        let v: Value =
            serde_json::from_slice(&fs::read(&path)?).map_err(|_| PrefsError::Unreadable)?;
        assert_eq!(v["session"]["restore_on_startup"], 1, "untouched");
        assert_eq!(v["profile"]["exit_type"], "Normal", "untouched");
        assert_eq!(
            v["profile"]["default_content_setting_values"]["notifications"],
            2
        );
        assert!(
            v["profile"]["default_content_setting_values"]
                .get("geolocation")
                .is_none()
        );
        assert!(v["download"].get("default_directory").is_none());
        assert!(v["browser"]["theme"].get("user_color").is_none());
        assert!(!path.with_file_name("Preferences.pb-tmp").exists());
        Ok(())
    }

    #[test]
    fn corrupt_files_are_reported_and_left_untouched() -> Result<(), PrefsError> {
        let dir = tempfile::tempdir()?;
        let path = preferences_path(dir.path());
        fs::create_dir_all(path.parent().ok_or(PrefsError::Unreadable)?)?;
        fs::write(&path, b"{\"profile\": {truncated")?;
        assert!(matches!(
            apply(dir.path(), &prefs()),
            Err(PrefsError::Unreadable)
        ));
        assert!(matches!(
            check_readable(dir.path()),
            Err(PrefsError::Unreadable)
        ));
        assert_eq!(fs::read(&path)?, b"{\"profile\": {truncated");
        Ok(())
    }

    #[test]
    fn reads_exit_record_and_last_version() -> Result<(), PrefsError> {
        let dir = tempfile::tempdir()?;
        assert_eq!(exit_record(dir.path()), None);
        let path = preferences_path(dir.path());
        fs::create_dir_all(path.parent().ok_or(PrefsError::Unreadable)?)?;
        fs::write(&path, r#"{"profile":{"exit_type":"Crashed"}}"#)?;
        assert_eq!(
            exit_record(dir.path()),
            Some(ExitRecord {
                exit_type: "Crashed".into(),
                clean: false
            })
        );
        fs::write(&path, r#"{"profile":{"exit_type":"SessionEnded"}}"#)?;
        assert!(exit_record(dir.path()).is_some_and(|r| r.clean));
        fs::write(dir.path().join("Last Version"), "155.0.8059.39\n")?;
        assert_eq!(last_version(dir.path()).as_deref(), Some("155.0.8059.39"));
        fs::write(dir.path().join("Last Version"), "../../x")?;
        assert_eq!(last_version(dir.path()), None);
        Ok(())
    }
}
