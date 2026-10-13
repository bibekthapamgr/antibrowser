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
pub const NOTES_LOOK_SECRET: IpcError = IpcError::new(
    "NOTES_LOOK_SECRET",
    "These notes look like they contain a password, key or card number. Notes are not encrypted: keep secrets in a password manager.",
);
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

pub const UNKNOWN_PROFILE: IpcError = IpcError::new(
    "UNKNOWN_PROFILE",
    "This profile does not exist on this device.",
);
pub const PROFILE_BUSY: IpcError = IpcError::new(
    "PROFILE_BUSY",
    "This profile is busy (backup or recovery in progress). Try again in a moment.",
);
pub const PROFILE_STOPPING: IpcError = IpcError::new(
    "PROFILE_STOPPING",
    "This profile is still closing. Try again when it has closed.",
);
pub const PROFILE_STARTING: IpcError = IpcError::new(
    "PROFILE_STARTING",
    "This profile is still preparing to open. Try again in a moment.",
);
pub const PROFILE_IN_USE: IpcError = IpcError::new(
    "PROFILE_IN_USE",
    "Another browser program is using this profile's folder. Close it first.",
);
pub const PROFILE_DATA_UNREADABLE: IpcError = IpcError::new(
    "PROFILE_DATA_UNREADABLE",
    "This profile's browser data looks damaged. Use Recover to restore the last good copy.",
);
pub const PROFILE_NEWER_THAN_RUNTIME: IpcError = IpcError::new(
    "PROFILE_NEWER_THAN_RUNTIME",
    "This profile was last opened by a newer browser version. Install that version to open it.",
);
pub const NOT_RECOVERABLE: IpcError =
    IpcError::new("NOT_RECOVERABLE", "Close the profile before recovering it.");
pub const RUNTIME_NOT_INSTALLED: IpcError = IpcError::new(
    "RUNTIME_NOT_INSTALLED",
    "The browser is not installed yet. Install it from Downloads and updates.",
);
pub const RUNTIME_UNAVAILABLE: IpcError = IpcError::new(
    "RUNTIME_UNAVAILABLE",
    "This build has no verified browser list for this computer.",
);
pub const RUNTIME_NOT_IN_MANIFEST: IpcError = IpcError::new(
    "RUNTIME_NOT_IN_MANIFEST",
    "That browser version is not approved for this build.",
);
pub const INSTALL_IN_PROGRESS: IpcError = IpcError::new(
    "INSTALL_IN_PROGRESS",
    "A browser install is already in progress.",
);
pub const LOW_DISK_SPACE: IpcError = IpcError::new(
    "LOW_DISK_SPACE",
    "Not enough free disk space. Free some space and try again.",
);
pub const INVALID_COLOUR: IpcError =
    IpcError::new("INVALID_COLOUR", "Colour must look like #7c3aed.");
pub const INVALID_PERMISSION: IpcError = IpcError::new(
    "INVALID_PERMISSION",
    "Permission must be ask, block or allow.",
);
pub const NO_BACKUP: IpcError =
    IpcError::new("NO_BACKUP", "There is no backup of this profile yet.");

// ---------------------------------------------------------------------------------------- milestone 04
pub const INVALID_TAG: IpcError = IpcError::new(
    "INVALID_TAG",
    "Tags must be 1-40 visible characters (at most 20 per profile).",
);
pub const PROFILE_IN_TRASH: IpcError = IpcError::new(
    "PROFILE_IN_TRASH",
    "This profile is in the trash. Restore it first.",
);
pub const PROFILE_RUNNING: IpcError =
    IpcError::new("PROFILE_RUNNING", "This profile is open. Close it first.");
pub const NOT_IN_TRASH: IpcError = IpcError::new(
    "NOT_IN_TRASH",
    "Only profiles in the trash can be deleted permanently.",
);
pub const UNKNOWN_CLIENT: IpcError = IpcError::new(
    "UNKNOWN_CLIENT",
    "That client does not exist in this workspace.",
);
pub const UNKNOWN_TAG: IpcError =
    IpcError::new("UNKNOWN_TAG", "That tag does not exist in this workspace.");
pub const UNKNOWN_TEMPLATE: IpcError = IpcError::new(
    "UNKNOWN_TEMPLATE",
    "That template does not exist in this workspace.",
);
pub const DUPLICATE_NAME: IpcError = IpcError::new(
    "DUPLICATE_NAME",
    "That name is already used in this workspace.",
);
pub const INVALID_FILTER: IpcError = IpcError::new("INVALID_FILTER", "That filter is not valid.");
pub const CURSOR_STALE: IpcError = IpcError::new(
    "CURSOR_STALE",
    "The list changed its filter; load it again from the start.",
);
pub const SELECTION_TOO_LARGE: IpcError = IpcError::new(
    "SELECTION_TOO_LARGE",
    "Select at most 10,000 profiles at a time.",
);
pub const SELECTION_CHANGED: IpcError = IpcError::new(
    "SELECTION_CHANGED",
    "The matching profiles changed since you selected them. Check the selection and try again.",
);
pub const UNDO_EXPIRED: IpcError =
    IpcError::new("UNDO_EXPIRED", "This action can no longer be undone.");
pub const DELETE_CONFIRMATION: IpcError = IpcError::new(
    "CONFIRMATION_REQUIRED",
    "Confirm the permanent deletion of exactly the selected profiles.",
);
pub const UNKNOWN_FILE: IpcError = IpcError::new("UNKNOWN_FILE", "Choose the file again.");
pub const UNKNOWN_IMPORT: IpcError = IpcError::new(
    "UNKNOWN_IMPORT",
    "That import does not exist or has expired. Preview the file again.",
);
pub const SOURCE_CHANGED: IpcError = IpcError::new(
    "SOURCE_CHANGED",
    "The file changed after the preview. Preview it again before importing.",
);
pub const IMPORT_IN_PROGRESS: IpcError =
    IpcError::new("IMPORT_IN_PROGRESS", "An import is already running.");
pub const NOTHING_TO_IMPORT: IpcError = IpcError::new(
    "NOTHING_TO_IMPORT",
    "The preview found no valid rows to import.",
);
pub const EXPORT_FAILED: IpcError =
    IpcError::new("EXPORT_FAILED", "The export file could not be written.");
pub const NOTHING_SELECTED: IpcError =
    IpcError::new("NOTHING_SELECTED", "Select at least one profile.");

// ---------------------------------------------------------------------------------------- milestone 05
pub const UNKNOWN_PROXY: IpcError = IpcError::new(
    "UNKNOWN_PROXY",
    "That proxy does not exist in this workspace.",
);
pub const PROXY_IN_USE: IpcError = IpcError::new(
    "PROXY_IN_USE",
    "Profiles still use this proxy. Give them another proxy (or none) first.",
);
pub const INVALID_PROXY_TYPE: IpcError =
    IpcError::new("INVALID_PROXY_TYPE", "Choose HTTP, HTTPS or SOCKS5.");
pub const INVALID_PROXY_NAME: IpcError = IpcError::new(
    "INVALID_PROXY_NAME",
    "Proxy names must be 1-80 visible characters.",
);
pub const PROXY_NOTES_TOO_LONG: IpcError = IpcError::new(
    "NOTES_TOO_LONG",
    "Proxy notes can be at most 500 characters.",
);
pub const PROXY_BAD_HOST: IpcError = IpcError::new(
    "PROXY_BAD_HOST",
    "Enter the proxy's host name or IP address only (no http://, path or login).",
);
pub const PROXY_BAD_PORT: IpcError =
    IpcError::new("PROXY_BAD_PORT", "The port must be between 1 and 65535.");
pub const PROXY_BAD_CREDENTIALS: IpcError = IpcError::new(
    "PROXY_BAD_CREDENTIALS",
    "Usernames and passwords can be at most 255 bytes without control characters; HTTP usernames cannot contain a colon.",
);
pub const PROXY_PRIVATE_ADDRESS: IpcError = IpcError::new(
    "PROXY_PRIVATE_ADDRESS",
    "This proxy is on this computer or the local network. Allow local proxies in Settings to use it.",
);
pub const PROXY_FORBIDDEN_ADDRESS: IpcError = IpcError::new(
    "PROXY_FORBIDDEN_ADDRESS",
    "This address can never be used as a proxy (link-local, multicast or unspecified).",
);
pub const INVALID_DATE: IpcError = IpcError::new("INVALID_DATE", "Enter the date as YYYY-MM-DD.");
pub const KEYCHAIN_UNAVAILABLE: IpcError = IpcError::new(
    "KEYCHAIN_UNAVAILABLE",
    "This computer's secure credential storage is not available, so proxy logins cannot be saved.",
);
pub const KEYCHAIN_ERROR: IpcError = IpcError::new(
    "KEYCHAIN_ERROR",
    "The proxy login could not be read from or saved to secure storage.",
);
pub const PROXY_CREDENTIALS_MISSING: IpcError = IpcError::new(
    "PROXY_CREDENTIALS_MISSING",
    "The proxy's saved login is missing from this computer's secure storage. Enter it again.",
);
pub const GATEWAY_FAILED: IpcError = IpcError::new(
    "GATEWAY_FAILED",
    "The profile's proxy connection could not be prepared.",
);
pub const INVALID_LANGUAGE: IpcError = IpcError::new(
    "INVALID_LANGUAGE",
    "Choose one of the listed page languages.",
);
pub const INVALID_TIMEZONE: IpcError =
    IpcError::new("INVALID_TIMEZONE", "Choose one of the listed time zones.");
pub const INVALID_WINDOW_SIZE: IpcError = IpcError::new(
    "INVALID_WINDOW_SIZE",
    "Window size must be between 800×600 and 3840×2160.",
);
pub const INVALID_PRESET: IpcError =
    IpcError::new("INVALID_PRESET", "Preset names are at most 40 characters.");

// ----------------------------------------------------------------------------- account and organizations (06)
pub const CLOUD_NOT_CONFIGURED: IpcError = IpcError::new(
    "CLOUD_NOT_CONFIGURED",
    "Add your organization server's address in Account first.",
);
pub const CLOUD_BAD_SERVER: IpcError = IpcError::new(
    "CLOUD_BAD_SERVER",
    "Enter the server address starting with https:// (http is accepted only for this computer).",
);
pub const CLOUD_SIGNED_OUT: IpcError =
    IpcError::new("CLOUD_SIGNED_OUT", "Sign in to use organizations.");
pub const CLOUD_OFFLINE: IpcError = IpcError::new(
    "CLOUD_OFFLINE",
    "The organization server cannot be reached. Check your connection and try again.",
);
pub const CLOUD_UNAVAILABLE: IpcError = IpcError::new(
    "CLOUD_UNAVAILABLE",
    "The organization server is not answering right now. Try again in a moment.",
);
pub const CLOUD_TLS: IpcError = IpcError::new(
    "CLOUD_TLS",
    "The server's security certificate could not be verified.",
);
pub const CLOUD_BAD_RESPONSE: IpcError = IpcError::new(
    "CLOUD_BAD_RESPONSE",
    "The server sent an answer this app does not understand.",
);
pub const CLOUD_NOT_ALLOWED: IpcError =
    IpcError::new("CLOUD_NOT_ALLOWED", "That request is not available here.");
pub const SIGN_IN_UNAVAILABLE: IpcError = IpcError::new(
    "SIGN_IN_UNAVAILABLE",
    "The sign-in service cannot be reached. Check your connection and try again.",
);
pub const SIGN_IN_MISCONFIGURED: IpcError = IpcError::new(
    "SIGN_IN_MISCONFIGURED",
    "Sign-in is not set up correctly on this server. Contact your administrator.",
);
pub const SIGN_IN_ISSUER_MISMATCH: IpcError = IpcError::new(
    "SIGN_IN_ISSUER_MISMATCH",
    "The sign-in answer came from an unexpected service and was ignored.",
);
pub const SIGN_IN_CANCELLED: IpcError =
    IpcError::new("SIGN_IN_CANCELLED", "Sign-in was cancelled.");
pub const SIGN_IN_REFUSED: IpcError = IpcError::new(
    "SIGN_IN_REFUSED",
    "The sign-in service did not complete the sign-in. Try again.",
);
pub const SIGN_IN_FAILED: IpcError = IpcError::new(
    "SIGN_IN_FAILED",
    "The sign-in could not be completed. Start it again.",
);
pub const SIGN_IN_INTERRUPTED: IpcError = IpcError::new(
    "SIGN_IN_INTERRUPTED",
    "This sign-in is no longer waiting (it was replaced, cancelled or took too long). Start it again.",
);
pub const SIGN_IN_RATE_LIMITED: IpcError = IpcError::new(
    "SIGN_IN_RATE_LIMITED",
    "Too many sign-in attempts. Wait a few minutes and try again.",
);
pub const ORG_IMPORT_EMPTY: IpcError = IpcError::new(
    "ORG_IMPORT_EMPTY",
    "This workspace has no active profiles to copy.",
);

// ----------------------------------------------------------------------------- encrypted backups and sync (07)
pub const SYNC_NOT_LINKED: IpcError = IpcError::new(
    "SYNC_NOT_LINKED",
    "This profile is not part of an organization. Copy it to an organization first to back it up there.",
);
pub const SYNC_BUSY: IpcError = IpcError::new(
    "SYNC_BUSY",
    "A backup or restore of this profile is still in progress.",
);
pub const SYNC_CONFLICT_OPEN: IpcError = IpcError::new(
    "SYNC_CONFLICT_OPEN",
    "A newer backup was made on another computer. Choose how to resolve that first.",
);
pub const SYNC_NO_CONFLICT: IpcError = IpcError::new(
    "SYNC_NO_CONFLICT",
    "There is nothing to resolve for this profile.",
);
pub const SYNC_PROFILE_NOT_CLOSED: IpcError = IpcError::new(
    "SYNC_PROFILE_NOT_CLOSED",
    "Close the profile first. Only a profile that closed normally is backed up or replaced.",
);
pub const SYNC_ALREADY_HERE: IpcError = IpcError::new(
    "SYNC_ALREADY_HERE",
    "This organization profile is already on this computer.",
);
pub const PROFILE_RESTORING: IpcError = IpcError::new(
    "PROFILE_RESTORING",
    "This profile is being restored from a backup. It opens when the restore is finished.",
);

impl From<pb_netproxy::ConfigError> for IpcError {
    fn from(e: pb_netproxy::ConfigError) -> Self {
        use pb_netproxy::ConfigError as C;
        match e {
            C::BadHost => PROXY_BAD_HOST,
            C::BadPort => PROXY_BAD_PORT,
            C::BadCredentials | C::ColonInUsername => PROXY_BAD_CREDENTIALS,
            C::PrivateAddress => PROXY_PRIVATE_ADDRESS,
            C::ForbiddenAddress => PROXY_FORBIDDEN_ADDRESS,
        }
    }
}

impl From<pb_runtime::environment::EnvironmentError> for IpcError {
    fn from(e: pb_runtime::environment::EnvironmentError) -> Self {
        use pb_runtime::environment::EnvironmentError as E;
        match e {
            E::Language => INVALID_LANGUAGE,
            E::TimeZone => INVALID_TIMEZONE,
            E::Window => INVALID_WINDOW_SIZE,
            E::Preset => INVALID_PRESET,
        }
    }
}

impl From<LaunchError> for IpcError {
    fn from(e: LaunchError) -> Self {
        let message = match e {
            LaunchError::UnknownProfile => "This profile does not exist on this device.",
            LaunchError::AlreadyRunning => "This profile is already open.",
            LaunchError::BrowserNotConfigured => "The browser runtime is not installed.",
            LaunchError::BadStartUrl => "Start address must begin with http:// or https://.",
            LaunchError::DisallowedSwitch => "That browser option is not allowed.",
            LaunchError::BadEnvironment => "The profile's environment settings are not valid.",
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
            StoreError::Duplicate => DUPLICATE_NAME,
            StoreError::InUse(_) => PROXY_IN_USE,
            StoreError::Invalid(_) => INVALID_ARGUMENT,
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
/// Notes are plain text: hidden control and bidirectional characters are removed, and text that looks like a
/// password, key or card number is refused (notes are not encrypted; secrets belong in a password manager).
pub fn clean_notes(value: &str) -> Result<String, IpcError> {
    if value.len() > limits::NOTES_CHARS * 4 {
        return Err(NOTES_TOO_LONG);
    }
    let cleaned = pb_import::notes::sanitize(value);
    if cleaned.chars().count() > limits::NOTES_CHARS {
        return Err(NOTES_TOO_LONG);
    }
    if pb_import::notes::secret_hint(&cleaned).is_some() {
        return Err(NOTES_LOOK_SECRET);
    }
    Ok(cleaned)
}
