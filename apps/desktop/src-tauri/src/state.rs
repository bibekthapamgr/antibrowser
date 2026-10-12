//! Application state and the logic behind every IPC command. Commands in `commands.rs` are thin wrappers that
//! check the caller and delegate here, so the behaviour is unit-testable without a webview.

use crate::events::{EventSink, PROFILES_CHANGED};
use crate::ipc::{self, IpcError, limits};
use crate::operations::{OpKind, Operations, Started};
use crate::recovery::{self, SessionInfo};
use crate::secrets::KeychainStatus;
use crate::supervisor::{
    GRACEFUL_TIMEOUT, ReconcileReport, RunningProfile, StopOutcome, Supervisor,
};
use pb_runtime::{
    BrowserInstall, LaunchRequest, Launcher, ProcessInspector, ProfileId, ProfileState,
    ProfilesRoot, WorkspaceId, prepare_launch,
};
use pb_storage::settings::{self, SettingValue};
use pb_storage::{
    LocalProfile, LocalStore, NewProfile, ProfileUpdate, RuntimeInstallation, StoreError, Workspace,
};
use pb_update::install::{FsSpace, Installer, Stage};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Called with the number of open profiles whenever it changes (tray text).
pub type RunningListener = Box<dyn Fn(usize) + Send + Sync>;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", _) => "windows-x64",
        ("macos", "aarch64") => "macos-arm64",
        ("macos", _) => "macos-x64",
        _ => "linux-x64",
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoreFailure {
    pub code: &'static str,
    pub from_version: Option<i64>,
    pub to_version: Option<i64>,
    pub backup_available: bool,
    #[serde(skip)]
    pub backup: Option<PathBuf>,
}

pub enum StoreSlot {
    Ready(Arc<LocalStore>),
    Failed(StoreFailure),
}

pub struct Paths {
    pub data: PathBuf,
    pub db: PathBuf,
    pub profiles: PathBuf,
    pub runtimes: PathBuf,
}

pub struct AppState {
    pub paths: Paths,
    pub root: ProfilesRoot,
    store: RwLock<StoreSlot>,
    pub supervisor: Arc<Supervisor>,
    pub ops: Arc<Operations>,
    pub events: Arc<dyn EventSink>,
    launcher: Arc<dyn Launcher>,
    browser: RwLock<Option<BrowserInstall>>,
    pub session: SessionInfo,
    crash_acknowledged: AtomicBool,
    pub keychain: RwLock<KeychainStatus>,
    pub started: Instant,
    ui_ready_recorded: AtomicBool,
    launch_lock: Mutex<()>,
    pub reconcile: ReconcileReport,
    /// Set by the shell to refresh the tray's running-profile count.
    pub on_running_changed: RwLock<Option<RunningListener>>,
}

// ----------------------------------------------------------------------------- views returned over IPC
#[derive(Serialize)]
pub struct ProfileView {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub client_label: Option<String>,
    pub notes: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    /// closed | running | stopping
    pub status: &'static str,
    pub pid: Option<u32>,
    /// Running since before this manager instance started (the manager was closed or crashed meanwhile).
    pub adopted: bool,
}

#[derive(Serialize)]
pub struct AppView {
    pub app: Value,
    pub store: Value,
    pub first_run: bool,
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    pub settings: Vec<SettingValue>,
    pub recovery: Value,
    pub keychain: KeychainStatus,
    pub running_count: usize,
}

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub browser: Value,
    pub installations: Vec<RuntimeInstallation>,
    pub interrupted: Vec<Value>,
    pub quarantined: usize,
    pub running: Vec<RunningProfile>,
    pub operations: Vec<crate::operations::Operation>,
    pub manager_updates: Value,
}

impl AppState {
    pub fn build(
        data_dir: &Path,
        browser: Option<BrowserInstall>,
        launcher: Arc<dyn Launcher>,
        inspector: Arc<dyn ProcessInspector>,
        events: Arc<dyn EventSink>,
    ) -> Result<Arc<Self>, String> {
        let paths = Paths {
            data: data_dir.to_path_buf(),
            db: data_dir.join("local.db"),
            profiles: data_dir.join("profiles"),
            runtimes: data_dir.join("runtimes"),
        };
        std::fs::create_dir_all(&paths.profiles)
            .map_err(|e| format!("cannot create profiles dir: {e}"))?;
        let root = ProfilesRoot::open(&paths.profiles).map_err(|e| e.to_string())?;
        let insp = inspector.clone();
        let session = recovery::begin_session(&paths.data, APP_VERSION, move |pid| {
            insp.inspect(pid).is_some()
        });
        let supervisor = Arc::new(Supervisor::new(inspector));

        let t0 = Instant::now();
        let slot = open_slot(&paths.db);
        let mut reconcile = ReconcileReport::default();
        if let StoreSlot::Ready(store) = &slot {
            let _ = store.record_timing("store_open_ms", t0.elapsed().as_secs_f64() * 1000.0);
            let _ = store.ensure_device(platform(), std::env::consts::ARCH);
            reconcile = supervisor.reconcile_on_startup(store);
        }

        Ok(Arc::new(Self {
            paths,
            root,
            store: RwLock::new(slot),
            supervisor,
            ops: Arc::new(Operations::new(events.clone())),
            events,
            launcher,
            browser: RwLock::new(browser),
            session,
            crash_acknowledged: AtomicBool::new(false),
            keychain: RwLock::new(KeychainStatus {
                available: false,
                reason: Some("not_checked_yet"),
            }),
            started: Instant::now(),
            ui_ready_recorded: AtomicBool::new(false),
            launch_lock: Mutex::new(()),
            reconcile,
            on_running_changed: RwLock::new(None),
        }))
    }

    pub fn store(&self) -> Result<Arc<LocalStore>, IpcError> {
        match &*self.store.read().map_err(|_| ipc::INTERNAL)? {
            StoreSlot::Ready(s) => Ok(s.clone()),
            StoreSlot::Failed(_) => Err(ipc::STORE_UNAVAILABLE),
        }
    }

    fn store_failure(&self) -> Option<StoreFailure> {
        match &*self.store.read().ok()? {
            StoreSlot::Failed(f) => Some(f.clone()),
            StoreSlot::Ready(_) => None,
        }
    }

    pub fn notify_running_changed(&self) {
        let n = self.supervisor.running_count();
        self.events
            .emit_json(PROFILES_CHANGED, json!({ "running": n }));
        if let Ok(guard) = self.on_running_changed.read()
            && let Some(f) = guard.as_ref()
        {
            f(n);
        }
    }

    fn active_workspace(&self, store: &LocalStore) -> Result<Option<WorkspaceId>, IpcError> {
        let value = store.get_setting(settings::ACTIVE_WORKSPACE)?.value;
        let Some(id) = value.as_str().and_then(|s| WorkspaceId::parse(s).ok()) else {
            return Ok(None);
        };
        Ok(store.get_workspace(&id)?.map(|w| w.id))
    }

    fn view(&self, p: LocalProfile) -> ProfileView {
        let running = self.supervisor.running();
        let r = running.iter().find(|r| r.profile_id == p.id.as_str());
        ProfileView {
            id: p.id.to_string(),
            workspace_id: p.workspace_id.map(|w| w.to_string()),
            name: p.name,
            client_label: p.client_label,
            notes: p.notes,
            version: p.version,
            created_at: p.created_at,
            updated_at: p.updated_at,
            status: match r {
                Some(r) if r.stopping => "stopping",
                Some(_) => "running",
                None => "closed",
            },
            pid: r.map(|r| r.pid),
            adopted: r.is_some_and(|r| r.adopted),
        }
    }

    // ------------------------------------------------------------------------- app & workspaces
    pub fn app_view(&self) -> AppView {
        let failure = self.store_failure();
        let store = self.store().ok();
        let workspaces = store
            .as_ref()
            .and_then(|s| s.list_workspaces().ok())
            .unwrap_or_default();
        let active = store
            .as_ref()
            .and_then(|s| self.active_workspace(s).ok().flatten())
            .map(|w| w.to_string());
        let installer = Installer {
            root: self.paths.runtimes.clone(),
            space: &FsSpace,
        };
        AppView {
            app: json!({ "version": APP_VERSION, "platform": platform(), "arch": std::env::consts::ARCH }),
            store: match &failure {
                None => json!({ "status": "ready" }),
                Some(f) => json!({ "status": "failed", "failure": f }),
            },
            first_run: failure.is_none() && workspaces.is_empty(),
            workspaces,
            active_workspace_id: active,
            settings: store
                .as_ref()
                .and_then(|s| s.get_settings().ok())
                .unwrap_or_default(),
            recovery: json!({
                "previous_session_crashed": self.session.previous_session_crashed
                    && !self.crash_acknowledged.load(Ordering::Relaxed),
                "crash_reports": recovery::list_reports(&self.paths.data).len(),
                "adopted_profiles": self.reconcile.adopted,
                "cleared_stale_processes": self.reconcile.cleared,
                "interrupted_installs": installer.interrupted().map(|v| v.len()).unwrap_or(0),
            }),
            keychain: self
                .keychain
                .read()
                .map(|k| k.clone())
                .unwrap_or(KeychainStatus {
                    available: false,
                    reason: Some("unknown"),
                }),
            running_count: self.supervisor.running_count(),
        }
    }

    pub fn create_workspace(&self, name: &str) -> Result<Workspace, IpcError> {
        let name = ipc::clean_text(
            name,
            limits::WORKSPACE_NAME_CHARS,
            ipc::INVALID_WORKSPACE_NAME,
        )?;
        let store = self.store()?;
        let ws = store.create_workspace(&name)?;
        if self.active_workspace(&store)?.is_none() {
            store.set_setting(
                settings::ACTIVE_WORKSPACE,
                &json!(ws.id.as_str()),
                false,
                None,
            )?;
        }
        Ok(ws)
    }

    pub fn set_active_workspace(&self, workspace_id: &str) -> Result<(), IpcError> {
        let id = WorkspaceId::parse(workspace_id).map_err(|_| ipc::UNKNOWN_WORKSPACE)?;
        let store = self.store()?;
        store.get_workspace(&id)?.ok_or(ipc::UNKNOWN_WORKSPACE)?;
        store.set_setting(settings::ACTIVE_WORKSPACE, &json!(id.as_str()), false, None)?;
        Ok(())
    }

    // ------------------------------------------------------------------------- profiles
    pub fn list_profiles(
        &self,
        query: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<ProfileView>, IpcError> {
        if query.is_some_and(|q| {
            q.len() > limits::QUERY_CHARS * 4 || q.chars().count() > limits::QUERY_CHARS
        }) {
            return Err(ipc::QUERY_TOO_LONG);
        }
        let store = self.store()?;
        let Some(ws) = self.active_workspace(&store)? else {
            return Ok(vec![]);
        };
        let rows = store.search_profiles(Some(&ws), query, limit.unwrap_or(100))?;
        Ok(rows.into_iter().map(|p| self.view(p)).collect())
    }

    pub fn create_profile(
        &self,
        name: &str,
        client_label: Option<&str>,
    ) -> Result<ProfileView, IpcError> {
        let name = ipc::clean_text(name, limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let client = client_label
            .filter(|c| !c.trim().is_empty())
            .map(|c| ipc::clean_text(c, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let store = self.store()?;
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let p = store.insert_profile(NewProfile {
            id: &id,
            workspace_id: Some(&ws),
            name: &name,
            client_label: client.as_deref(),
            folder_label: None,
        })?;
        Ok(self.view(p))
    }

    pub fn update_profile(
        &self,
        profile_id: &ProfileId,
        expected_version: i64,
        name: Option<&str>,
        client_label: Option<&str>,
        clear_client_label: bool,
        notes: Option<&str>,
    ) -> Result<ProfileView, IpcError> {
        let name = name
            .map(|n| ipc::clean_text(n, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let client = client_label
            .map(|c| ipc::clean_text(c, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let notes = notes.map(ipc::clean_notes).transpose()?;
        let store = self.store()?;
        let p = store.update_profile(
            profile_id,
            ProfileUpdate {
                name: name.as_deref(),
                client_label: if clear_client_label {
                    Some(None)
                } else {
                    client.as_deref().map(Some)
                },
                notes: notes.as_deref(),
            },
            expected_version,
        )?;
        Ok(self.view(p))
    }

    // ------------------------------------------------------------------------- lifecycle
    pub fn launch_profile(
        self: &Arc<Self>,
        profile_id: &ProfileId,
        start_url: Option<&str>,
    ) -> Result<Started, IpcError> {
        if start_url.is_some_and(|u| u.len() > limits::URL_BYTES) {
            return Err(pb_runtime::LaunchError::BadStartUrl.into());
        }
        let store = self.store()?;
        let _guard = self.launch_lock.lock().map_err(|_| ipc::INTERNAL)?;
        let exists = store.get_profile(profile_id)?.is_some();
        let browser = self.browser.read().map_err(|_| ipc::INTERNAL)?.clone();
        // Every check happens here, before any process exists (milestone 01 step 5 / 02 step 2).
        let spec = prepare_launch(
            &self.root,
            browser.as_ref(),
            ProfileState {
                exists,
                running: self.supervisor.is_running(profile_id),
            },
            LaunchRequest {
                profile_id,
                start_url,
            },
        )?;
        let op = self
            .ops
            .start(OpKind::LaunchProfile, Some(profile_id.to_string()));
        let t0 = Instant::now();
        let spawned = match self.launcher.spawn(&spec) {
            Ok(s) => {
                // Browser process start is measured on its own, never folded into manager start-up time.
                if let Ok(store) = self.store() {
                    let _ = store
                        .record_timing("browser_spawn_ms", t0.elapsed().as_secs_f64() * 1000.0);
                }
                s
            }
            Err(e) => {
                let err = IpcError::from(e);
                self.ops.fail(&op, err.code, err.message);
                return Ok(Started { operation_id: op });
            }
        };
        let exe = spec.executable.to_string_lossy().into_owned();
        self.supervisor
            .register(&store, profile_id, spawned, &exe)?;
        self.notify_running_changed();

        // Confirm in the background that the browser did not exit immediately (e.g. a broken runtime).
        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let exited = this.supervisor.poll(&store);
            if exited.contains(&id) {
                this.ops.fail(
                    &op_id,
                    "EXITED_EARLY",
                    "The browser closed right after starting.",
                );
                this.notify_running_changed();
            } else {
                this.ops.succeed(&op_id);
            }
        });
        Ok(Started { operation_id: op })
    }

    pub fn stop_profile(self: &Arc<Self>, profile_id: &ProfileId) -> Result<Started, IpcError> {
        let store = self.store()?;
        if !self.supervisor.is_running(profile_id) {
            return Err(ipc::NOT_RUNNING);
        }
        let op = self
            .ops
            .start(OpKind::StopProfile, Some(profile_id.to_string()));
        let this = self.clone();
        let id = profile_id.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            this.notify_running_changed();
            match this.supervisor.stop(&store, &id, GRACEFUL_TIMEOUT) {
                StopOutcome::Stopped | StopOutcome::NotRunning | StopOutcome::Forced => {
                    this.ops.succeed(&op_id)
                }
                StopOutcome::StillRunning => {
                    this.ops
                        .fail(&op_id, "STOP_FAILED", "The profile could not be closed.")
                }
            }
            this.notify_running_changed();
        });
        Ok(Started { operation_id: op })
    }

    /// Gracefully closes every running profile. `then` runs after all have stopped (used by "close all and quit").
    pub fn close_all(
        self: &Arc<Self>,
        then: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<Started, IpcError> {
        let store = self.store()?;
        let op = self.ops.start(OpKind::CloseAll, None);
        let this = self.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            let ids = this.supervisor.running_ids();
            let total = ids.len().max(1) as f32;
            let mut failed = false;
            for (i, id) in ids.iter().enumerate() {
                if this.supervisor.stop(&store, id, GRACEFUL_TIMEOUT) == StopOutcome::StillRunning {
                    failed = true;
                }
                this.ops.progress(&op_id, (i + 1) as f32 / total);
                this.notify_running_changed();
            }
            if failed {
                this.ops
                    .fail(&op_id, "STOP_FAILED", "Some profiles could not be closed.");
            } else {
                this.ops.succeed(&op_id);
                if let Some(f) = then {
                    f();
                }
            }
        });
        Ok(Started { operation_id: op })
    }

    pub fn runtime_status(&self) -> RuntimeStatus {
        let installer = Installer {
            root: self.paths.runtimes.clone(),
            space: &FsSpace,
        };
        let browser = self.browser.read().ok().and_then(|b| b.clone());
        RuntimeStatus {
            browser: match browser {
                Some(b) => {
                    json!({ "configured": true, "source": "development_override", "revision": b.revision })
                }
                None => json!({ "configured": false, "source": "none", "revision": null }),
            },
            installations: self
                .store()
                .ok()
                .and_then(|s| s.list_runtimes().ok())
                .unwrap_or_default(),
            interrupted: installer
                .interrupted()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|i| {
                    let id = i.dir.file_name()?.to_string_lossy().into_owned();
                    let stage = i.journal.map(|j| j.stage).unwrap_or(Stage::Copying);
                    Some(json!({ "id": id, "stage": stage }))
                })
                .collect(),
            quarantined: installer.quarantined().map(|q| q.len()).unwrap_or(0),
            running: self.supervisor.running(),
            operations: self.ops.list(),
            manager_updates: json!({
                "channel": "internal",
                "automatic": false,
                "note": "Signed update channels arrive in milestone 12."
            }),
        }
    }

    // ------------------------------------------------------------------------- settings
    pub fn update_setting(
        &self,
        key: &str,
        value: &Value,
        expected_version: Option<i64>,
    ) -> Result<SettingValue, IpcError> {
        if serde_json::to_string(value)
            .map(|s| s.len())
            .unwrap_or(usize::MAX)
            > limits::SETTING_VALUE_BYTES
        {
            return Err(ipc::INVALID_ARGUMENT);
        }
        let store = self.store()?;
        if key == settings::ACTIVE_WORKSPACE
            && let Some(id) = value.as_str()
        {
            let ws = WorkspaceId::parse(id).map_err(|_| ipc::UNKNOWN_WORKSPACE)?;
            store.get_workspace(&ws)?.ok_or(ipc::UNKNOWN_WORKSPACE)?;
        }
        Ok(store.set_setting(key, value, true, expected_version)?)
    }

    /// Validates and saves a folder chosen in the native dialog.
    pub fn set_download_directory(&self, chosen: &Path) -> Result<String, IpcError> {
        if !chosen.is_absolute()
            || std::fs::symlink_metadata(chosen)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true)
        {
            return Err(ipc::INVALID_DIRECTORY);
        }
        let dir = std::fs::canonicalize(chosen).map_err(|_| ipc::INVALID_DIRECTORY)?;
        let data = std::fs::canonicalize(&self.paths.data).map_err(|_| ipc::INTERNAL)?;
        if !dir.is_dir() || dir.starts_with(&data) || data.starts_with(&dir) {
            return Err(ipc::INVALID_DIRECTORY);
        }
        let probe = dir.join(format!(
            ".pb-write-test-{}",
            pb_runtime::random_hex(6).map_err(|_| ipc::INTERNAL)?
        ));
        std::fs::write(&probe, b"").map_err(|_| ipc::INVALID_DIRECTORY)?;
        let _ = std::fs::remove_file(&probe);
        let text = dir.to_string_lossy().into_owned();
        self.store()?
            .set_setting(settings::DOWNLOAD_DIR, &json!(text), false, None)?;
        Ok(text)
    }

    // ------------------------------------------------------------------------- diagnostics & timings
    pub fn report_ui_ready(&self) -> Result<Option<f64>, IpcError> {
        if self.ui_ready_recorded.swap(true, Ordering::SeqCst) {
            return Ok(None); // only the first call per process counts
        }
        let ms = self.started.elapsed().as_secs_f64() * 1000.0;
        self.store()?.record_timing("manager_startup_ms", ms)?;
        Ok(Some(ms))
    }

    pub fn diagnostics(&self) -> Value {
        let store = self.store().ok();
        let summary = |k: &str| store.as_ref().and_then(|s| s.timing_summary(k).ok());
        let own = self.supervisor.inspector().inspect(std::process::id());
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        json!({
            "app": { "version": APP_VERSION, "platform": platform(), "os": sysinfo::System::long_os_version(),
                     "arch": std::env::consts::ARCH },
            "data_directory": recovery::scrub(&self.paths.data.to_string_lossy()),
            "store": {
                "status": if store.is_some() { "ready" } else { "failed" },
                "schema_version": store.as_ref().and_then(|s| s.schema_version().ok()),
                "journal_mode": store.as_ref().and_then(|s| s.journal_mode().ok()),
                "foreign_keys": store.as_ref().and_then(|s| s.foreign_keys_enabled().ok()),
                "integrity_ok": store.as_ref().and_then(|s| s.integrity_ok().ok()),
                "failure": self.store_failure(),
            },
            "disk_free_bytes": fs4::available_space(&self.paths.data).ok(),
            "keychain": self.keychain.read().map(|k| k.clone()).ok(),
            // Manager and browser measurements are kept separate (milestone 02 acceptance).
            "manager": {
                "uptime_s": self.started.elapsed().as_secs(),
                "rss_bytes": own.map(|o| o.memory_bytes),
                "startup_ms": summary("manager_startup_ms"),
                "store_open_ms": summary("store_open_ms"),
            },
            "browsers": {
                "running": self.supervisor.running_count(),
                "main_process_rss_bytes": self.supervisor.browser_memory_bytes(),
                "spawn_ms": summary("browser_spawn_ms"),
            },
            "system_memory_bytes": sys.total_memory(),
            "crash_reports": recovery::list_reports(&self.paths.data).len(),
            "previous_session_crashed": self.session.previous_session_crashed,
            "reconcile": self.reconcile,
        })
    }

    // ------------------------------------------------------------------------- recovery
    pub fn recovery_action(&self, action: &str, target: Option<&str>) -> Result<(), IpcError> {
        match action {
            "dismiss_crash" => {
                self.crash_acknowledged.store(true, Ordering::Relaxed);
                Ok(())
            }
            "retry_open" => self.reopen(),
            "restore_backup" => {
                let failure = self.store_failure().ok_or(ipc::INVALID_ARGUMENT)?;
                let backup = failure.backup.ok_or(ipc::INVALID_ARGUMENT)?;
                LocalStore::restore_backup(&self.paths.db, &backup).map_err(IpcError::from)?;
                self.reopen()
            }
            "discard_interrupted" => {
                let slug = target.filter(|t| {
                    !t.is_empty()
                        && t.len() <= 64
                        && t.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                });
                let slug = slug.ok_or(ipc::INVALID_ARGUMENT)?;
                let installer = Installer {
                    root: self.paths.runtimes.clone(),
                    space: &FsSpace,
                };
                installer
                    .discard_interrupted(&self.paths.runtimes.join("staging").join(slug))
                    .map_err(|_| ipc::INVALID_ARGUMENT)
            }
            _ => Err(ipc::INVALID_ARGUMENT),
        }
    }

    fn reopen(&self) -> Result<(), IpcError> {
        let slot = open_slot(&self.paths.db);
        let ok = matches!(slot, StoreSlot::Ready(_));
        if let StoreSlot::Ready(s) = &slot {
            let _ = s.ensure_device(platform(), std::env::consts::ARCH);
        }
        *self.store.write().map_err(|_| ipc::INTERNAL)? = slot;
        if ok {
            Ok(())
        } else {
            Err(ipc::STORE_UNAVAILABLE)
        }
    }

    /// Deletes every local profile and the local database ("clear uninstall choice" on platforms without an
    /// uninstaller). The caller restarts the app afterwards.
    pub fn remove_local_data(&self, confirm: &str) -> Result<(), IpcError> {
        if confirm != "DELETE" {
            return Err(ipc::CONFIRMATION_REQUIRED);
        }
        if self.supervisor.running_count() > 0 {
            return Err(ipc::PROFILES_RUNNING);
        }
        *self.store.write().map_err(|_| ipc::INTERNAL)? = StoreSlot::Failed(StoreFailure {
            code: "REMOVED",
            from_version: None,
            to_version: None,
            backup_available: false,
            backup: None,
        });
        for dir in [
            &self.paths.profiles,
            &self.paths.runtimes,
            &self.paths.data.join("crash-reports"),
        ] {
            if dir.exists() {
                std::fs::remove_dir_all(dir).map_err(|_| ipc::INTERNAL)?;
            }
        }
        for entry in std::fs::read_dir(&self.paths.data)
            .map_err(|_| ipc::INTERNAL)?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("local.db") {
                std::fs::remove_file(entry.path()).map_err(|_| ipc::INTERNAL)?;
            }
        }
        Ok(())
    }
}

fn open_slot(db: &Path) -> StoreSlot {
    match LocalStore::open(db) {
        Ok(s) => StoreSlot::Ready(Arc::new(s)),
        Err(StoreError::MigrationFailed(f)) => StoreSlot::Failed(StoreFailure {
            code: "MIGRATION_FAILED",
            from_version: Some(f.from),
            to_version: Some(f.to),
            backup_available: f.backup.as_ref().is_some_and(|b| b.is_file()),
            backup: f.backup,
        }),
        Err(StoreError::TooNew { found, supported }) => StoreSlot::Failed(StoreFailure {
            code: "DATABASE_TOO_NEW",
            from_version: Some(found),
            to_version: Some(supported),
            backup_available: false,
            backup: None,
        }),
        Err(_) => StoreSlot::Failed(StoreFailure {
            code: "DATABASE_UNREADABLE",
            from_version: None,
            to_version: None,
            backup_available: false,
            backup: None,
        }),
    }
}
