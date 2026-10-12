//! Validated launch pipeline. Every check runs BEFORE a process is spawned:
//!
//! 1. the profile id is well-formed (already guaranteed by the `ProfileId` type at the IPC boundary);
//! 2. the profile exists in the local store (caller-supplied lookup);
//! 3. the profile is not already running;
//! 4. the browser executable comes from trusted configuration, never from the request;
//! 5. directories resolve inside the profiles root and are not symlinks;
//! 6. an optional start URL is http(s) only.
//!
//! Only then is the `Launcher` called. The argument list is fixed: this crate does not alter browser
//! fingerprinting signals. See docs/security-model.md.

use crate::id::ProfileId;
use crate::layout::{LayoutError, ProfileDirs, ProfilesRoot};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("unknown profile")]
    UnknownProfile,
    #[error("profile is already running")]
    AlreadyRunning,
    #[error("browser runtime is not installed or not configured")]
    BrowserNotConfigured,
    #[error("start URL must be http or https")]
    BadStartUrl,
    #[error("profile directory rejected: {0}")]
    Layout(#[from] LayoutError),
    #[error("failed to start browser: {0}")]
    Spawn(std::io::Error),
}

impl LaunchError {
    /// Stable machine-readable code returned over IPC (no paths or OS detail leak to the UI).
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownProfile => "UNKNOWN_PROFILE",
            Self::AlreadyRunning => "ALREADY_RUNNING",
            Self::BrowserNotConfigured => "BROWSER_NOT_CONFIGURED",
            Self::BadStartUrl => "BAD_START_URL",
            Self::Layout(_) => "PROFILE_DIRECTORY_REJECTED",
            Self::Spawn(_) => "SPAWN_FAILED",
        }
    }
}

/// Browser installation resolved by the desktop shell from its own trusted configuration.
#[derive(Clone, Debug)]
pub struct BrowserInstall {
    pub executable: PathBuf,
    pub revision: String,
}

impl BrowserInstall {
    pub fn validate(&self) -> Result<(), LaunchError> {
        if self.executable.is_absolute() && self.executable.is_file() {
            Ok(())
        } else {
            Err(LaunchError::BrowserNotConfigured)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchSpec {
    pub profile_id: ProfileId,
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub dirs: ProfileDirs,
}

pub struct LaunchRequest<'a> {
    pub profile_id: &'a ProfileId,
    pub start_url: Option<&'a str>,
}

/// Facts about the profile that the caller looks up in its local store.
pub struct ProfileState {
    pub exists: bool,
    pub running: bool,
}

pub fn prepare_launch(
    root: &ProfilesRoot,
    browser: Option<&BrowserInstall>,
    state: ProfileState,
    request: LaunchRequest<'_>,
) -> Result<LaunchSpec, LaunchError> {
    if !state.exists {
        return Err(LaunchError::UnknownProfile);
    }
    if state.running {
        return Err(LaunchError::AlreadyRunning);
    }
    let browser = browser.ok_or(LaunchError::BrowserNotConfigured)?;
    browser.validate()?;
    if let Some(url) = request.start_url {
        let lower = url.to_ascii_lowercase();
        let ok = (lower.starts_with("https://") || lower.starts_with("http://"))
            && url.len() <= 2048
            && !url.chars().any(char::is_control);
        if !ok {
            return Err(LaunchError::BadStartUrl);
        }
    }

    let dirs = root.ensure(request.profile_id)?;
    let mut args: Vec<OsString> = vec![
        flag("--user-data-dir=", &dirs.user_data),
        flag("--disk-cache-dir=", &dirs.cache),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ];
    if let Some(url) = request.start_url {
        args.push("--".into()); // everything after is a URL, never a switch
        args.push(url.into());
    }
    Ok(LaunchSpec {
        profile_id: request.profile_id.clone(),
        executable: browser.executable.clone(),
        args,
        dirs,
    })
}

fn flag(name: &str, path: &Path) -> OsString {
    let mut s = OsString::from(name);
    s.push(path.as_os_str());
    s
}

pub trait Launcher: Send + Sync {
    fn spawn(&self, spec: &LaunchSpec) -> Result<u32, LaunchError>;
}

/// Spawns the real browser process detached from the manager's stdio.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<u32, LaunchError> {
        let child: Child = Command::new(&spec.executable)
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear()
            .envs(safe_env())
            .spawn()
            .map_err(LaunchError::Spawn)?;
        Ok(child.id())
    }
}

/// Minimal environment for the browser: the manager's secrets/tokens are never inherited.
fn safe_env() -> Vec<(String, String)> {
    const ALLOW: &[&str] = &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
    ];
    std::env::vars()
        .filter(|(k, _)| ALLOW.contains(&k.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, ProfilesRoot, BrowserInstall) {
        let tmp = tempfile::tempdir().unwrap_or_else(|_| panic!("tmp"));
        let root_dir = tmp.path().join("profiles");
        std::fs::create_dir_all(&root_dir).unwrap_or_else(|_| panic!("mkdir"));
        let exe = tmp.path().join("fake-browser");
        std::fs::write(&exe, b"").unwrap_or_else(|_| panic!("write"));
        let root = ProfilesRoot::open(&root_dir).unwrap_or_else(|_| panic!("root"));
        (
            tmp,
            root,
            BrowserInstall {
                executable: exe,
                revision: "test".into(),
            },
        )
    }

    fn id() -> ProfileId {
        ProfileId::parse("prf_01J9ZSEED0A010000000000000").unwrap_or_else(|_| panic!("id"))
    }

    #[test]
    fn builds_fixed_argument_list() -> Result<(), LaunchError> {
        let (_tmp, root, browser) = setup();
        let spec = prepare_launch(
            &root,
            Some(&browser),
            ProfileState {
                exists: true,
                running: false,
            },
            LaunchRequest {
                profile_id: &id(),
                start_url: Some("https://example.test/"),
            },
        )?;
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args[0].starts_with("--user-data-dir=") && args[0].ends_with("user-data"));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args[args.len() - 1], "https://example.test/");
        Ok(())
    }

    #[test]
    fn rejects_before_touching_the_filesystem() {
        let (_tmp, root, browser) = setup();
        let cases = [
            (
                ProfileState {
                    exists: false,
                    running: false,
                },
                None,
                "UNKNOWN_PROFILE",
            ),
            (
                ProfileState {
                    exists: true,
                    running: true,
                },
                None,
                "ALREADY_RUNNING",
            ),
            (
                ProfileState {
                    exists: true,
                    running: false,
                },
                Some("file:///etc/passwd"),
                "BAD_START_URL",
            ),
            (
                ProfileState {
                    exists: true,
                    running: false,
                },
                Some("--load-extension=/x"),
                "BAD_START_URL",
            ),
            (
                ProfileState {
                    exists: true,
                    running: false,
                },
                Some("javascript:alert(1)"),
                "BAD_START_URL",
            ),
        ];
        for (state, url, code) in cases {
            let err = prepare_launch(
                &root,
                Some(&browser),
                state,
                LaunchRequest {
                    profile_id: &id(),
                    start_url: url,
                },
            )
            .err()
            .map(|e| e.code());
            assert_eq!(err, Some(code));
        }
        assert!(
            !root.dirs(&id()).root.exists(),
            "no directory may be created for a rejected launch"
        );
    }

    #[test]
    fn requires_a_configured_absolute_browser() {
        let (_tmp, root, _) = setup();
        let relative = BrowserInstall {
            executable: "chrome".into(),
            revision: "x".into(),
        };
        for browser in [None, Some(&relative)] {
            let err = prepare_launch(
                &root,
                browser,
                ProfileState {
                    exists: true,
                    running: false,
                },
                LaunchRequest {
                    profile_id: &id(),
                    start_url: None,
                },
            );
            assert!(matches!(err, Err(LaunchError::BrowserNotConfigured)));
        }
    }
}
