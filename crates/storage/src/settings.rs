//! Allow-listed settings. Unknown keys are rejected; every value is validated against its key's schema.
//! Stored as (key, version, value_json). `version` supports optimistic concurrency like the server contracts.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKind {
    Enum(&'static [&'static str]),
    Bool,
    /// Absolute filesystem path chosen through a native dialog; never settable from the UI directly.
    Path,
    /// A workspace id (existence checked by the caller).
    WorkspaceRef,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct SettingSpec {
    pub key: &'static str,
    pub kind: SettingKind,
    /// May the manager UI set this through `update_setting`? (Paths are set only via dedicated native commands.)
    pub ui_settable: bool,
    #[serde(skip)]
    pub default: fn() -> Value,
}

pub const THEME: &str = "appearance.theme";
pub const CLOSE_BEHAVIOR: &str = "manager.close_behavior";
pub const CRASH_REPORTS: &str = "privacy.crash_reports";
pub const DOWNLOAD_DIR: &str = "downloads.directory";
pub const ACTIVE_WORKSPACE: &str = "workspace.active";

pub const SETTINGS: &[SettingSpec] = &[
    SettingSpec {
        key: THEME,
        kind: SettingKind::Enum(&["system", "light", "dark"]),
        ui_settable: true,
        default: || Value::from("system"),
    },
    SettingSpec {
        key: CLOSE_BEHAVIOR,
        kind: SettingKind::Enum(&["ask", "keep_running", "close_all"]),
        ui_settable: true,
        default: || Value::from("ask"),
    },
    SettingSpec {
        key: CRASH_REPORTS,
        kind: SettingKind::Bool,
        ui_settable: true,
        default: || Value::Bool(false), // opt-in only
    },
    SettingSpec {
        key: DOWNLOAD_DIR,
        kind: SettingKind::Path,
        ui_settable: false,
        default: || Value::Null,
    },
    SettingSpec {
        key: ACTIVE_WORKSPACE,
        kind: SettingKind::WorkspaceRef,
        ui_settable: true,
        default: || Value::Null,
    },
];

pub fn spec(key: &str) -> Option<&'static SettingSpec> {
    SETTINGS.iter().find(|s| s.key == key)
}

#[derive(Debug, PartialEq, Eq)]
pub enum SettingError {
    UnknownKey,
    NotUiSettable,
    InvalidValue,
}

/// Validates a value for a key. `from_ui` enforces the `ui_settable` flag.
pub fn validate(
    key: &str,
    value: &Value,
    from_ui: bool,
) -> Result<&'static SettingSpec, SettingError> {
    let spec = spec(key).ok_or(SettingError::UnknownKey)?;
    if from_ui && !spec.ui_settable {
        return Err(SettingError::NotUiSettable);
    }
    let ok = match (spec.kind, value) {
        (SettingKind::Enum(options), Value::String(s)) => options.contains(&s.as_str()),
        (SettingKind::Bool, Value::Bool(_)) => true,
        (SettingKind::Path, Value::Null) => true,
        (SettingKind::Path, Value::String(s)) => {
            s.len() <= 4096
                && !s.chars().any(char::is_control)
                && std::path::Path::new(s).is_absolute()
        }
        (SettingKind::WorkspaceRef, Value::Null) => true,
        (SettingKind::WorkspaceRef, Value::String(s)) => pb_runtime::WorkspaceId::parse(s).is_ok(),
        _ => false,
    };
    if ok {
        Ok(spec)
    } else {
        Err(SettingError::InvalidValue)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SettingValue {
    pub key: &'static str,
    pub value: Value,
    /// 0 = never written (default value).
    pub version: i64,
    pub ui_settable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allowlist_and_types() {
        assert_eq!(
            validate("appearance.theme", &json!("dark"), true).map(|s| s.key),
            Ok(THEME)
        );
        assert_eq!(
            validate("appearance.theme", &json!("neon"), true).err(),
            Some(SettingError::InvalidValue)
        );
        assert_eq!(
            validate("appearance.theme", &json!(1), true).err(),
            Some(SettingError::InvalidValue)
        );
        assert_eq!(
            validate("shell.command", &json!("rm -rf /"), true).err(),
            Some(SettingError::UnknownKey)
        );
        assert_eq!(
            validate(DOWNLOAD_DIR, &json!("/tmp"), true).err(),
            Some(SettingError::NotUiSettable)
        );
        // An absolute path on the host OS ("/tmp" is not absolute on Windows).
        let abs = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(validate(DOWNLOAD_DIR, &json!(abs), false).is_ok());
        assert_eq!(
            validate(DOWNLOAD_DIR, &json!("relative/dir"), false).err(),
            Some(SettingError::InvalidValue)
        );
        assert_eq!(
            validate(ACTIVE_WORKSPACE, &json!("../x"), true).err(),
            Some(SettingError::InvalidValue)
        );
        assert!(validate(CRASH_REPORTS, &json!(true), true).is_ok());
        assert_eq!(
            (spec(CRASH_REPORTS).map(|s| (s.default)())),
            Some(json!(false)),
            "crash reports are opt-in"
        );
    }
}
