//! Per-profile browser settings written into Chromium's own `Default/Preferences` file.
//!
//! Applied only while the profile is stopped and its manager lock is held, immediately before launch:
//!  - display name (Chromium's profile menu shows it) and optional client colour (`browser.theme.user_color`);
//!  - download folder;
//!  - camera / microphone / location defaults (ask = Chromium default, block = 2, allow = 1).
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
        }
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
