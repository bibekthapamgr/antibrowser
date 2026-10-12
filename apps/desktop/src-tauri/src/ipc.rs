//! IPC error type and input limits shared by every command.
//!
//! Errors crossing to the webview carry a stable `code` and a fixed, user-safe `message`. They never contain
//! paths, SQL, OS error text or stack traces (those go to the local log only).

use pb_runtime::LaunchError;
use pb_storage::StoreError;
use pb_storage::settings::SettingError;
use serde::Serialize;

/// Hard limits applied before any work is done ("oversized request" acceptance test).
pub mod limits {
    pub const LABEL_CHARS: usize = 120;
    pub const WORKSPACE_NAME_CHARS: usize = 80;
    pub const NOTES_CHARS: usize = 2000;
    pub const QUERY_CHARS: usize = 200;
    pub const URL_BYTES: usize = 2048;
    pub const SETTING_VALUE_BYTES: usize = 4096;
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IpcError {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<i64>,
}

impl IpcError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            current_version: None,
        }
    }
}

pub const WRONG_CALLER: IpcError = IpcError::new(
    "WRONG_CALLER",
    "This action is only available in the manager window.",
);
pub const INVALID_LABEL: IpcError =
    IpcError::new("INVALID_LABEL", "Names must be 1-120 visible characters.");
pub const INVALID_WORKSPACE_NAME: IpcError = IpcError::new(
    "INVALID_WORKSPACE_NAME",
    "Workspace names must be 1-80 visible characters.",
);
pub const NOTES_TOO_LONG: IpcError =
    IpcError::new("NOTES_TOO_LONG", "Notes can be at most 2,000 characters.");
pub const QUERY_TOO_LONG: IpcError = IpcError::new("QUERY_TOO_LONG", "Search text is too long.");
pub const NO_WORKSPACE: IpcError = IpcError::new("NO_WORKSPACE", "Create a workspace first.");
pub const UNKNOWN_WORKSPACE: IpcError = IpcError::new(
    "UNKNOWN_WORKSPACE",
    "That workspace does not exist on this device.",
);
pub const NOT_RUNNING: IpcError = IpcError::new("NOT_RUNNING", "This profile is not open.");
pub const STORE_UNAVAILABLE: IpcError = IpcError::new(
    "STORE_UNAVAILABLE",
    "Local data could not be opened. Use the recovery options to continue.",
);
pub const DISALLOWED_URL: IpcError = IpcError::new(
    "DISALLOWED_URL",
    "Only https links to approved help sites can be opened.",
);
pub const INVALID_DIRECTORY: IpcError = IpcError::new(
    "INVALID_DIRECTORY",
    "Choose a folder you can write to, outside the app's own data folder.",
);
pub const INVALID_ARGUMENT: IpcError =
    IpcError::new("INVALID_ARGUMENT", "The request was not valid.");
pub const PROFILES_RUNNING: IpcError = IpcError::new(
    "PROFILES_RUNNING",
    "Close all open profiles before doing this.",
);
pub const CONFIRMATION_REQUIRED: IpcError = IpcError::new(
    "CONFIRMATION_REQUIRED",
    "Type DELETE to confirm removing all local data.",
);
pub const INTERNAL: IpcError = IpcError::new(
    "INTERNAL",
    "Something went wrong. Details are in the diagnostics.",
);

impl From<LaunchError> for IpcError {
    fn from(e: LaunchError) -> Self {
        let message = match e {
            LaunchError::UnknownProfile => "This profile does not exist on this device.",
            LaunchError::AlreadyRunning => "This profile is already open.",
            LaunchError::BrowserNotConfigured => "The browser runtime is not installed.",
            LaunchError::BadStartUrl => "Start address must begin with http:// or https://.",
            LaunchError::Layout(_) => "The profile folder failed a safety check.",
            LaunchError::Spawn(_) => "The browser could not be started.",
        };
        Self::new(e.code(), message)
    }
}

impl From<StoreError> for IpcError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => Self::new("NOT_FOUND", "That item no longer exists."),
            StoreError::VersionConflict { current } => Self {
                code: "VERSION_CONFLICT",
                message: "This was changed elsewhere. Reload and try again.",
                current_version: Some(current),
            },
            StoreError::Setting(SettingError::UnknownKey) => {
                Self::new("UNKNOWN_SETTING", "That setting does not exist.")
            }
            StoreError::Setting(SettingError::NotUiSettable) => Self::new(
                "SETTING_READ_ONLY",
                "That setting is changed through its own control.",
            ),
            StoreError::Setting(SettingError::InvalidValue) => Self::new(
                "INVALID_SETTING_VALUE",
                "That value is not allowed for this setting.",
            ),
            _ => Self::new(
                "LOCAL_STORE_ERROR",
                "Local profile data could not be read or written.",
            ),
        }
    }
}

/// Trims and validates a display label. Labels are never used to build paths.
pub fn clean_text(value: &str, max_chars: usize, err: IpcError) -> Result<String, IpcError> {
    if value.len() > max_chars * 4 {
        return Err(err); // reject oversized input before scanning it
    }
    let trimmed = value.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > max_chars || trimmed.chars().any(char::is_control) {
        return Err(err);
    }
    Ok(trimmed.to_owned())
}

/// Like `clean_text` but allows newlines/tabs and empty values (free-form notes).
pub fn clean_notes(value: &str) -> Result<String, IpcError> {
    if value.len() > limits::NOTES_CHARS * 4
        || value.chars().count() > limits::NOTES_CHARS
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(NOTES_TOO_LONG);
    }
    Ok(value.to_owned())
}
