//! Validated launch pipeline. Every check runs BEFORE a process is spawned:
//!
//! 1. the profile id is well-formed (already guaranteed by the `ProfileId` type at the IPC boundary);
//! 2. the profile exists in the local store (caller-supplied lookup);
//! 3. the profile is not already running;
//! 4. the browser executable comes from trusted configuration, never from the request;
//! 5. directories resolve inside the profiles root and are not symlinks;
//! 6. start URLs are http(s) only (at most 10) and are passed after `--`, so they can never become switches;
//! 7. extra switches are accepted only from a fixed allowlist used by the manager's own test configuration
//!    (headless CI runs); nothing from the UI ever becomes a switch;
//! 8. proxy routing and environment settings (milestone 05) become switches only from typed, validated values: the
//!    proxy is always the manager's loopback gateway (never an address or login from the request), languages and
//!    time zones come from fixed lists, window sizes are bounded.
//!
//! Only then is the `Launcher` called. The process is started from a structured argument list (never a shell
//! string), the Chromium sandbox is never disabled, and no remote-debugging switch is ever added. This crate does
//! not alter browser fingerprinting signals. See docs/security-model.md.

use crate::environment::{Platform, PrivacyConfig};
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
    #[error("switch is not allowed")]
    DisallowedSwitch,
    #[error("environment settings are not valid")]
    BadEnvironment,
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
            Self::DisallowedSwitch => "DISALLOWED_SWITCH",
            Self::BadEnvironment => "INVALID_ENVIRONMENT",
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
    /// Environment set for the browser on top of the minimal inherited one (e.g. `TZ`).
    pub env: Vec<(String, String)>,
}

/// The profile is routed through the manager's loopback gateway on this port (fail-closed: no direct route).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkLaunch {
    pub gateway_port: u16,
}

pub struct LaunchRequest<'a> {
    pub profile_id: &'a ProfileId,
    pub start_urls: &'a [String],
    /// Extra switches from the manager's own configuration; each must be in [`ALLOWED_EXTRA_SWITCHES`].
    pub switches: &'a [String],
    pub network: Option<NetworkLaunch>,
    pub environment: Option<&'a PrivacyConfig>,
}

pub const MAX_START_URLS: usize = 10;

/// Switches the manager's test configuration may add (headless CI, diagnostics). Notably absent: `--no-sandbox`
/// and any remote-debugging switch. `--enable-logging` writes `chrome_debug.log` into the profile folder (CI only).
pub const ALLOWED_EXTRA_SWITCHES: &[&str] = &[
    "--headless=new",
    "--ozone-platform=headless",
    "--disable-gpu",
    "--use-mock-keychain",
    "--password-store=basic",
    "--enable-logging",
];

/// Test-only switches that carry a value, with the rule the value must meet. `--log-net-log` records the browser's
/// own network events (socket connects, name lookups) as leak-test evidence; it never includes cookies or logins.
const TEST_VALUED_SWITCHES: &[&str] = &["--log-net-log="];

fn allowed_switch(s: &str) -> bool {
    if ALLOWED_EXTRA_SWITCHES.contains(&s) {
        return true;
    }
    TEST_VALUED_SWITCHES.iter().any(|prefix| {
        s.strip_prefix(prefix).is_some_and(|v| {
            Path::new(v).is_absolute() && !v.chars().any(|c| c.is_control()) && !v.contains("..")
        })
    })
}

pub fn valid_start_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && url.len() > 8
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
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
    if request.start_urls.len() > MAX_START_URLS
        || !request.start_urls.iter().all(|u| valid_start_url(u))
    {
        return Err(LaunchError::BadStartUrl);
    }
    if !request.switches.iter().all(|s| allowed_switch(s)) {
        return Err(LaunchError::DisallowedSwitch);
    }
    let default_env = PrivacyConfig::default();
    let environment = request.environment.unwrap_or(&default_env);
    crate::environment::validate(environment).map_err(|_| LaunchError::BadEnvironment)?;

    let dirs = root.ensure(request.profile_id)?;
    let mut args: Vec<OsString> = vec![
        flag("--user-data-dir=", &dirs.user_data),
        flag("--disk-cache-dir=", &dirs.cache),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ];
    if let Some(n) = request.network {
        // Everything, including loopback addresses, goes to the gateway; QUIC (UDP) is never used.
        args.push(format!("--proxy-server=http://127.0.0.1:{}", n.gateway_port).into());
        args.push("--proxy-bypass-list=<-loopback>".into());
        args.push("--disable-quic".into());
    }
    if let Some(lang) = &environment.language {
        args.push(format!("--lang={lang}").into());
    }
    if let Some(w) = environment.window {
        args.push(format!("--window-size={},{}", w.width, w.height).into());
    }
    if environment.reduced_motion {
        args.push("--force-prefers-reduced-motion".into());
    }
    let mut env = vec![];
    if let Some(tz) = &environment.timezone
        && Platform::current() != Platform::Windows
    {
        env.push(("TZ".to_owned(), tz.clone()));
    }
    args.extend(request.switches.iter().map(OsString::from));
    if !request.start_urls.is_empty() {
        args.push("--".into()); // everything after is a URL, never a switch
        args.extend(request.start_urls.iter().map(OsString::from));
    }
    Ok(LaunchSpec {
        profile_id: request.profile_id.clone(),
        executable: browser.executable.clone(),
        args,
        dirs,
        env,
    })
}

fn flag(name: &str, path: &Path) -> OsString {
    let mut s = OsString::from(name);
    s.push(path.as_os_str());
    s
}

/// A started browser process. `child` is kept by the supervisor so the process can be reaped; it is `None` for
/// test launchers and for processes adopted after a manager restart.
pub struct Spawned {
    pub pid: u32,
    pub child: Option<Child>,
}

pub trait Launcher: Send + Sync {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Spawned, LaunchError>;
}

/// Spawns the real browser process detached from the manager's stdio.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Spawned, LaunchError> {
        let child: Child = Command::new(&spec.executable)
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear()
            .envs(safe_env())
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .spawn()
            .map_err(LaunchError::Spawn)?;
        Ok(Spawned {
            pid: child.id(),
            child: Some(child),
        })
    }
}

/// Minimal environment for the browser: the manager's secrets/tokens are never inherited.
fn safe_env() -> Vec<(String, String)> {
    safe_env_from(std::env::vars())
}

/// Variables a browser needs to run; nothing else (tokens, proxies set for the manager, debug flags) is passed.
/// Windows variable names are case-insensitive (`SystemRoot`, `Path`), so names are compared in upper case.
const ALLOWED_ENV: &[&str] = &[
    // all platforms
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "USER",
    "LOGNAME",
    // Linux display
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    // Windows: without SystemRoot, networking and system DLL loading fail
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
];

fn safe_env_from(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.filter(|(k, _)| ALLOWED_ENV.contains(&k.to_ascii_uppercase().as_str()))
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
                start_urls: &[
                    "https://example.test/".into(),
                    "https://second.test/a".into(),
                ],
                switches: &["--headless=new".into()],
                network: None,
                environment: None,
            },
        )?;
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args[0].starts_with("--user-data-dir=") && args[0].ends_with("user-data"));
        assert_eq!(args[args.len() - 3], "--");
        assert_eq!(args[args.len() - 2], "https://example.test/");
        assert!(args.contains(&"--headless=new".to_string()));
        assert!(
            !args
                .iter()
                .any(|a| a.contains("remote-debugging") || a == "--no-sandbox"),
            "no debug endpoint, sandbox stays on"
        );
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
                    start_urls: &url.map(|u: &str| vec![u.to_string()]).unwrap_or_default(),
                    switches: &[],
                    network: None,
                    environment: None,
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
    fn environment_is_minimal_and_case_insensitive() {
        let vars = [
            ("SystemRoot", "C:\\Windows"),
            ("Path", "C:\\Windows\\System32"),
            ("HOME", "/Users/a"),
            ("PB_API_TOKEN", "secret"),
            ("HTTPS_PROXY", "http://manager-only"),
            ("RUST_LOG", "debug"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let kept: Vec<String> = safe_env_from(vars).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["SystemRoot", "Path", "HOME"]);
    }

    #[test]
    fn only_allowlisted_switches_are_accepted() {
        let (_tmp, root, browser) = setup();
        for bad in [
            "--no-sandbox",
            "--remote-debugging-port=9222",
            "--remote-debugging-pipe",
            "--load-extension=/x",
        ] {
            let err = prepare_launch(
                &root,
                Some(&browser),
                ProfileState {
                    exists: true,
                    running: false,
                },
                LaunchRequest {
                    profile_id: &id(),
                    start_urls: &[],
                    switches: &[bad.to_string()],
                    network: None,
                    environment: None,
                },
            );
            assert!(matches!(err, Err(LaunchError::DisallowedSwitch)), "{bad}");
        }
        let too_many: Vec<String> = (0..11).map(|i| format!("https://e.test/{i}")).collect();
        let err = prepare_launch(
            &root,
            Some(&browser),
            ProfileState {
                exists: true,
                running: false,
            },
            LaunchRequest {
                profile_id: &id(),
                start_urls: &too_many,
                switches: &[],
                network: None,
                environment: None,
            },
        );
        assert!(matches!(err, Err(LaunchError::BadStartUrl)));
    }

    #[test]
    fn proxy_and_environment_become_typed_switches_only() -> Result<(), LaunchError> {
        let (_tmp, root, browser) = setup();
        let env = PrivacyConfig {
            language: Some("de-DE".into()),
            timezone: Some("Europe/Berlin".into()),
            window: Some(crate::environment::WindowSize {
                width: 1366,
                height: 768,
            }),
            reduced_motion: true,
            ..Default::default()
        };
        let spec = prepare_launch(
            &root,
            Some(&browser),
            ProfileState {
                exists: true,
                running: false,
            },
            LaunchRequest {
                profile_id: &id(),
                start_urls: &["https://example.test/".into()],
                switches: &[],
                network: Some(NetworkLaunch {
                    gateway_port: 40123,
                }),
                environment: Some(&env),
            },
        )?;
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "--proxy-server=http://127.0.0.1:40123",
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--lang=de-DE",
            "--window-size=1366,768",
            "--force-prefers-reduced-motion",
        ] {
            assert!(
                args.contains(&expected.to_owned()),
                "{expected} in {args:?}"
            );
        }
        let dash = args.iter().position(|a| a == "--").unwrap_or(0);
        assert!(
            args.iter()
                .position(|a| a.starts_with("--proxy-server"))
                .unwrap_or(usize::MAX)
                < dash,
            "switches come before the URL separator"
        );
        let tz = spec
            .env
            .iter()
            .find(|(k, _)| k == "TZ")
            .map(|(_, v)| v.as_str());
        if cfg!(windows) {
            assert_eq!(
                tz, None,
                "Windows ignores TZ; the setting is reported as unavailable"
            );
        } else {
            assert_eq!(tz, Some("Europe/Berlin"));
        }
        // Invalid environment values never reach the command line.
        let bad = PrivacyConfig {
            language: Some("de --no-sandbox".into()),
            ..Default::default()
        };
        let err = prepare_launch(
            &root,
            Some(&browser),
            ProfileState {
                exists: true,
                running: false,
            },
            LaunchRequest {
                profile_id: &id(),
                start_urls: &[],
                switches: &[],
                network: None,
                environment: Some(&bad),
            },
        );
        assert!(matches!(err, Err(LaunchError::BadEnvironment)));
        Ok(())
    }

    #[test]
    fn the_net_log_test_switch_needs_an_absolute_path() {
        let abs = if cfg!(windows) {
            "C:\\logs\\net.json"
        } else {
            "/tmp/net.json"
        };
        assert!(allowed_switch(&format!("--log-net-log={abs}")));
        for bad in [
            "--log-net-log=relative.json",
            "--log-net-log=/tmp/../etc/x",
            "--log-net-log",
            "--proxy-server=http://evil",
        ] {
            assert!(!allowed_switch(bad), "{bad}");
        }
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
                    start_urls: &[],
                    switches: &[],
                    network: None,
                    environment: None,
                },
            );
            assert!(matches!(err, Err(LaunchError::BrowserNotConfigured)));
        }
    }
}
