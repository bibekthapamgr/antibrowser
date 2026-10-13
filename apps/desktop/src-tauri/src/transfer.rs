//! Configuration import and export (milestone 04).
//!
//! Import: the file is chosen in a native dialog (the webview only ever holds an opaque reference), then
//! `preview_import` parses and validates every row, plans what each row will do (create, update, skip as duplicate,
//! already imported, or error) and binds the plan to the file's SHA-256 and the chosen settings. `commit_import`
//! re-reads the file and refuses to continue if it changed. Rows are written in batches of 250 with progress and a
//! cancel check between batches. Each created profile records `import_ref = <digest>:<row>`, so running the same file
//! again (after a cancel, a crash or errors) never duplicates rows that were already imported.
//!
//! Only configuration is imported; cookies and other session data are not (see `pb_import`).
//!
//! Export: configuration only (see `pb_import::export::ExportProfile`); notes that look like secrets are withheld.

use crate::authz::{self, Action};
use crate::ipc::{self, IpcError};
use crate::manage::Selection;
use crate::operations::{OpKind, Started};
use crate::state::AppState;
use pb_import::{FieldError, ParsedFile, ProfileRow};
use pb_runtime::{ClientId, ImportJobId, ProfileId, TagId, TemplateId, WorkspaceId};
use pb_storage::imports::ImportJob;
use pb_storage::migrations::name_key;
use pb_storage::{LocalStore, NewProfile, ProfileUpdate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Rows created or updated per transaction.
pub const IMPORT_BATCH: usize = 250;
const PREVIEW_ROWS: usize = 500;
const MAX_ERRORS: usize = 1000;
const FILE_TTL: Duration = Duration::from_secs(60 * 60);

pub(crate) struct ChosenFile {
    path: PathBuf,
    name: String,
    chosen: Instant,
}

#[derive(Serialize)]
pub struct ChosenImport {
    pub file_ref: Option<String>,
    pub name: Option<String>,
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicatePolicy {
    /// Keep the existing profile; skip the row (default).
    #[default]
    Skip,
    /// Create another profile with the same name (names need not be unique).
    Create,
    /// Update the existing profile's configuration (tags are added, other fields replaced).
    Update,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportSettings {
    #[serde(default)]
    pub duplicates: DuplicatePolicy,
    /// Client for rows that name none.
    #[serde(default)]
    pub default_client: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RowError {
    pub row: u32,
    pub field: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewRow {
    pub row: u32,
    /// create | update | skip_duplicate | already_imported | error
    pub status: &'static str,
    pub name: String,
    pub client: Option<String>,
    pub tags: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<FieldError>,
}

#[derive(Serialize)]
pub struct FileProblem {
    pub code: &'static str,
    pub message: String,
}

#[derive(Serialize, Default)]
pub struct ImportPreview {
    pub preview_id: Option<String>,
    pub file_name: String,
    pub format: Option<&'static str>,
    pub schema_version: Option<u32>,
    pub file_error: Option<FileProblem>,
    pub total: usize,
    pub valid: usize,
    pub invalid: usize,
    pub will_create: usize,
    pub will_update: usize,
    pub will_skip: usize,
    pub already_imported: usize,
    pub with_warnings: usize,
    pub new_clients: Vec<String>,
    pub new_tags: Vec<String>,
    /// The first rows (all statuses), for the preview table.
    pub rows: Vec<PreviewRow>,
    pub rows_truncated: bool,
    /// Every row error (capped at 1,000).
    pub errors: Vec<RowError>,
}

pub(crate) struct PreviewState {
    workspace: WorkspaceId,
    job: ImportJobId,
    path: PathBuf,
    name: String,
    digest: String,
    settings: ImportSettings,
    /// Profile versions seen by the preview for rows that update: a profile changed since then is not overwritten.
    updates: HashMap<u32, (ProfileId, i64)>,
    /// Update rows already written by an earlier run of this preview (a continued import does not re-apply them).
    applied: Arc<Mutex<HashSet<u32>>>,
    created: Instant,
}

#[derive(Clone, Debug, PartialEq)]
enum Plan {
    Create,
    Update(ProfileId, i64),
    SkipDuplicate,
    AlreadyImported,
    Error(Vec<FieldError>),
}

struct Planned {
    row: u32,
    plan: Plan,
    data: Option<ProfileRow>,
    client: Option<String>,
}

struct PlanSummary {
    rows: Vec<Planned>,
    new_clients: Vec<String>,
    new_tags: Vec<String>,
}

pub fn import_ref(digest: &str, row: u32) -> String {
    format!("{}:{row}", &digest[..16.min(digest.len())])
}

fn plan(
    store: &LocalStore,
    ws: &WorkspaceId,
    parsed: ParsedFile,
    digest: &str,
    settings: &ImportSettings,
) -> Result<PlanSummary, IpcError> {
    let clients: HashMap<String, ClientId> = store
        .list_clients(ws, true)?
        .into_iter()
        .map(|c| (name_key(&c.name), c.id))
        .collect();
    let tags: HashSet<String> = store
        .list_tags(ws)?
        .into_iter()
        .map(|t| name_key(&t.name))
        .collect();
    let templates: HashSet<String> = store
        .list_templates(ws)?
        .into_iter()
        .map(|t| name_key(&t.name))
        .collect();
    let mut existing: HashMap<(String, String), (ProfileId, i64)> = HashMap::new();
    for (id, key, client, version) in store.profile_keys(ws)? {
        existing
            .entry((key, client.map(|c| c.to_string()).unwrap_or_default()))
            .or_insert((id, version));
    }
    let refs: Vec<String> = parsed
        .rows
        .iter()
        .filter(|r| r.outcome.is_ok())
        .map(|r| import_ref(digest, r.row))
        .collect();
    let done: HashSet<String> = store.existing_import_refs(&refs)?.into_iter().collect();

    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut new_clients: Vec<String> = vec![];
    let mut new_tags: Vec<String> = vec![];
    let mut new_client_keys: HashSet<String> = HashSet::new();
    let mut new_tag_keys: HashSet<String> = HashSet::new();
    let mut rows = Vec::with_capacity(parsed.rows.len());
    for r in parsed.rows {
        let data = match r.outcome {
            Err(e) => {
                rows.push(Planned {
                    row: r.row,
                    plan: Plan::Error(e),
                    data: None,
                    client: None,
                });
                continue;
            }
            Ok(d) => d,
        };
        let client = data
            .client
            .clone()
            .or_else(|| settings.default_client.clone());
        if let Some(t) = &data.template
            && !templates.contains(&name_key(t))
        {
            rows.push(Planned {
                row: r.row,
                plan: Plan::Error(vec![FieldError {
                    field: "template".into(),
                    code: "unknown_template",
                    message: format!(
                        "no template named \"{}\"",
                        t.chars().take(60).collect::<String>()
                    ),
                }]),
                data: None,
                client,
            });
            continue;
        }
        if done.contains(&import_ref(digest, r.row)) {
            rows.push(Planned {
                row: r.row,
                plan: Plan::AlreadyImported,
                data: Some(data),
                client,
            });
            continue;
        }
        let client_key = match &client {
            None => String::new(),
            Some(c) => match clients.get(&name_key(c)) {
                Some(id) => id.to_string(),
                None => {
                    if new_client_keys.insert(name_key(c)) {
                        new_clients.push(c.clone());
                    }
                    format!("new:{}", name_key(c))
                }
            },
        };
        let key = (name_key(&data.name), client_key);
        let plan = if seen.contains(&key) && settings.duplicates != DuplicatePolicy::Create {
            Plan::SkipDuplicate
        } else if let Some((id, version)) = existing.get(&key) {
            match settings.duplicates {
                DuplicatePolicy::Skip => Plan::SkipDuplicate,
                DuplicatePolicy::Create => Plan::Create,
                DuplicatePolicy::Update => Plan::Update(id.clone(), *version),
            }
        } else {
            Plan::Create
        };
        seen.insert(key);
        if matches!(plan, Plan::Create | Plan::Update(..)) {
            for t in &data.tags {
                let k = name_key(t);
                if !tags.contains(&k) && new_tag_keys.insert(k) {
                    new_tags.push(t.clone());
                }
            }
        }
        rows.push(Planned {
            row: r.row,
            plan,
            data: Some(data),
            client,
        });
    }
    Ok(PlanSummary {
        rows,
        new_clients,
        new_tags,
    })
}

fn row_errors(rows: &[Planned]) -> Vec<RowError> {
    rows.iter()
        .filter_map(|p| match &p.plan {
            Plan::Error(es) => Some(es.iter().map(move |e| RowError {
                row: p.row,
                field: e.field.clone(),
                code: e.code,
                message: e.message.clone(),
            })),
            _ => None,
        })
        .flatten()
        .take(MAX_ERRORS)
        .collect()
}

fn read_limited(path: &Path) -> Result<Vec<u8>, IpcError> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| ipc::UNKNOWN_FILE)?;
    if !meta.is_file() {
        return Err(ipc::UNKNOWN_FILE);
    }
    if meta.len() > pb_import::MAX_FILE_BYTES {
        return Err(IpcError::new(
            "FILE_TOO_LARGE",
            "The file is larger than 20 MB. Split it into smaller files.",
        ));
    }
    let bytes = std::fs::read(path).map_err(|_| ipc::UNKNOWN_FILE)?;
    if bytes.len() as u64 > pb_import::MAX_FILE_BYTES {
        return Err(ipc::UNKNOWN_FILE);
    }
    Ok(bytes)
}

impl AppState {
    // ------------------------------------------------------------------------- import
    /// Registers a file chosen in the native dialog and returns an opaque reference for it.
    pub fn register_import_file(&self, path: &Path) -> Result<ChosenImport, IpcError> {
        let meta = std::fs::symlink_metadata(path).map_err(|_| ipc::UNKNOWN_FILE)?;
        if !meta.is_file() {
            return Err(ipc::UNKNOWN_FILE);
        }
        let token = pb_runtime::random_hex(16).map_err(|_| ipc::INTERNAL)?;
        let name: String = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
        let mut files = self.import_files.lock().map_err(|_| ipc::INTERNAL)?;
        files.retain(|_, f| f.chosen.elapsed() < FILE_TTL);
        if files.len() >= 20 {
            files.clear();
        }
        files.insert(
            token.clone(),
            ChosenFile {
                path: path.to_path_buf(),
                name: name.clone(),
                chosen: Instant::now(),
            },
        );
        Ok(ChosenImport {
            file_ref: Some(token),
            name: Some(name),
            size: Some(meta.len()),
        })
    }

    pub fn preview_import(
        &self,
        file_ref: &str,
        settings: ImportSettings,
    ) -> Result<ImportPreview, IpcError> {
        let default_client = settings
            .default_client
            .as_deref()
            .filter(|c| !c.trim().is_empty())
            .map(|c| ipc::clean_text(c, ipc::limits::LABEL_CHARS, ipc::INVALID_LABEL))
            .transpose()?;
        let settings = ImportSettings {
            default_client,
            ..settings
        };
        let (path, name) = {
            let files = self.import_files.lock().map_err(|_| ipc::INTERNAL)?;
            let f = files.get(file_ref).ok_or(ipc::UNKNOWN_FILE)?;
            (f.path.clone(), f.name.clone())
        };
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let bytes = read_limited(&path)?;
        let digest = pb_import::digest(&bytes);
        let parsed = match pb_import::parse(&name, &bytes) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ImportPreview {
                    file_name: name,
                    file_error: Some(FileProblem {
                        code: e.code(),
                        message: e.to_string(),
                    }),
                    ..Default::default()
                });
            }
        };
        let (format, schema_version) = (parsed.format, parsed.schema_version);
        let summary = plan(&store, &ws, parsed, &digest, &settings)?;
        let count = |f: fn(&Plan) -> bool| summary.rows.iter().filter(|p| f(&p.plan)).count();
        let invalid = count(|p| matches!(p, Plan::Error(_)));
        let mut preview = ImportPreview {
            preview_id: None,
            file_name: name.clone(),
            format: Some(format.as_str()),
            schema_version: Some(schema_version),
            file_error: None,
            total: summary.rows.len(),
            valid: summary.rows.len() - invalid,
            invalid,
            will_create: count(|p| matches!(p, Plan::Create)),
            will_update: count(|p| matches!(p, Plan::Update(..))),
            will_skip: count(|p| matches!(p, Plan::SkipDuplicate)),
            already_imported: count(|p| matches!(p, Plan::AlreadyImported)),
            with_warnings: summary
                .rows
                .iter()
                .filter(|p| p.data.as_ref().is_some_and(|d| !d.warnings.is_empty()))
                .count(),
            new_clients: summary.new_clients.iter().take(50).cloned().collect(),
            new_tags: summary.new_tags.iter().take(50).cloned().collect(),
            rows: summary
                .rows
                .iter()
                .take(PREVIEW_ROWS)
                .map(|p| PreviewRow {
                    row: p.row,
                    status: match p.plan {
                        Plan::Create => "create",
                        Plan::Update(..) => "update",
                        Plan::SkipDuplicate => "skip_duplicate",
                        Plan::AlreadyImported => "already_imported",
                        Plan::Error(_) => "error",
                    },
                    name: p.data.as_ref().map(|d| d.name.clone()).unwrap_or_default(),
                    client: p.client.clone(),
                    tags: p.data.as_ref().map(|d| d.tags.clone()).unwrap_or_default(),
                    warnings: p
                        .data
                        .as_ref()
                        .map(|d| d.warnings.clone())
                        .unwrap_or_default(),
                    errors: match &p.plan {
                        Plan::Error(e) => e.clone(),
                        _ => vec![],
                    },
                })
                .collect(),
            rows_truncated: summary.rows.len() > PREVIEW_ROWS,
            errors: row_errors(&summary.rows),
        };
        let job = store.create_import_job(
            &ws,
            &name,
            &digest,
            format.as_str(),
            &serde_json::to_value(&settings).map_err(|_| ipc::INTERNAL)?,
            summary.rows.len() as u64,
        )?;
        let updates = summary
            .rows
            .iter()
            .filter_map(|p| match &p.plan {
                Plan::Update(id, v) => Some((p.row, (id.clone(), *v))),
                _ => None,
            })
            .collect();
        let mut previews = self.import_previews.lock().map_err(|_| ipc::INTERNAL)?;
        previews.retain(|_, s| s.created.elapsed() < FILE_TTL);
        if previews.len() >= 10
            && let Some(oldest) = previews
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(k, _)| k.clone())
        {
            previews.remove(&oldest);
        }
        preview.preview_id = Some(job.id.to_string());
        previews.insert(
            job.id.clone(),
            PreviewState {
                workspace: ws,
                job: job.id,
                path,
                name,
                digest,
                settings,
                updates,
                applied: Arc::default(),
                created: Instant::now(),
            },
        );
        Ok(preview)
    }

    /// Runs a previewed import (or continues a cancelled/interrupted one) in the background.
    pub fn commit_import(self: &Arc<Self>, preview_id: &ImportJobId) -> Result<Started, IpcError> {
        let (job, ws, path, name, digest, settings, updates, applied) = {
            let previews = self.import_previews.lock().map_err(|_| ipc::INTERNAL)?;
            let s = previews.get(preview_id).ok_or(ipc::UNKNOWN_IMPORT)?;
            (
                s.job.clone(),
                s.workspace.clone(),
                s.path.clone(),
                s.name.clone(),
                s.digest.clone(),
                s.settings.clone(),
                s.updates.clone(),
                s.applied.clone(),
            )
        };
        let store = self.store()?;
        if self.workspace(&store)? != ws {
            return Err(ipc::UNKNOWN_IMPORT);
        }
        // The preview is bound to the exact bytes it showed.
        let bytes = read_limited(&path)?;
        if pb_import::digest(&bytes) != digest {
            return Err(ipc::SOURCE_CHANGED);
        }
        let parsed = pb_import::parse(&name, &bytes).map_err(|_| ipc::SOURCE_CHANGED)?;
        drop(bytes);
        authz::authorize(Action::ImportConfiguration, parsed.rows.len())?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.imports_running.lock().map_err(|_| ipc::INTERNAL)?;
            if !running.is_empty() {
                return Err(ipc::IMPORT_IN_PROGRESS);
            }
            store.start_import_job(&job)?;
            running.insert(job.clone(), cancel.clone());
        }
        let op = self
            .ops
            .start(OpKind::ImportProfiles, Some(job.to_string()));
        let this = self.clone();
        let op_id = op.clone();
        std::thread::spawn(move || {
            this.run_import(
                &store, &ws, &job, &op_id, parsed, &digest, &settings, &updates, &applied, &cancel,
            );
            if let Ok(mut running) = this.imports_running.lock() {
                running.remove(&job);
            }
            this.notify_running_changed();
        });
        Ok(Started { operation_id: op })
    }

    pub fn cancel_import(&self, job: &ImportJobId) -> Result<(), IpcError> {
        let running = self.imports_running.lock().map_err(|_| ipc::INTERNAL)?;
        running
            .get(job)
            .ok_or(ipc::UNKNOWN_IMPORT)?
            .store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn list_imports(&self) -> Result<Vec<ImportJob>, IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        Ok(store.list_import_jobs(&ws)?)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_import(
        self: &Arc<Self>,
        store: &LocalStore,
        ws: &WorkspaceId,
        job: &ImportJobId,
        op: &str,
        parsed: ParsedFile,
        digest: &str,
        settings: &ImportSettings,
        updates: &HashMap<u32, (ProfileId, i64)>,
        applied: &Mutex<HashSet<u32>>,
        cancel: &AtomicBool,
    ) {
        let summary = match plan(store, ws, parsed, digest, settings) {
            Ok(s) => s,
            Err(e) => {
                let _ = store.finish_import_job(job, "failed", (0, 0, 0), &json!([]));
                self.ops.fail(op, e.code, e.message);
                return;
            }
        };
        let total = summary.rows.len();
        let mut errors = row_errors(&summary.rows);
        let invalid = summary
            .rows
            .iter()
            .filter(|p| matches!(p.plan, Plan::Error(_)))
            .count() as u64;
        let (mut succeeded, mut failed, mut skipped) = (0u64, invalid, 0u64);
        let mut clients: HashMap<String, ClientId> = HashMap::new();
        let mut tags: HashMap<String, TagId> = HashMap::new();
        let templates: HashMap<String, TemplateId> = store
            .list_templates(ws)
            .unwrap_or_default()
            .into_iter()
            .map(|t| (name_key(&t.name), t.id))
            .collect();
        let mut done_rows = 0usize;
        let mut cancelled = false;
        for chunk in summary.rows.chunks(IMPORT_BATCH) {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let mut creates: Vec<(u32, NewProfile)> = vec![];
            for p in chunk {
                let Some(d) = &p.data else { continue };
                let resolve = |store: &LocalStore,
                               clients: &mut HashMap<String, ClientId>,
                               tags: &mut HashMap<String, TagId>|
                 -> Result<(Option<ClientId>, Vec<TagId>), IpcError> {
                    let client = match &p.client {
                        None => None,
                        Some(c) => Some(match clients.get(&name_key(c)) {
                            Some(id) => id.clone(),
                            None => {
                                let id = store.ensure_client(ws, c)?;
                                clients.insert(name_key(c), id.clone());
                                id
                            }
                        }),
                    };
                    let mut ids = vec![];
                    for t in &d.tags {
                        let id = match tags.get(&name_key(t)) {
                            Some(id) => id.clone(),
                            None => {
                                let id = store.ensure_tag(ws, t)?.id;
                                tags.insert(name_key(t), id.clone());
                                id
                            }
                        };
                        ids.push(id);
                    }
                    Ok((client, ids))
                };
                match &p.plan {
                    Plan::Create => {
                        let Ok((client, tag_ids)) = resolve(store, &mut clients, &mut tags) else {
                            failed += 1;
                            errors.push(RowError {
                                row: p.row,
                                field: "row".into(),
                                code: "write_failed",
                                message: "could not be saved".into(),
                            });
                            continue;
                        };
                        let Ok(id) = ProfileId::generate() else {
                            continue;
                        };
                        let mut new = NewProfile::basic(id, Some(ws.clone()), &d.name, client);
                        if let Some(t) = d
                            .template
                            .as_ref()
                            .and_then(|t| templates.get(&name_key(t)))
                        {
                            let _ = self.apply_template(store, ws, t, &mut new);
                        }
                        // Row values override the template's defaults.
                        if !d.start_urls.is_empty() {
                            new.start_urls = d.start_urls.clone();
                        }
                        for (slot, v) in [
                            (&mut new.camera, d.camera),
                            (&mut new.microphone, d.microphone),
                            (&mut new.location, d.location),
                        ] {
                            if v != pb_runtime::PermissionDefault::Ask {
                                *slot = v;
                            }
                        }
                        if !d.notes.is_empty() {
                            new.notes = d.notes.clone();
                        }
                        for t in tag_ids {
                            if !new.tags.contains(&t) {
                                new.tags.push(t);
                            }
                        }
                        new.favourite = d.favourite;
                        new.import_ref = Some(import_ref(digest, p.row));
                        creates.push((p.row, new));
                    }
                    Plan::Update(_, _) if applied.lock().is_ok_and(|a| a.contains(&p.row)) => {
                        skipped += 1; // updated by an earlier, cancelled run of this import
                    }
                    Plan::Update(id, preview_version) => {
                        let expected = updates.get(&p.row).map_or(*preview_version, |(_, v)| *v);
                        let result =
                            resolve(store, &mut clients, &mut tags).and_then(|(_, tag_ids)| {
                                let existing =
                                    store.get_profile(id)?.ok_or(ipc::UNKNOWN_PROFILE)?;
                                let mut all: Vec<TagId> =
                                    existing.tags.into_iter().map(|t| t.id).collect();
                                for t in tag_ids {
                                    if !all.contains(&t) {
                                        all.push(t);
                                    }
                                }
                                store
                                    .update_profile(
                                        id,
                                        ProfileUpdate {
                                            notes: (!d.notes.is_empty())
                                                .then_some(d.notes.as_str()),
                                            start_urls: (!d.start_urls.is_empty())
                                                .then_some(d.start_urls.as_slice()),
                                            camera: Some(d.camera),
                                            microphone: Some(d.microphone),
                                            location: Some(d.location),
                                            favourite: Some(d.favourite),
                                            tags: Some(&all),
                                            ..ProfileUpdate::default()
                                        },
                                        expected,
                                    )
                                    .map_err(IpcError::from)
                            });
                        match result {
                            Ok(_) => {
                                succeeded += 1;
                                if let Ok(mut a) = applied.lock() {
                                    a.insert(p.row);
                                }
                            }
                            Err(e) => {
                                failed += 1;
                                errors.push(RowError {
                                    row: p.row,
                                    field: "row".into(),
                                    code: if e.code == "VERSION_CONFLICT" { "changed_since_preview" } else { "write_failed" },
                                    message: if e.code == "VERSION_CONFLICT" {
                                        "the existing profile changed after the preview; it was not overwritten".into()
                                    } else {
                                        "could not be saved".into()
                                    },
                                });
                            }
                        }
                    }
                    Plan::SkipDuplicate | Plan::AlreadyImported => skipped += 1,
                    Plan::Error(_) => {}
                }
            }
            let (rows, batch): (Vec<u32>, Vec<NewProfile>) = creates.into_iter().unzip();
            match store.insert_profiles(&batch) {
                Ok(inserted) => {
                    for ok in inserted {
                        if ok {
                            succeeded += 1;
                        } else {
                            skipped += 1; // already imported by an earlier run
                        }
                    }
                }
                Err(_) => {
                    failed += rows.len() as u64;
                    errors.extend(rows.into_iter().map(|row| RowError {
                        row,
                        field: "row".into(),
                        code: "write_failed",
                        message: "could not be saved".into(),
                    }));
                }
            }
            done_rows += chunk.len();
            let _ = store.import_progress(job, succeeded, failed, skipped);
            self.ops
                .progress(op, done_rows as f32 / total.max(1) as f32);
        }
        errors.truncate(MAX_ERRORS);
        let status = if cancelled {
            "cancelled"
        } else if failed > 0 {
            "completed_with_errors"
        } else {
            "completed"
        };
        let _ = store.finish_import_job(
            job,
            status,
            (succeeded, failed, skipped),
            &serde_json::to_value(&errors).unwrap_or_else(|_| json!([])),
        );
        let _ = store.audit(
            None,
            "import",
            status,
            None,
            Some(&format!(
                "created/updated {succeeded}, failed {failed}, skipped {skipped}"
            )),
        );
        if cancelled {
            self.ops.fail(
                op,
                "IMPORT_CANCELLED",
                "Import cancelled. Rows already imported were kept; running the same file again continues safely.",
            );
        } else {
            self.ops.succeed(op);
        }
    }

    // ------------------------------------------------------------------------- export
    /// Builds an export of the selected profiles' configuration. Notes that look like secrets are withheld.
    pub fn prepare_export(
        &self,
        selection: Selection,
        format: ExportFormat,
        include_notes: bool,
    ) -> Result<PreparedExport, IpcError> {
        let store = self.store()?;
        let ws = self.workspace(&store)?;
        let ids = self.resolve_selection(&store, &ws, selection)?;
        authz::authorize(Action::ExportConfiguration, ids.len())?;
        let templates: HashMap<String, String> = store
            .list_templates(&ws)?
            .into_iter()
            .map(|t| (t.id.to_string(), t.name))
            .collect();
        let mut withheld = 0usize;
        let mut profiles = Vec::with_capacity(ids.len());
        for id in &ids {
            let Some(p) = store.get_profile(id)? else {
                continue;
            };
            if p.workspace_id.as_ref() != Some(&ws) {
                continue;
            }
            let notes = if !include_notes {
                String::new()
            } else if pb_import::notes::secret_hint(&p.notes).is_some() {
                withheld += 1;
                String::new()
            } else {
                p.notes
            };
            profiles.push(pb_import::export::ExportProfile {
                name: p.name,
                client: p.client_name,
                tags: p.tags.into_iter().map(|t| t.name).collect(),
                notes,
                start_urls: p.start_urls,
                camera: p.camera,
                microphone: p.microphone,
                location: p.location,
                favourite: p.favourite,
                template: p
                    .template_id
                    .and_then(|t| templates.get(t.as_str()).cloned()),
            });
        }
        let now = crate::transfer::utc_now();
        let bytes = match format {
            ExportFormat::Csv => {
                pb_import::export::to_csv(&profiles).map_err(|_| ipc::EXPORT_FAILED)?
            }
            ExportFormat::Json => pb_import::export::to_json(&profiles, &now),
            ExportFormat::Bundle => {
                pb_import::export::to_bundle(&profiles, &now).map_err(|_| ipc::EXPORT_FAILED)?
            }
        };
        let ext = match format {
            ExportFormat::Csv => "csv",
            ExportFormat::Json => "json",
            ExportFormat::Bundle => "zip",
        };
        Ok(PreparedExport {
            bytes,
            count: profiles.len(),
            notes_withheld: withheld,
            suggested_name: format!("profiles-{}.{ext}", &now[..10]),
        })
    }

    /// Writes an export next to its final name first, then renames it into place.
    pub fn write_export(
        &self,
        path: &Path,
        prepared: &PreparedExport,
    ) -> Result<ExportResult, IpcError> {
        let tmp = path.with_extension("pb-tmp");
        std::fs::write(&tmp, &prepared.bytes).map_err(|_| ipc::EXPORT_FAILED)?;
        if std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err(ipc::EXPORT_FAILED);
        }
        if let Ok(store) = self.store() {
            let _ = store.audit(
                None,
                "export",
                "ok",
                None,
                Some(&format!("{} profiles", prepared.count)),
            );
        }
        Ok(ExportResult {
            path: Some(path.to_string_lossy().into_owned()),
            exported: prepared.count,
            notes_withheld: prepared.notes_withheld,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Json,
    Bundle,
}

pub struct PreparedExport {
    pub bytes: Vec<u8>,
    pub count: usize,
    pub notes_withheld: usize,
    pub suggested_name: String,
}

#[derive(Serialize)]
pub struct ExportResult {
    /// `None` when the save dialog was cancelled.
    pub path: Option<String>,
    pub exported: usize,
    pub notes_withheld: usize,
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
