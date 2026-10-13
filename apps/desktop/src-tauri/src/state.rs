//! Application state and the logic behind every IPC command. Commands in `commands.rs` are thin wrappers that
//! check the caller and delegate here (and to `lifecycle.rs`), so the behaviour is testable without a webview.

use crate::events::{EventSink, PROFILES_CHANGED};
use crate::ipc::{self, IpcError, limits};
use crate::network::{NetworkSettings, NetworkView, Networks};
use crate::operations::Operations;
use crate::recovery::{self, SessionInfo};
use crate::runtime::{self, ManifestStatus, ResolvedRuntime, RuntimeConfig};
use crate::secrets::{KeychainStatus, KeychainStore, SecretStore};
use crate::supervisor::{ReconcileReport, RunningProfile, Supervisor};
use pb_runtime::backup::Backups;
use pb_runtime::{
    BrowserInstall, Launcher, PermissionDefault, ProcessInspector, ProfileId, ProfilesRoot,
    RunState, WorkspaceId, valid_start_url,
};
use pb_storage::settings::{self, SettingValue};
use pb_storage::{
    LocalProfile, LocalStore, NewProfile, ProfileUpdate, RuntimeInstallation, StoreError, Workspace,
};
use pb_update::RuntimeManifest;
use pb_update::install::{FsSpace, Installer, Stage};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

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
    pub(crate) store: RwLock<StoreSlot>,
    pub supervisor: Arc<Supervisor>,
    pub ops: Arc<Operations>,
    pub events: Arc<dyn EventSink>,
    pub(crate) launcher: Arc<dyn Launcher>,
    pub(crate) runtime: RuntimeConfig,
    pub(crate) manifest: Option<RuntimeManifest>,
    pub(crate) manifest_status: ManifestStatus,
    pub(crate) backups: Backups,
    pub session: SessionInfo,
    pub(crate) crash_acknowledged: AtomicBool,
    pub keychain: RwLock<KeychainStatus>,
    pub started: Instant,
    pub(crate) ui_ready_recorded: AtomicBool,
    pub(crate) launch_lock: Mutex<()>,
    /// Background backups in progress, so a launch request can cancel them and `backup_now` can join them.
    pub(crate) backups_running: Mutex<HashMap<ProfileId, crate::lifecycle::BackupJob>>,
    pub(crate) installing: AtomicBool,
    /// Undo records of recent bulk actions (milestone 04).
    pub(crate) undo: Mutex<Vec<crate::manage::UndoEntry>>,
    /// Files chosen for import in the native dialog, by opaque reference.
    pub(crate) import_files: Mutex<HashMap<String, crate::transfer::ChosenFile>>,
    pub(crate) import_previews:
        Mutex<HashMap<pb_runtime::ImportJobId, crate::transfer::PreviewState>>,
    pub(crate) imports_running: Mutex<HashMap<pb_runtime::ImportJobId, Arc<AtomicBool>>>,
    pub(crate) poll_count: AtomicU64,
    pub(crate) low_disk_warned: AtomicBool,
    pub reconcile: ReconcileReport,
    /// Set by the shell to refresh the tray's running-profile count.
    pub on_running_changed: RwLock<Option<RunningListener>>,
    /// Network tasks (proxy gateways and checks) run here, never on the UI thread (milestone 05).
    pub(crate) net: Arc<pb_netproxy::NetRuntime>,
    /// Proxy logins: the OS keychain (tests replace it with an in-memory store).
    pub(crate) secrets: RwLock<Arc<dyn SecretStore>>,
    pub(crate) network_settings: RwLock<NetworkSettings>,
    /// Gateways and launch settings of open profiles.
    pub(crate) networks: Mutex<Networks>,
    /// Expiry reminders already shown in this session.
    pub(crate) expiry_warned: Mutex<Vec<(pb_runtime::ProxyId, &'static str)>>,
}

// ----------------------------------------------------------------------------- views returned over IPC
#[derive(Serialize)]
pub struct Permissions {
    pub camera: PermissionDefault,
    pub microphone: PermissionDefault,
    pub location: PermissionDefault,
}

#[derive(Serialize)]
pub struct ProfileView {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub client_colour: Option<String>,
    pub tags: Vec<pb_storage::TagRef>,
    pub notes: String,
    pub favourite: bool,
    pub archived_at: Option<String>,
    /// Set while the profile is in the trash, with the date it will be deleted permanently.
    pub trashed_at: Option<String>,
    pub purge_after: Option<String>,
    pub template_id: Option<String>,
    /// Assigned proxy (milestone 05) and its name.
    pub proxy_id: Option<String>,
    pub proxy_label: Option<String>,
    /// With a proxy: block traffic that cannot go through it (on by default).
    pub fail_closed: bool,
    pub network: NetworkView,
    pub privacy: pb_runtime::PrivacyConfig,
    /// Cloud sync arrives in milestone 07: always `local_only` for now.
    pub sync_status: &'static str,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Display status: closed | starting | running | stopping | crashed | recovering
    pub status: &'static str,
    pub state: RunState,
    pub pid: Option<u32>,
    /// Running since before this manager instance started (the manager was closed or crashed meanwhile).
    pub adopted: bool,
    /// The browser has started its helper processes.
    pub ready: bool,
    /// At least one page (renderer) is open.
    pub window_open: bool,
    pub force_available: bool,
    pub start_urls: Vec<String>,
    pub download_dir: Option<String>,
    pub permissions: Permissions,
    pub runtime_version: Option<String>,
    pub last_error: Option<String>,
    pub crash_count: u32,
    pub last_started_at: Option<String>,
    pub last_clean_shutdown_at: Option<String>,
    pub last_backup_at: Option<String>,
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

/// Arguments of `update_profile` after deserialization (validated in [`AppState::update_profile`]).
#[derive(Default)]
pub struct ProfileChanges<'a> {
    pub name: Option<&'a str>,
    pub client_id: Option<&'a pb_runtime::ClientId>,
    pub clear_client: bool,
    pub notes: Option<&'a str>,
    pub favourite: Option<bool>,
    /// Replaces the tags (names; missing tags are created).
    pub tags: Option<&'a [String]>,
    pub start_urls: Option<&'a [String]>,
    pub clear_download_dir: bool,
    pub camera: Option<&'a str>,
    pub microphone: Option<&'a str>,
    pub location: Option<&'a str>,
    /// Privacy and environment settings (milestone 05), replaced as a whole.
    pub privacy: Option<&'a pb_runtime::PrivacyConfig>,
}

impl AppState {
    pub fn build(
        data_dir: &Path,
        runtime: RuntimeConfig,
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
        let backups = Backups {
            root: data_dir.join("backups"),
            evidence: data_dir.join("evidence"),
        };
        let insp = inspector.clone();
        let session = recovery::begin_session(&paths.data, APP_VERSION, move |pid| {
            insp.inspect(pid).is_some()
        });
        let supervisor = Arc::new(Supervisor::new(inspector));
        let (manifest_status, manifest) = runtime::verify(&runtime);

        let t0 = Instant::now();
        let slot = open_slot(&paths.db);
        let mut reconcile = ReconcileReport::default();
        if let StoreSlot::Ready(store) = &slot {
            let _ = store.record_timing("store_open_ms", t0.elapsed().as_secs_f64() * 1000.0);
            let _ = store.ensure_device(platform(), std::env::consts::ARCH);
            tidy_profiles(&root, &backups);
            // Deletions and imports interrupted by a crash: finish moving folders out, mark imports resumable.
            let _ = root.purge_retired();
            let _ = store.mark_interrupted_imports();
            let trusted = trusted_executables(store, &runtime, &paths.runtimes);
            reconcile = supervisor.reconcile_on_startup(store, &root, &trusted);
        }
        let net = pb_netproxy::NetRuntime::new().map_err(|e| format!("network runtime: {e}"))?;

        Ok(Arc::new(Self {
            paths,
            root,
            store: RwLock::new(slot),
            supervisor,
            ops: Arc::new(Operations::new(events.clone())),
            events,
            launcher,
            runtime,
            manifest,
            manifest_status,
            backups,
            session,
            crash_acknowledged: AtomicBool::new(false),
            keychain: RwLock::new(KeychainStatus {
                available: false,
                reason: Some("not_checked_yet"),
            }),
            started: Instant::now(),
            ui_ready_recorded: AtomicBool::new(false),
            launch_lock: Mutex::new(()),
            backups_running: Mutex::new(HashMap::new()),
            installing: AtomicBool::new(false),
            undo: Mutex::new(Vec::new()),
            import_files: Mutex::new(HashMap::new()),
            import_previews: Mutex::new(HashMap::new()),
            imports_running: Mutex::new(HashMap::new()),
            poll_count: AtomicU64::new(0),
            low_disk_warned: AtomicBool::new(false),
            reconcile,
            on_running_changed: RwLock::new(None),
            net,
            secrets: RwLock::new(Arc::new(KeychainStore)),
            network_settings: RwLock::new(NetworkSettings::default()),
            networks: Mutex::new(HashMap::new()),
            expiry_warned: Mutex::new(Vec::new()),
        }))
    }

    pub fn store(&self) -> Result<Arc<LocalStore>, IpcError> {
        match &*self.store.read().map_err(|_| ipc::INTERNAL)? {
            StoreSlot::Ready(s) => Ok(s.clone()),
            StoreSlot::Failed(_) => Err(ipc::STORE_UNAVAILABLE),
        }
    }

    pub(crate) fn store_failure(&self) -> Option<StoreFailure> {
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

    pub(crate) fn active_workspace(
        &self,
        store: &LocalStore,
    ) -> Result<Option<WorkspaceId>, IpcError> {
        let value = store.get_setting(settings::ACTIVE_WORKSPACE)?.value;
        let Some(id) = value.as_str().and_then(|s| WorkspaceId::parse(s).ok()) else {
            return Ok(None);
        };
        Ok(store.get_workspace(&id)?.map(|w| w.id))
    }

    pub(crate) fn view(&self, p: LocalProfile) -> ProfileView {
        let live = self.supervisor.status(&p.id);
        let network = self.network_view(&p);
        let state = live.as_ref().map(|r| r.state).unwrap_or(match p.state {
            // Without a tracked process the profile cannot be active (the supervisor reconciles at start-up).
            RunState::Starting | RunState::Running | RunState::Stopping => RunState::Stopped,
            other => other,
        });
        ProfileView {
            id: p.id.to_string(),
            workspace_id: p.workspace_id.map(|w| w.to_string()),
            name: p.name,
            client_id: p.client_id.map(|c| c.to_string()),
            client_name: p.client_name,
            client_colour: p.client_colour,
            tags: p.tags,
            notes: p.notes,
            favourite: p.favourite,
            archived_at: p.archived_at,
            trashed_at: p.trashed_at,
            purge_after: p.purge_after,
            template_id: p.template_id.map(|t| t.to_string()),
            proxy_id: p.proxy_id.map(|x| x.to_string()),
            proxy_label: p.proxy_label,
            fail_closed: p.fail_closed,
            network,
            privacy: p.privacy,
            sync_status: "local_only",
            version: p.version,
            created_at: p.created_at,
            updated_at: p.updated_at,
            status: match state {
                RunState::Stopped => "closed",
                other => other.as_str(),
            },
            state,
            pid: live.as_ref().and_then(|r| r.pid),
            adopted: live.as_ref().is_some_and(|r| r.adopted),
            ready: live.as_ref().is_some_and(|r| r.ready),
            window_open: live.as_ref().is_some_and(|r| r.window_open),
            force_available: live.as_ref().is_some_and(|r| r.force_available),
            start_urls: p.start_urls,
            download_dir: p.download_dir,
            permissions: Permissions {
                camera: p.camera,
                microphone: p.microphone,
                location: p.location,
            },
            runtime_version: p.runtime_version,
            last_error: p.last_error,
            crash_count: p.crash_count,
            last_started_at: p.last_started_at,
            last_clean_shutdown_at: p.last_clean_shutdown_at,
            last_backup_at: p.last_backup_at,
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
                "adopted_profiles": self.reconcile.adopted + self.reconcile.orphans_adopted,
                "cleared_stale_processes": self.reconcile.cleared,
                "interrupted_profiles": self.reconcile.interrupted,
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
    /// Active profiles matching a search (first page). The profile table uses `query_profiles`.
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

    /// Basic creation needs only a name; a client (by name, created if new) and a template are optional.
    /// Browser storage always starts empty.
    pub fn create_profile(
        &self,
        name: &str,
        client: Option<&str>,
        template: Option<&pb_runtime::TemplateId>,
    ) -> Result<ProfileView, IpcError> {
        let name = ipc::clean_text(name, limits::LABEL_CHARS, ipc::INVALID_LABEL)?;
        let client = client
            .filter(|c| !c.trim().is_empty())
            .map(|c| ipc::clean_text(c, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let store = self.store()?;
        let ws = self.active_workspace(&store)?.ok_or(ipc::NO_WORKSPACE)?;
        let client_id = client.map(|c| store.ensure_client(&ws, &c)).transpose()?;
        let id = ProfileId::generate().map_err(|_| ipc::INTERNAL)?;
        let mut new = NewProfile::basic(id, Some(ws.clone()), &name, client_id);
        if let Some(t) = template {
            self.apply_template(&store, &ws, t, &mut new)?;
        }
        let p = store.insert_profile(new)?;
        let _ = store.audit(Some(&p.id), "create", "ok", None, None);
        Ok(self.view(p))
    }

    pub fn update_profile(
        &self,
        profile_id: &ProfileId,
        expected_version: i64,
        c: ProfileChanges<'_>,
    ) -> Result<ProfileView, IpcError> {
        let name = c
            .name
            .map(|n| ipc::clean_text(n, limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let notes = c.notes.map(ipc::clean_notes).transpose()?;
        if let Some(urls) = c.start_urls
            && (urls.len() > pb_runtime::MAX_START_URLS || !urls.iter().all(|u| valid_start_url(u)))
        {
            return Err(pb_runtime::LaunchError::BadStartUrl.into());
        }
        let tag_names = c
            .tags
            .map(|t| {
                if t.len() > 20 {
                    return Err(ipc::INVALID_TAG);
                }
                t.iter()
                    .map(|n| ipc::clean_text(n, 40, ipc::INVALID_TAG))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let perm = |v: Option<&str>| {
            v.map(|s| PermissionDefault::parse(s).ok_or(ipc::INVALID_PERMISSION))
                .transpose()
        };
        let (camera, microphone, location) =
            (perm(c.camera)?, perm(c.microphone)?, perm(c.location)?);
        if let Some(privacy) = c.privacy {
            pb_runtime::environment::validate(privacy)?;
        }
        let store = self.store()?;
        let current = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        if current.trashed_at.is_some() {
            return Err(ipc::PROFILE_IN_TRASH);
        }
        let ws = current.workspace_id.clone().ok_or(ipc::NO_WORKSPACE)?;
        if let Some(client) = c.client_id {
            let found = store.get_client(client)?.ok_or(ipc::UNKNOWN_CLIENT)?;
            if found.workspace_id != ws {
                return Err(ipc::UNKNOWN_CLIENT);
            }
        }
        let tag_ids = tag_names
            .map(|names| {
                names
                    .iter()
                    .map(|n| store.ensure_tag(&ws, n).map(|t| t.id))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let p = store.update_profile(
            profile_id,
            ProfileUpdate {
                name: name.as_deref(),
                client_id: if c.clear_client {
                    Some(None)
                } else {
                    c.client_id.map(Some)
                },
                notes: notes.as_deref(),
                start_urls: c.start_urls,
                download_dir: c.clear_download_dir.then_some(None),
                camera,
                microphone,
                location,
                favourite: c.favourite,
                tags: tag_ids.as_deref(),
                network: None,
                privacy: c.privacy,
            },
            expected_version,
        )?;
        if c.privacy.is_some() {
            self.notify_running_changed();
        }
        Ok(self.view(p))
    }

    /// Saves a per-profile download folder chosen in the native dialog.
    pub fn set_profile_download_directory(
        &self,
        profile_id: &ProfileId,
        chosen: &Path,
    ) -> Result<String, IpcError> {
        let text = self.validate_download_dir(chosen)?;
        let store = self.store()?;
        let p = store.get_profile(profile_id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
        store.update_profile(
            profile_id,
            ProfileUpdate {
                download_dir: Some(Some(&text)),
                ..ProfileUpdate::default()
            },
            p.version,
        )?;
        Ok(text)
    }

    // ------------------------------------------------------------------------- runtime
    /// The browser executable for launches: the installed manifest runtime, or a debug/test override.
    pub fn resolve_runtime(&self, store: &LocalStore) -> Result<ResolvedRuntime, IpcError> {
        if let Some(dev) = &self.runtime.dev_override {
            dev.validate()?;
            return Ok(ResolvedRuntime {
                executable: dev.executable.clone(),
                version: pb_update::parse_version(&dev.revision).map(|_| dev.revision.clone()),
                source: "development_override",
            });
        }
        let manifest = self.manifest.as_ref().ok_or(ipc::RUNTIME_UNAVAILABLE)?;
        let artifact = manifest
            .artifact_for(platform())
            .ok_or(ipc::RUNTIME_UNAVAILABLE)?;
        let version = &manifest.runtime.version;
        let installed = store
            .list_runtimes()?
            .into_iter()
            .find(|r| &r.version == version && r.platform == platform() && r.status == "verified")
            .ok_or(ipc::RUNTIME_NOT_INSTALLED)?;
        let expected_dir = Installer {
            root: self.paths.runtimes.clone(),
            space: &FsSpace,
        }
        .installed_dir(version, platform())
        .map_err(|_| ipc::INTERNAL)?;
        // Never trust a stored path: the executable must be the manifest's, inside our installed directory.
        if Path::new(&installed.path) != expected_dir {
            return Err(ipc::RUNTIME_NOT_INSTALLED);
        }
        let executable = expected_dir.join(&artifact.executable);
        BrowserInstall {
            executable: executable.clone(),
            revision: version.clone(),
        }
        .validate()
        .map_err(|_| ipc::RUNTIME_NOT_INSTALLED)?;
        Ok(ResolvedRuntime {
            executable,
            version: Some(version.clone()),
            source: "manifest",
        })
    }

    pub fn runtime_status(&self) -> RuntimeStatus {
        let installer = Installer {
            root: self.paths.runtimes.clone(),
            space: &FsSpace,
        };
        let store = self.store().ok();
        let resolved = store.as_ref().map(|s| self.resolve_runtime(s));
        let manifest = self.manifest.as_ref().map(|m| {
            json!({
                "version": m.runtime.version,
                "channel": m.channel,
                "distribution": m.distribution.name,
                "customer_distribution": m.distribution.customer_distribution,
                "platform_supported": m.artifact_for(platform()).is_some(),
                "size_bytes": m.artifact_for(platform()).map(|a| a.size_bytes),
            })
        });
        RuntimeStatus {
            browser: json!({
                "configured": matches!(resolved, Some(Ok(_))),
                "source": match &resolved {
                    Some(Ok(r)) => r.source,
                    _ => "none",
                },
                "version": resolved.as_ref().and_then(|r| r.as_ref().ok()).and_then(|r| r.version.clone()),
                "error": resolved.as_ref().and_then(|r| r.as_ref().err()).map(|e| e.code),
                "manifest_status": self.manifest_status,
                "manifest": manifest,
                "installing": self.installing.load(Ordering::Relaxed),
            }),
            installations: store
                .as_ref()
                .and_then(|s| s.list_runtimes().ok())
                .unwrap_or_default(),
            interrupted: installer
                .interrupted()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|i| {
                    let id = i.dir.file_name()?.to_string_lossy().into_owned();
                    let stage = i.journal.map(|j| j.stage).unwrap_or(Stage::Downloading);
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

    fn validate_download_dir(&self, chosen: &Path) -> Result<String, IpcError> {
        if !chosen.is_absolute()
            || std::fs::symlink_metadata(chosen)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true)
        {
            return Err(ipc::INVALID_DIRECTORY);
        }
        // Ordinary (non-verbatim) form on Windows: the path is written into Chromium's settings.
        let dir = pb_runtime::simplify_path(
            &std::fs::canonicalize(chosen).map_err(|_| ipc::INVALID_DIRECTORY)?,
        );
        let data = pb_runtime::simplify_path(
            &std::fs::canonicalize(&self.paths.data).map_err(|_| ipc::INTERNAL)?,
        );
        if !dir.is_dir() || dir.starts_with(&data) || data.starts_with(&dir) {
            return Err(ipc::INVALID_DIRECTORY);
        }
        let probe = dir.join(format!(
            ".pb-write-test-{}",
            pb_runtime::random_hex(6).map_err(|_| ipc::INTERNAL)?
        ));
        std::fs::write(&probe, b"").map_err(|_| ipc::INVALID_DIRECTORY)?;
        let _ = std::fs::remove_file(&probe);
        Ok(dir.to_string_lossy().into_owned())
    }

    /// Validates and saves a folder chosen in the native dialog.
    pub fn set_download_directory(&self, chosen: &Path) -> Result<String, IpcError> {
        let text = self.validate_download_dir(chosen)?;
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
        let audit = store
            .as_ref()
            .and_then(|s| s.list_audit(None, 20).ok())
            .unwrap_or_default();
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
            "runtime": {
                "manifest_status": self.manifest_status,
                "platform": platform(),
            },
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
                "ready_ms": summary("browser_ready_ms"),
            },
            "system_memory_bytes": sys.total_memory(),
            "crash_reports": recovery::list_reports(&self.paths.data).len(),
            "previous_session_crashed": self.session.previous_session_crashed,
            "reconcile": self.reconcile,
            // Launch/stop/crash history: actions and codes only (no URLs, titles or cookie contents).
            "recent_activity": audit,
        })
    }

    // ------------------------------------------------------------------------- store recovery
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

    /// Deletes every local profile, backup and the local database ("clear uninstall choice" on platforms without
    /// an uninstaller). The caller restarts the app afterwards.
    pub fn remove_local_data(&self, confirm: &str) -> Result<(), IpcError> {
        if confirm != "DELETE" {
            return Err(ipc::CONFIRMATION_REQUIRED);
        }
        if self.supervisor.running_count() > 0 {
            return Err(ipc::PROFILES_RUNNING);
        }
        // Nothing may write into the folders while they are removed: backups (one starts automatically after a
        // clean close) are cancelled and waited for; a recovery in progress is not interrupted.
        for id in self.supervisor.busy_profiles() {
            if !self.cancel_backup(&id) {
                return Err(ipc::PROFILE_BUSY);
            }
        }
        *self.store.write().map_err(|_| ipc::INTERNAL)? = StoreSlot::Failed(StoreFailure {
            code: "REMOVED",
            from_version: None,
            to_version: None,
            backup_available: false,
            backup: None,
        });
        // A backup needs the store, so none can start from here on; one that started a moment ago is cancelled.
        for id in self.supervisor.busy_profiles() {
            let _ = self.cancel_backup(&id);
        }
        for dir in [
            &self.paths.profiles,
            &self.paths.runtimes,
            &self.backups.root,
            &self.backups.evidence,
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

/// Every runtime executable this manager may have launched (adoption after a crash is limited to these).
fn trusted_executables(
    store: &LocalStore,
    config: &RuntimeConfig,
    runtimes: &Path,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = config
        .dev_override
        .iter()
        .map(|d| d.executable.clone())
        .collect();
    let installed = runtimes.join("installed");
    for r in store.list_runtimes().unwrap_or_default() {
        if let Some(exe) = &r.executable
            && Path::new(&r.path).starts_with(&installed)
        {
            out.push(Path::new(&r.path).join(exe));
        }
    }
    out
}

/// Finishes or rolls back backups and restores interrupted by a crash.
fn tidy_profiles(root: &ProfilesRoot, backups: &Backups) {
    let Ok(entries) = std::fs::read_dir(root.path()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(id) = ProfileId::parse(&name) else {
            continue;
        };
        let _ = backups.tidy(id.as_str());
        let dirs = root.dirs(&id);
        let restoring = dirs.root.join("user-data.restoring");
        if restoring.is_dir() {
            if dirs.user_data.exists() {
                let _ = std::fs::remove_dir_all(&restoring); // crashed while copying: discard the copy
            } else {
                let _ = std::fs::rename(&restoring, &dirs.user_data); // crashed after moving evidence aside
            }
        }
    }
}

pub(crate) fn open_slot(db: &Path) -> StoreSlot {
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
