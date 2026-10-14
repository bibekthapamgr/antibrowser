//! Manager updates (milestone 12, ADR-0019). The manager checks a signed manifest for its channel (`stable`,
//! `canary` or `dev`) on GitHub Releases, downloads the offered installer with resume, and installs it only after
//! the size, SHA-256 and Tauri update signature match (checked again right before installing). The release keys are
//! compiled in (`release-keys.json`) with a validity window; replayed or stale manifests, downgrades, revoked
//! versions and versions below the channel's minimum are refused (all in `pb_update::app`). A manifest can pause
//! distribution and mark this version as known-vulnerable; nothing here ever touches profiles or other local data.
//!
//! Checking and downloading may run in the background (setting `updates.automatic`); installing always needs the
//! person's click and closed profiles, because the manager restarts.

use crate::events;
use crate::ipc::{self, IpcError};
use crate::operations::OpKind;
use crate::state::{APP_VERSION, AppState};
use pb_storage::settings;
use pb_update::app::{
    self as up, AppUpdateError, Blocked, Downloaded, HttpsTransport, Offer, ReleaseKeys, Transport,
    UpdateState,
};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// The release public keys this build trusts (empty until the owner has generated the release key).
pub const RELEASE_KEYS_JSON: &str = include_str!("../release-keys.json");

/// The first automatic check waits until the manager has settled; later ones follow every few hours.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(45);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);

// ------------------------------------------------------------------------------------------------ errors
pub const UPDATES_NOT_CONFIGURED: IpcError = IpcError::new(
    "UPDATES_NOT_CONFIGURED",
    "This build has no release key, so it cannot check for updates. Install new versions manually.",
);
pub const UPDATE_SIGNATURE_INVALID: IpcError = IpcError::new(
    "UPDATE_SIGNATURE_INVALID",
    "The update was not signed with the Project Browser release key. Nothing was installed.",
);
pub const UPDATE_KEY_EXPIRED: IpcError = IpcError::new(
    "UPDATE_KEY_EXPIRED",
    "The update was signed with a release key this version no longer accepts. Install the newest version manually.",
);
pub const UPDATE_MANIFEST_INVALID: IpcError = IpcError::new(
    "UPDATE_MANIFEST_INVALID",
    "The update information could not be used. Nothing was installed.",
);
pub const UPDATE_MANIFEST_EXPIRED: IpcError = IpcError::new(
    "UPDATE_MANIFEST_EXPIRED",
    "The update information is out of date, so it was not trusted. Try again later; nothing was installed.",
);
pub const UPDATE_MANIFEST_REPLAYED: IpcError = IpcError::new(
    "UPDATE_MANIFEST_REPLAYED",
    "The server sent older update information than this computer has already seen. Nothing was installed.",
);
pub const UPDATE_CORRUPT: IpcError = IpcError::new(
    "UPDATE_CORRUPT",
    "The downloaded update did not match its signature and was deleted. Try again.",
);
pub const UPDATE_DOWNLOAD_FAILED: IpcError = IpcError::new(
    "UPDATE_DOWNLOAD_FAILED",
    "The update could not be downloaded. Check the connection and try again; the download continues where it stopped.",
);
pub const UPDATE_CANCELLED: IpcError = IpcError::new(
    "UPDATE_CANCELLED",
    "The download was stopped. It continues where it stopped next time.",
);
pub const UPDATE_INSTALL_FAILED: IpcError = IpcError::new(
    "UPDATE_INSTALL_FAILED",
    "The update could not be installed. This version is unchanged.",
);
pub const UPDATE_IO: IpcError = IpcError::new(
    "UPDATE_IO",
    "The update could not be saved on this computer. Check the free disk space.",
);
pub const UPDATE_BUSY: IpcError = IpcError::new(
    "UPDATE_BUSY",
    "An update check or download is already running.",
);
pub const UPDATE_NOT_AVAILABLE: IpcError = IpcError::new(
    "UPDATE_NOT_AVAILABLE",
    "There is no update to download. Check for updates first.",
);
pub const UPDATE_NOT_READY: IpcError = IpcError::new(
    "UPDATE_NOT_READY",
    "There is no downloaded update to install. Check for updates first.",
);
pub const UPDATE_PROFILES_OPEN: IpcError = IpcError::new(
    "UPDATE_PROFILES_OPEN",
    "Close the open profiles first: the app restarts to install the update.",
);
pub const UPDATE_UNSUPPORTED: IpcError = IpcError::new(
    "UPDATE_UNSUPPORTED",
    "This system has no automatic installer. Install the new version manually.",
);
pub const UPDATE_MOVE_APP: IpcError = IpcError::new(
    "UPDATE_MOVE_APP",
    "Move Project Browser into your Applications folder and open it from there, then install the update.",
);

fn error_of(e: &AppUpdateError) -> IpcError {
    match e {
        AppUpdateError::NoKeys => UPDATES_NOT_CONFIGURED,
        AppUpdateError::BadSignature => UPDATE_SIGNATURE_INVALID,
        AppUpdateError::KeyExpired(_) => UPDATE_KEY_EXPIRED,
        AppUpdateError::Invalid(_) => UPDATE_MANIFEST_INVALID,
        AppUpdateError::Expired(_) => UPDATE_MANIFEST_EXPIRED,
        AppUpdateError::Replayed { .. } => UPDATE_MANIFEST_REPLAYED,
        AppUpdateError::Corrupt => UPDATE_CORRUPT,
        AppUpdateError::Download(_) => UPDATE_DOWNLOAD_FAILED,
        AppUpdateError::Cancelled => UPDATE_CANCELLED,
        AppUpdateError::Install(_) => UPDATE_INSTALL_FAILED,
        AppUpdateError::Io(_) => UPDATE_IO,
    }
}

// ------------------------------------------------------------------------------------------------ views
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Not checked yet (or the channel changed since the last check).
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    /// Downloaded and verified; installing needs a click.
    Ready,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AvailableUpdate {
    pub version: String,
    pub notes_url: String,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateErrorView {
    pub code: &'static str,
    pub message: &'static str,
}

impl From<IpcError> for UpdateErrorView {
    fn from(e: IpcError) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

/// What the manager shows about its own updates (the `update` event carries the same object).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateStatus {
    /// This build has a release key (otherwise it never checks).
    pub configured: bool,
    /// This system can install updates itself (Windows installer, macOS app bundle).
    pub install_supported: bool,
    pub current_version: String,
    pub platform: String,
    pub channel: String,
    pub automatic: bool,
    pub phase: Phase,
    pub checked_at: Option<String>,
    pub latest_version: Option<String>,
    pub available: Option<AvailableUpdate>,
    /// Distribution of this channel is paused by the publisher (nothing is offered meanwhile).
    pub paused: bool,
    /// This version must be updated: revoked, or below the channel's minimum safe version.
    pub blocked: Option<Blocked>,
    pub manifest_expires_at: Option<String>,
    pub progress: Option<DownloadProgress>,
    pub error: Option<UpdateErrorView>,
}

/// What the shell does after [`AppState::update_install`] has prepared the update.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallPlan {
    /// Windows: run this verified installer (it replaces the app and starts it again), then quit.
    RunInstaller(PathBuf),
    /// macOS: the app bundle was replaced; restart into the new version.
    Restart,
}

// ------------------------------------------------------------------------------------------------ runtime
struct Ready {
    downloaded: Downloaded,
    offer: Offer,
    channel: String,
}

#[derive(Default)]
struct Inner {
    phase: Option<Phase>,
    /// Channel of the last check; a different selected channel means "not checked".
    channel: Option<String>,
    checked_at: Option<i64>,
    latest_version: Option<String>,
    paused: bool,
    blocked: Option<Blocked>,
    expires_at: Option<String>,
    /// The download offered by the last successful check (cleared when a check fails).
    offer: Option<Offer>,
    ready: Option<Ready>,
    progress: Option<DownloadProgress>,
    error: Option<IpcError>,
    /// Highest accepted sequence per channel, also kept in memory in case the state file cannot be written.
    sequences: std::collections::BTreeMap<String, u64>,
    /// A check or download is running (changed together with the phase, under the same lock).
    busy: bool,
}

pub struct UpdateRuntime {
    keys: RwLock<Arc<ReleaseKeys>>,
    transport: RwLock<Arc<dyn Transport>>,
    /// Overrides for tests: platform, version, clock and the macOS bundle to replace.
    platform: RwLock<Option<String>>,
    version: RwLock<Option<String>>,
    clock: RwLock<Option<i64>>,
    bundle: RwLock<Option<PathBuf>>,
    /// A signature failure is checked once more after this pause: publishing replaces the manifest and its
    /// signature one after the other, so a check in between sees a mismatch (and never accepts it).
    retry_delay: RwLock<Duration>,
    inner: Mutex<Inner>,
    cancel: AtomicBool,
    worker: AtomicBool,
}

impl Default for UpdateRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateRuntime {
    pub fn new() -> Self {
        // A malformed key file fails the unit test below; at run time it only disables updates.
        let keys = ReleaseKeys::parse(RELEASE_KEYS_JSON).unwrap_or_default();
        Self {
            keys: RwLock::new(Arc::new(keys)),
            transport: RwLock::new(Arc::new(HttpsTransport)),
            platform: RwLock::new(None),
            version: RwLock::new(None),
            clock: RwLock::new(None),
            bundle: RwLock::new(None),
            retry_delay: RwLock::new(Duration::from_secs(5)),
            inner: Mutex::new(Inner::default()),
            cancel: AtomicBool::new(false),
            worker: AtomicBool::new(false),
        }
    }

    fn keys(&self) -> Arc<ReleaseKeys> {
        self.keys
            .read()
            .map(|k| k.clone())
            .unwrap_or_else(|_| Arc::new(ReleaseKeys::default()))
    }

    fn transport(&self) -> Arc<dyn Transport> {
        self.transport
            .read()
            .map(|t| t.clone())
            .unwrap_or_else(|_| Arc::new(HttpsTransport))
    }

    fn platform(&self) -> String {
        self.platform
            .read()
            .ok()
            .and_then(|p| p.clone())
            .unwrap_or_else(|| crate::state::platform().to_owned())
    }

    fn version(&self) -> String {
        self.version
            .read()
            .ok()
            .and_then(|v| v.clone())
            .unwrap_or_else(|| APP_VERSION.to_owned())
    }

    fn now(&self) -> i64 {
        self.clock
            .read()
            .ok()
            .and_then(|c| *c)
            .unwrap_or_else(up::now_unix)
    }

    fn install_supported(&self) -> bool {
        matches!(
            self.platform().as_str(),
            "windows-x64" | "macos-arm64" | "macos-x64"
        )
    }
}

fn iso(secs: i64) -> String {
    crate::agency::iso_from_unix(secs.max(0) as u64, 0)
}

/// The app bundle this process runs from (`…/Name.app/Contents/MacOS/<exe>`), if it is one.
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
    bundle
        .extension()
        .is_some_and(|e| e == "app")
        .then_some(bundle)
}

/// macOS runs a downloaded app that was never moved from a randomized read-only copy ("App Translocation"), and a
/// disk image is read-only: neither can be replaced in place.
fn bundle_replaceable(bundle: &Path) -> bool {
    let text = bundle.to_string_lossy();
    if text.contains("/AppTranslocation/") || text.starts_with("/Volumes/") {
        return false;
    }
    bundle
        .parent()
        .and_then(|p| std::fs::metadata(p).ok())
        .is_some_and(|m| !m.permissions().readonly())
}

/// Starts the verified Windows installer in passive mode (`/P`), as an update of the per-user install (`/UPDATE`),
/// asking it to start the manager again when it is done (`/R`).
pub fn run_installer(path: &Path) -> Result<(), IpcError> {
    std::process::Command::new(path)
        .args(up::WINDOWS_INSTALLER_ARGS)
        .spawn()
        .map(|_| ())
        .map_err(|_| UPDATE_INSTALL_FAILED)
}

impl AppState {
    fn updates_dir(&self) -> PathBuf {
        self.paths.data.join("updates")
    }

    fn update_state_path(&self) -> PathBuf {
        self.updates_dir().join("state.json")
    }

    fn update_downloads(&self) -> PathBuf {
        self.updates_dir().join("downloads")
    }

    fn update_preference(&self, key: &str) -> Option<Value> {
        self.store()
            .ok()
            .and_then(|s| s.get_setting(key).ok())
            .map(|v| v.value)
    }

    pub fn update_channel(&self) -> String {
        self.update_preference(settings::UPDATE_CHANNEL)
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|c| up::CHANNELS.contains(&c.as_str()))
            .unwrap_or_else(|| "stable".into())
    }

    fn update_automatic(&self) -> bool {
        self.update_preference(settings::UPDATE_AUTOMATIC) != Some(Value::Bool(false))
    }

    /// Revoked runtime archives (SHA-256) named by the last accepted manifest (milestone 12, runtime revocation).
    pub fn revoked_runtime_sha256(&self) -> Vec<String> {
        UpdateState::load(&self.update_state_path()).revoked_runtime_sha256
    }

    /// Whether a browser runtime archive was revoked (never installed, never opened).
    pub fn runtime_revoked(&self, sha256: &str) -> bool {
        !sha256.is_empty()
            && self
                .revoked_runtime_sha256()
                .iter()
                .any(|h| h.eq_ignore_ascii_case(sha256))
    }

    pub fn update_status(&self) -> UpdateStatus {
        let u = &self.updates;
        let channel = self.update_channel();
        let configured = !u.keys().is_empty();
        let mut s = UpdateStatus {
            configured,
            install_supported: u.install_supported(),
            current_version: u.version(),
            platform: u.platform(),
            channel: channel.clone(),
            automatic: self.update_automatic(),
            phase: Phase::Idle,
            checked_at: None,
            latest_version: None,
            available: None,
            paused: false,
            blocked: None,
            manifest_expires_at: None,
            progress: None,
            error: None,
        };
        let Ok(i) = u.inner.lock() else {
            return s;
        };
        let checking = i.phase == Some(Phase::Checking);
        if i.channel.as_deref() != Some(channel.as_str()) && !checking {
            return s;
        }
        s.phase = i.phase.unwrap_or(Phase::Idle);
        s.checked_at = i.checked_at.map(iso);
        s.latest_version = i.latest_version.clone();
        s.paused = i.paused;
        s.blocked = i.blocked.clone();
        s.manifest_expires_at = i.expires_at.clone();
        s.available = i.offer.as_ref().map(|o| AvailableUpdate {
            version: o.version.clone(),
            notes_url: o.notes_url.clone(),
            size_bytes: o.artifact.size_bytes,
        });
        s.progress = i.progress;
        s.error = i.error.clone().map(UpdateErrorView::from);
        s
    }

    fn emit_update(&self) {
        let status = self.update_status();
        if let Ok(v) = serde_json::to_value(status) {
            self.events.emit_json(events::UPDATE, v);
        }
    }

    fn with_inner(&self, f: impl FnOnce(&mut Inner)) {
        if let Ok(mut i) = self.updates.inner.lock() {
            f(&mut i);
        }
    }

    /// Fetches, verifies and judges the selected channel's manifest. Problems are reported in the returned status
    /// (`phase: failed`, `error`), never by trusting older information: a failed check withdraws the offer.
    pub fn update_check(&self) -> Result<UpdateStatus, IpcError> {
        let u = &self.updates;
        let keys = u.keys();
        if keys.is_empty() {
            return Err(UPDATES_NOT_CONFIGURED);
        }
        let channel = self.update_channel();
        {
            let mut i = u.inner.lock().map_err(|_| ipc::INTERNAL)?;
            if i.busy {
                return Err(UPDATE_BUSY);
            }
            i.busy = true;
            i.phase = Some(Phase::Checking);
            i.error = None;
        }
        self.emit_update();
        let state_path = self.update_state_path();
        let mut st = UpdateState::load(&state_path);
        self.with_inner(|i| {
            for (ch, seq) in &i.sequences {
                let e = st.sequences.entry(ch.clone()).or_insert(0);
                *e = (*e).max(*seq);
            }
        });
        let now = u.now();
        let check = || {
            up::check_channel(
                u.transport().as_ref(),
                &keys,
                &channel,
                &u.version(),
                &u.platform(),
                &st,
                now,
            )
        };
        let mut result = check();
        if matches!(result, Err(AppUpdateError::BadSignature)) {
            std::thread::sleep(u.retry_delay.read().map(|d| *d).unwrap_or_default());
            result = check();
        }
        match result {
            Ok(a) => {
                st.accept(&a);
                // If it cannot be saved (disk full), this session still remembers the sequence.
                let _ = st.save(&state_path);
                let mut discard = None;
                self.with_inner(|i| {
                    i.sequences = st.sequences.clone();
                    // A downloaded update stays ready only while the channel still offers exactly that file.
                    let keep = match (&i.ready, &a.offer) {
                        (Some(r), Some(o)) => r.channel == channel && r.offer == *o,
                        _ => false,
                    };
                    if !keep {
                        discard = i.ready.take().map(|r| r.downloaded.path);
                    }
                    i.channel = Some(channel.clone());
                    i.checked_at = Some(now);
                    i.latest_version = a.latest_version.clone();
                    i.paused = a.paused;
                    i.blocked = a.current_blocked.clone();
                    i.expires_at = Some(a.expires_at.clone());
                    i.offer = a.offer.clone();
                    i.progress = None;
                    i.error = None;
                    i.phase = Some(if i.ready.is_some() {
                        Phase::Ready
                    } else if i.offer.is_some() {
                        Phase::Available
                    } else {
                        Phase::UpToDate
                    });
                    i.busy = false;
                });
                if discard.is_some() || a.offer.is_none() {
                    // Withdrawn, paused, revoked or superseded downloads are deleted (never installed later).
                    up::clean_downloads(&self.update_downloads(), None);
                }
            }
            Err(e) => {
                let err = error_of(&e);
                let mut discard = false;
                self.with_inner(|i| {
                    i.channel = Some(channel.clone());
                    i.checked_at = Some(now);
                    i.offer = None;
                    // A ready download is kept only if it came from a check that the new one does not contradict:
                    // after a signature, freshness or replay failure nothing is installed until a good check.
                    discard = i.ready.take().is_some();
                    i.progress = None;
                    i.error = Some(err.clone());
                    i.phase = Some(Phase::Failed);
                    i.busy = false;
                });
                if discard {
                    up::clean_downloads(&self.update_downloads(), None);
                }
            }
        }
        self.emit_update();
        Ok(self.update_status())
    }

    /// Downloads the offered update in the background (resuming an interrupted download), then verifies it. The
    /// `operation` and `update` events report progress.
    pub fn update_download(self: &Arc<Self>) -> Result<UpdateStatus, IpcError> {
        let u = &self.updates;
        let channel = self.update_channel();
        let offer = {
            let mut i = u.inner.lock().map_err(|_| ipc::INTERNAL)?;
            if i.busy {
                return Err(UPDATE_BUSY);
            }
            if i.channel.as_deref() != Some(channel.as_str()) {
                return Err(UPDATE_NOT_AVAILABLE);
            }
            if i.ready.is_some() {
                drop(i);
                return Ok(self.update_status());
            }
            let offer = i.offer.clone().ok_or(UPDATE_NOT_AVAILABLE)?;
            i.busy = true;
            i.phase = Some(Phase::Downloading);
            i.error = None;
            i.progress = Some(DownloadProgress {
                received: 0,
                total: offer.artifact.size_bytes,
            });
            offer
        };
        u.cancel.store(false, Ordering::SeqCst);
        let op = self
            .ops
            .start(OpKind::DownloadUpdate, Some(offer.version.clone()));
        self.emit_update();
        let this = self.clone();
        std::thread::spawn(move || this.run_download(op, offer, channel));
        Ok(self.update_status())
    }

    fn run_download(self: Arc<Self>, op: String, offer: Offer, channel: String) {
        let u = &self.updates;
        let keys = u.keys();
        let dir = self.update_downloads();
        let mut last_emit = Instant::now();
        let mut progress = |received: u64, total: u64| {
            self.with_inner(|i| i.progress = Some(DownloadProgress { received, total }));
            if last_emit.elapsed() >= Duration::from_millis(250) || received == total {
                last_emit = Instant::now();
                self.ops
                    .progress(&op, (received as f64 / total.max(1) as f64) as f32);
                self.emit_update();
            }
        };
        let result = up::download_verified(
            u.transport().as_ref(),
            &keys,
            &offer,
            &dir,
            u.now(),
            &u.cancel,
            &mut progress,
        );
        match result {
            Ok(d) => {
                up::clean_downloads(&dir, Some(&d.path));
                self.ops.succeed(&op);
                self.with_inner(|i| {
                    i.progress = None;
                    i.error = None;
                    i.ready = Some(Ready {
                        downloaded: d,
                        offer: offer.clone(),
                        channel: channel.clone(),
                    });
                    i.phase = Some(Phase::Ready);
                    i.busy = false;
                });
            }
            Err(e) => {
                let err = error_of(&e);
                self.ops.fail(&op, err.code, err.message);
                self.with_inner(|i| {
                    i.progress = None;
                    i.error = Some(err.clone());
                    i.phase = Some(if matches!(e, AppUpdateError::Cancelled) {
                        Phase::Available
                    } else {
                        Phase::Failed
                    });
                    i.busy = false;
                });
            }
        }
        self.emit_update();
    }

    /// Stops a running download; its part is kept, so the next download continues from there.
    pub fn update_cancel(&self) -> UpdateStatus {
        self.updates.cancel.store(true, Ordering::SeqCst);
        self.update_status()
    }

    /// Prepares the downloaded update for installing: profiles must be closed, the file is verified once more (a
    /// change after the download is refused), and on macOS the app bundle is replaced (the old one is restored if
    /// that fails). The shell then runs the installer or restarts.
    pub fn update_install(&self) -> Result<InstallPlan, IpcError> {
        let u = &self.updates;
        let channel = self.update_channel();
        let (path, offer) = {
            let i = u.inner.lock().map_err(|_| ipc::INTERNAL)?;
            if i.busy {
                return Err(UPDATE_BUSY);
            }
            match &i.ready {
                Some(r) if r.channel == channel => (r.downloaded.path.clone(), r.offer.clone()),
                _ => return Err(UPDATE_NOT_READY),
            }
        };
        if !u.install_supported() {
            return Err(UPDATE_UNSUPPORTED);
        }
        if self.supervisor.running_count() > 0 {
            return Err(UPDATE_PROFILES_OPEN);
        }
        if self.installing.load(Ordering::SeqCst) {
            return Err(UPDATE_BUSY);
        }
        if let Err(e) = up::verify_artifact_file(&path, &offer, &u.keys(), u.now()) {
            let err = error_of(&e);
            let _ = std::fs::remove_file(&path);
            self.with_inner(|i| {
                i.ready = None;
                i.error = Some(err.clone());
                i.phase = Some(if i.offer.is_some() {
                    Phase::Available
                } else {
                    Phase::Failed
                });
            });
            self.emit_update();
            return Err(err);
        }
        match offer.artifact.kind.as_str() {
            "nsis" if u.platform() == "windows-x64" => Ok(InstallPlan::RunInstaller(path)),
            "app-tar-gz" if u.platform().starts_with("macos-") => {
                let bundle = u
                    .bundle
                    .read()
                    .ok()
                    .and_then(|b| b.clone())
                    .or_else(running_bundle)
                    .ok_or(UPDATE_UNSUPPORTED)?;
                if !bundle_replaceable(&bundle) {
                    return Err(UPDATE_MOVE_APP);
                }
                up::install_app_bundle(&path, &bundle, &offer.version).map_err(|e| error_of(&e))?;
                let _ = std::fs::remove_file(&path);
                self.with_inner(|i| i.ready = None);
                Ok(InstallPlan::Restart)
            }
            _ => Err(UPDATE_UNSUPPORTED),
        }
    }

    /// Automatic checks (setting `updates.automatic`, on by default): shortly after start and then every few hours;
    /// an offered update is downloaded in the background. Installing always waits for the person.
    pub fn start_update_worker(self: &Arc<Self>) {
        if self.updates.keys().is_empty() || self.updates.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                if this.update_automatic()
                    && let Ok(s) = this.update_check()
                    && s.phase == Phase::Available
                {
                    let _ = this.update_download();
                }
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
    }

    // ----------------------------------------------------------------------------------- test hooks
    /// Tests: trust these release keys instead of the compiled-in ones.
    pub fn use_release_keys(&self, json: &str) -> Result<(), String> {
        let k = ReleaseKeys::parse(json).map_err(|e| e.to_string())?;
        if let Ok(mut slot) = self.updates.keys.write() {
            *slot = Arc::new(k);
        }
        Ok(())
    }

    /// Tests: reach the release host through this transport.
    pub fn use_update_transport(&self, t: Arc<dyn Transport>) {
        if let Ok(mut slot) = self.updates.transport.write() {
            *slot = t;
        }
    }

    /// Tests: act as this platform, version and time, and replace this bundle on macOS.
    pub fn set_update_environment(
        &self,
        platform: &str,
        version: &str,
        now: i64,
        bundle: Option<PathBuf>,
    ) {
        let u = &self.updates;
        if let Ok(mut p) = u.platform.write() {
            *p = Some(platform.to_owned());
        }
        if let Ok(mut v) = u.version.write() {
            *v = Some(version.to_owned());
        }
        if let Ok(mut c) = u.clock.write() {
            *c = Some(now);
        }
        if let Ok(mut b) = u.bundle.write() {
            *b = bundle;
        }
        if let Ok(mut d) = u.retry_delay.write() {
            *d = Duration::ZERO;
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn the_compiled_in_release_keys_parse() {
        ReleaseKeys::parse(RELEASE_KEYS_JSON).expect("release-keys.json must be valid");
    }

    #[test]
    fn translocated_and_disk_image_apps_are_not_replaced() {
        assert!(!bundle_replaceable(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Project Browser.app"
        )));
        assert!(!bundle_replaceable(Path::new(
            "/Volumes/Project Browser/Project Browser.app"
        )));
        let dir = tempfile::tempdir().unwrap();
        assert!(bundle_replaceable(&dir.path().join("Project Browser.app")));
    }
}
