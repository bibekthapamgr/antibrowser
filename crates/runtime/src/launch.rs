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
//!    time zones come from fixed lists, window sizes are bounded;
//! 9. the only extension switch ever added is `--disable-extensions` (an organization policy in enforce mode,
//!    milestone 09); switches that load or allow extensions (`--load-extension`, `--disable-extensions-except`) are
//!    never accepted;
//! 10. an automation session (milestone 10) adds `--enable-automation` (websites can tell, and the window says so)
//!     and `--disable-backgrounding-occluded-windows` (a covered job window keeps rendering), and the launcher
//!     connects the DevTools protocol over a protected pipe (`--remote-debugging-pipe`, on Windows with
//!     `--remote-debugging-io-pipes`): only this app holds the other ends. `--remote-debugging-port` and
//!     `--remote-debugging-address` are never added, and no switch from a job or the UI is accepted.
//!
//! Only then is the `Launcher` called. The process is started from a structured argument list (never a shell
//! string), the Chromium sandbox is never disabled, and no remote-debugging port is ever opened. This crate does
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
    /// Milestone 10: connect the DevTools protocol over a protected pipe (an automation session).
    pub devtools: bool,
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
    /// The organization's extension policy turned extensions off for this session (milestone 09): Chromium's own
    /// `--disable-extensions` switch. Nothing else about extensions is ever passed on the command line.
    pub extensions_disabled: bool,
    /// An automation session (milestone 10): `--enable-automation` and the DevTools protocol over a protected pipe.
    pub automation: bool,
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
        // Milestone 12: no crash dumps. A dump holds page memory (cookies, form contents, session data); the
        // manager reports a crash from the exit record without one.
        "--disable-breakpad".into(),
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
    if request.extensions_disabled {
        args.push("--disable-extensions".into());
    }
    if request.automation {
        // Websites can tell the session is automated (navigator.webdriver), and the window shows it.
        args.push("--enable-automation".into());
        // A job's window keeps rendering when other windows cover it (its steps and screenshots need frames).
        args.push("--disable-backgrounding-occluded-windows".into());
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
        devtools: request.automation,
    })
}

fn flag(name: &str, path: &Path) -> OsString {
    let mut s = OsString::from(name);
    s.push(path.as_os_str());
    s
}

/// A started browser process. `child` is kept by the supervisor so the process can be reaped; it is `None` for
/// test launchers and for processes adopted after a manager restart. `devtools`: this app's ends of the protected
/// DevTools pipe (automation sessions only).
pub struct Spawned {
    pub pid: u32,
    pub child: Option<Child>,
    pub devtools: Option<pb_devtools::PipeEnds>,
}

pub trait Launcher: Send + Sync {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Spawned, LaunchError>;
}

/// Spawns the real browser process detached from the manager's stdio.
pub struct SystemLauncher;

/// On Windows every inheritable handle that exists while *any* process starts is inherited by it. Browser starts are
/// serialised, and a job's pipe ends are made inheritable and closed again inside this lock, so they reach only their
/// own browser (Unix pipes are close-on-exec and placed in the child only).
static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl Launcher for SystemLauncher {
    fn spawn(&self, spec: &LaunchSpec) -> Result<Spawned, LaunchError> {
        let _one = SPAWN
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut cmd = Command::new(&spec.executable);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear()
            .envs(safe_env())
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        // URLs come after `--`: the pipe switches go before them.
        let split = spec
            .args
            .iter()
            .position(|a| a == "--")
            .unwrap_or(spec.args.len());
        cmd.args(&spec.args[..split]);
        let pipes = if spec.devtools {
            let p = pb_devtools::DevtoolsPipes::create().map_err(LaunchError::Spawn)?;
            p.attach(&mut cmd);
            Some(p)
        } else {
            None
        };
        cmd.args(&spec.args[split..]);
        let child: Child = cmd.spawn().map_err(LaunchError::Spawn)?;
        Ok(Spawned {
            pid: child.id(),
            child: Some(child),
            // The browser's ends are closed here now that it has its own copies.
            devtools: pipes.map(pb_devtools::DevtoolsPipes::into_ends),
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
    fn extensions_are_only_ever_turned_off() -> Result<(), LaunchError> {
        let (_tmp, root, browser) = setup();
        let profile = id();
        let state = || ProfileState {
            exists: true,
            running: false,
        };
        for (disabled, switch, expected) in [
            (true, None, Ok(true)),
            (false, None, Ok(false)),
            (
                false,
                Some("--disable-extensions"),
                Err("DISALLOWED_SWITCH"),
            ),
            (
                false,
                Some("--disable-extensions-except=/x"),
                Err("DISALLOWED_SWITCH"),
            ),
            (false, Some("--load-extension=/x"), Err("DISALLOWED_SWITCH")),
        ] {
            let switches: Vec<String> = switch.map(str::to_owned).into_iter().collect();
            let got = prepare_launch(
                &root,
                Some(&browser),
                state(),
                LaunchRequest {
                    profile_id: &profile,
                    start_urls: &[],
                    switches: &switches,
                    network: None,
                    environment: None,
                    extensions_disabled: disabled,
                    automation: false,
                },
            )
            .map(|spec| spec.args.iter().any(|a| a == "--disable-extensions"))
            .map_err(|e| e.code());
            assert_eq!(got, expected, "{switch:?}");
        }
        Ok(())
    }

    #[test]
    fn automation_sessions_say_so_and_never_open_a_debugging_port() -> Result<(), LaunchError> {
        let (_tmp, root, browser) = setup();
        let profile = id();
        let urls = vec!["https://example.test/".to_owned()];
        let spec = |automation: bool, switches: &[String]| {
            prepare_launch(
                &root,
                Some(&browser),
                ProfileState {
                    exists: true,
                    running: false,
                },
                LaunchRequest {
                    profile_id: &profile,
                    start_urls: &urls,
                    switches,
                    network: None,
                    environment: None,
                    extensions_disabled: false,
                    automation,
                },
            )
        };
        let auto = spec(true, &[])?;
        assert!(auto.devtools);
        assert!(auto.args.iter().any(|a| a == "--enable-automation"));
        assert!(
            auto.args
                .iter()
                .any(|a| a == "--disable-backgrounding-occluded-windows")
        );
        let plain = spec(false, &[])?;
        assert!(!plain.devtools);
        assert!(
            !plain
                .args
                .iter()
                .any(|a| a == "--enable-automation"
                    || a == "--disable-backgrounding-occluded-windows")
        );
        for s in [&auto, &plain] {
            assert!(
                !s.args
                    .iter()
                    .any(|a| a.to_string_lossy().starts_with("--remote-debugging")),
                "the pipe switch is the launcher's, never part of the spec"
            );
        }
        // Nothing from configuration can open a port or turn automation on.
        for bad in [
            "--remote-debugging-port=9222",
            "--remote-debugging-pipe",
            "--remote-debugging-address=0.0.0.0",
            "--enable-automation",
        ] {
            assert_eq!(
                spec(false, &[bad.to_owned()])
                    .map(|_| ())
                    .map_err(|e| e.code()),
                Err("DISALLOWED_SWITCH"),
                "{bad}"
            );
        }
        Ok(())
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
                extensions_disabled: false,
                automation: false,
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
                    extensions_disabled: false,
                    automation: false,
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
                    extensions_disabled: false,
                    automation: false,
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
                extensions_disabled: false,
                automation: false,
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
                extensions_disabled: false,
                automation: false,
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
            // Milestone 12: no crash dumps (they would hold page memory).
            "--disable-breakpad",
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
                extensions_disabled: false,
                automation: false,
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
                    extensions_disabled: false,
                    automation: false,
                },
            );
            assert!(matches!(err, Err(LaunchError::BrowserNotConfigured)));
        }
    }
}
