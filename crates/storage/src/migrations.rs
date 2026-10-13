//! Versioned local schema migrations.
//!
//! Rules (milestone 02, step 4):
//!  - Foreign keys ON and WAL journal mode.
//!  - Before upgrading an existing database, a consistent copy is written next to it (`VACUUM INTO`).
//!  - ALL pending migrations run in ONE transaction together with the `user_version` bump. If any step fails, or
//!    the process is killed mid-way, nothing is committed: the previous database stays intact and usable, and the
//!    caller shows a recovery action (retry / restore backup / export diagnostics).
//!  - A database written by a newer build is refused rather than modified.

use pb_runtime::{ClientId, TagId, WorkspaceId};
use rusqlite::{Connection, Transaction, params};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 5;

type Step = fn(&Transaction<'_>) -> rusqlite::Result<()>;

/// (version reached after the step, human name, step)
pub(crate) const MIGRATIONS: &[(i64, &str, Step)] = &[
    (1, "initial", v1),
    (2, "manager_records", v2),
    (3, "runtime_lifecycle", v3),
    (4, "profile_management", v4),
    (5, "proxies_and_privacy", v5),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationFailure {
    pub from: i64,
    pub to: i64,
    pub step: String,
    pub backup: Option<PathBuf>,
}

pub(crate) fn current_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("pragma user_version", [], |r| r.get(0))
}

/// Returns the backup path if one was written.
pub(crate) fn backup_before_upgrade(
    conn: &Connection,
    db_path: &Path,
    from: i64,
) -> rusqlite::Result<Option<PathBuf>> {
    if from == 0 {
        return Ok(None); // brand-new database: nothing to protect
    }
    let file_name = db_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "local.db".into());
    let backup = db_path.with_file_name(format!("{file_name}.v{from}.bak"));
    if backup.exists() {
        std::fs::remove_file(&backup).map_err(|_| rusqlite::Error::InvalidPath(backup.clone()))?;
    }
    conn.execute("vacuum into ?1", params![backup.to_string_lossy()])?;
    Ok(Some(backup))
}

/// Runs every pending step inside one transaction. `fail_at` exists only for tests that simulate a crash/failure.
pub(crate) fn apply(
    conn: &mut Connection,
    from: i64,
    fail_at: Option<i64>,
) -> Result<(), (i64, String)> {
    let tx = conn.transaction().map_err(|e| (from, e.to_string()))?;
    for (version, name, step) in MIGRATIONS.iter().filter(|(v, _, _)| *v > from) {
        if fail_at == Some(*version) {
            return Err((*version, format!("{name}: simulated failure")));
        }
        step(&tx).map_err(|e| (*version, format!("{name}: {e}")))?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| (SCHEMA_VERSION, e.to_string()))?;
    tx.commit().map_err(|e| (SCHEMA_VERSION, e.to_string()))
    // On any early return the transaction is dropped and rolled back: the previous schema remains.
}

const NOW: &str = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

fn v1(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(&format!(
        "create table profiles (
           id            text primary key check (id glob 'prf_[0-9A-Z]*' and length(id) = 30),
           org_id        text,
           name          text not null check (length(name) between 1 and 120),
           client_label  text check (client_label is null or length(client_label) between 1 and 120),
           folder_label  text check (folder_label is null or length(folder_label) between 1 and 120),
           search_text   text not null,
           version       integer not null default 1,
           created_at    text not null default {NOW},
           updated_at    text not null default {NOW}
         ) strict;
         create index profiles_name_idx on profiles (name, id);
         create table processes (
           profile_id  text primary key references profiles(id) on delete cascade,
           pid         integer not null,
           started_at  text not null default {NOW}
         ) strict;
         create table pending_changes (
           seq         integer primary key autoincrement,
           profile_id  text references profiles(id) on delete cascade,
           kind        text not null,
           payload     text not null,
           created_at  text not null default {NOW}
         ) strict;"
    ))
}

fn v2(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(&format!(
        "create table workspaces (
           id          text primary key check (id glob 'wsp_[0-9A-Z]*' and length(id) = 30),
           name        text not null check (length(name) between 1 and 80),
           kind        text not null default 'local' check (kind in ('local')),
           created_at  text not null default {NOW}
         ) strict;
         alter table profiles add column workspace_id text references workspaces(id) on delete restrict;
         alter table profiles add column notes text not null default '' check (length(notes) <= 2000);
         create index profiles_ws_name_idx on profiles (workspace_id, name, id);

         create table devices (
           id               text primary key check (id glob 'dev_[0-9A-Z]*' and length(id) = 30),
           installation_id  text not null unique check (length(installation_id) = 32),
           platform         text not null,
           architecture     text not null,
           created_at       text not null default {NOW}
         ) strict;

         create table settings (
           key         text primary key,
           version     integer not null default 1 check (version >= 1),
           value_json  text not null check (json_valid(value_json)),
           updated_at  text not null default {NOW}
         ) strict;

         create table runtime_installations (
           version      text not null,
           platform     text not null,
           digest       text not null check (length(digest) = 64),
           verified_at  text,
           path         text not null,
           status       text not null check (status in ('staged', 'verified', 'quarantined', 'failed', 'removed', 'dev')),
           updated_at   text not null default {NOW},
           primary key (version, platform)
         ) strict;

         create table timings (
           seq          integer primary key autoincrement,
           kind         text not null,
           millis       real not null check (millis >= 0),
           recorded_at  text not null default {NOW}
         ) strict;
         create index timings_kind_idx on timings (kind, seq);

         create table auth_transactions (
           state_hash   text primary key check (length(state_hash) = 64),
           created_at   text not null default {NOW},
           expires_at   text not null,
           consumed_at  text
         ) strict;

         alter table processes add column process_start_time integer;
         alter table processes add column executable text;"
    ))?;

    // Profiles created before workspaces existed move into one default local workspace.
    let orphaned: i64 = tx.query_row(
        "select count(*) from profiles where workspace_id is null",
        [],
        |r| r.get(0),
    )?;
    if orphaned > 0 {
        let ws = WorkspaceId::generate().map_err(|_| rusqlite::Error::InvalidQuery)?;
        tx.execute(
            "insert into workspaces (id, name) values (?1, 'My workspace')",
            params![ws.as_str()],
        )?;
        tx.execute(
            "update profiles set workspace_id = ?1 where workspace_id is null",
            params![ws.as_str()],
        )?;
    }
    Ok(())
}

/// Milestone 03: per-profile runtime metadata and settings, process runs, local audit log.
fn v3(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(&format!(
        "alter table profiles add column client_colour text
           check (client_colour is null or (length(client_colour) = 7
             and client_colour glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
         alter table profiles add column start_urls text not null default '[]'
           check (json_valid(start_urls) and json_type(start_urls) = 'array');
         alter table profiles add column download_dir text;
         alter table profiles add column perm_camera text not null default 'ask'
           check (perm_camera in ('ask', 'block', 'allow'));
         alter table profiles add column perm_microphone text not null default 'ask'
           check (perm_microphone in ('ask', 'block', 'allow'));
         alter table profiles add column perm_location text not null default 'ask'
           check (perm_location in ('ask', 'block', 'allow'));
         alter table profiles add column runtime_version text;
         alter table profiles add column data_dir_ref text;
         alter table profiles add column state text not null default 'stopped'
           check (state in ('stopped', 'starting', 'running', 'stopping', 'crashed', 'recovering'));
         alter table profiles add column last_started_at text;
         alter table profiles add column last_clean_shutdown_at text;
         alter table profiles add column schema_version integer not null default 1;
         alter table profiles add column crash_count integer not null default 0 check (crash_count >= 0);
         alter table profiles add column last_error text check (last_error is null or length(last_error) <= 64);
         alter table profiles add column last_backup_at text;
         alter table profiles add column backup_runtime_version text;
         update profiles set data_dir_ref = id;

         create table process_runs (
           run_id           text primary key check (run_id glob 'run_*' and length(run_id) = 28),
           profile_id       text not null references profiles(id) on delete cascade,
           pid              integer not null,
           start_identity   text not null check (json_valid(start_identity)),
           runtime_version  text,
           exit_code        integer,
           outcome          text not null default 'running'
             check (outcome in ('running', 'clean', 'crashed', 'early_exit', 'forced', 'interrupted', 'lost')),
           started_at       text not null default {NOW},
           ended_at         text
         ) strict;
         create unique index process_runs_one_active on process_runs (profile_id) where ended_at is null;
         create index process_runs_profile_idx on process_runs (profile_id, started_at);
         insert into process_runs (run_id, profile_id, pid, start_identity, started_at)
           select 'run_' || lower(hex(randomblob(12))), profile_id, pid,
                  json_object('start_time', process_start_time, 'exe', executable), started_at
             from processes;
         update profiles set state = 'running' where id in (select profile_id from processes);
         drop table processes;

         create table audit_log (
           seq         integer primary key autoincrement,
           at          text not null default {NOW},
           profile_id  text,
           action      text not null check (action in ('start', 'stop', 'force_stop', 'exit', 'crash', 'adopt',
                         'interrupted', 'recover', 'backup', 'runtime_install', 'runtime_remove')),
           outcome     text not null check (length(outcome) <= 40),
           run_id      text,
           detail      text check (detail is null or length(detail) <= 200)
         ) strict;
         create index audit_log_profile_idx on audit_log (profile_id, seq);

         alter table runtime_installations add column distribution text;
         alter table runtime_installations add column executable text;"
    ))
}

/// Key used for search, sorting and per-workspace uniqueness of names: trimmed, Unicode lower case, accents
/// removed (NFKD without combining marks), so "École", "ecole" and "ÉCOLE" match and sort together.
pub fn name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    use unicode_normalization::char::is_combining_mark;
    name.trim()
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

/// Milestone 04: clients (folders), tags, templates, favourites, archive, trash, saved filters, import jobs.
/// Free-text client labels become client records; folder labels become tags. Search keys become Unicode-aware.
fn v4(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(&format!(
        "create table clients_local (
           id            text primary key check (id glob 'cli_*' and length(id) = 30),
           workspace_id  text not null references workspaces(id) on delete restrict,
           name          text not null check (length(name) between 1 and 120),
           name_key      text not null,
           colour        text check (colour is null or (length(colour) = 7
                           and colour glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
           archived_at   text,
           version       integer not null default 1,
           created_at    text not null default {NOW},
           updated_at    text not null default {NOW}
         ) strict;
         create unique index clients_ws_name_key on clients_local (workspace_id, name_key);

         create table tags (
           id            text primary key check (id glob 'tag_*' and length(id) = 30),
           workspace_id  text not null references workspaces(id) on delete restrict,
           name          text not null check (length(name) between 1 and 40),
           name_key      text not null,
           created_at    text not null default {NOW}
         ) strict;
         create unique index tags_ws_name_key on tags (workspace_id, name_key);

         create table profile_tags (
           profile_id  text not null references profiles(id) on delete cascade,
           tag_id      text not null references tags(id) on delete cascade,
           primary key (profile_id, tag_id)
         ) strict, without rowid;
         create index profile_tags_tag_idx on profile_tags (tag_id, profile_id);

         create table templates (
           id              text primary key check (id glob 'tpl_*' and length(id) = 30),
           workspace_id    text not null references workspaces(id) on delete restrict,
           name            text not null check (length(name) between 1 and 120),
           schema_version  integer not null default 1 check (schema_version >= 1),
           config_json     text not null check (json_valid(config_json) and json_type(config_json) = 'object'),
           version         integer not null default 1,
           created_at      text not null default {NOW},
           updated_at      text not null default {NOW}
         ) strict;

         create table trash_entries (
           profile_id   text primary key references profiles(id) on delete cascade,
           trashed_at   text not null default {NOW},
           purge_after  text not null
         ) strict;
         create index trash_purge_idx on trash_entries (purge_after);

         create table saved_filters (
           id            text primary key check (id glob 'flt_*' and length(id) = 30),
           workspace_id  text not null references workspaces(id) on delete cascade,
           name          text not null check (length(name) between 1 and 60),
           filter_json   text not null check (json_valid(filter_json) and json_type(filter_json) = 'object'),
           created_at    text not null default {NOW}
         ) strict;

         create table import_jobs (
           id             text primary key check (id glob 'imp_*' and length(id) = 30),
           workspace_id   text not null references workspaces(id) on delete cascade,
           status         text not null check (status in ('previewed', 'running', 'completed',
                            'completed_with_errors', 'failed', 'cancelled', 'interrupted')),
           source_name    text not null check (length(source_name) <= 255),
           source_digest  text not null check (length(source_digest) = 64),
           format         text not null check (format in ('csv', 'json', 'bundle')),
           settings_json  text not null check (json_valid(settings_json)),
           total          integer not null default 0,
           succeeded      integer not null default 0,
           failed         integer not null default 0,
           skipped        integer not null default 0,
           errors_json    text not null default '[]' check (json_valid(errors_json)),
           created_at     text not null default {NOW},
           started_at     text,
           finished_at    text
         ) strict;
         create index import_jobs_ws_idx on import_jobs (workspace_id, created_at);

         alter table profiles add column client_id text references clients_local(id) on delete set null;
         alter table profiles add column favourite integer not null default 0 check (favourite in (0, 1));
         alter table profiles add column archived_at text;
         alter table profiles add column template_id text references templates(id) on delete set null;
         alter table profiles add column proxy_label text check (proxy_label is null or length(proxy_label) <= 120);
         alter table profiles add column import_ref text check (import_ref is null or length(import_ref) <= 100);
         create unique index profiles_import_ref on profiles (import_ref) where import_ref is not null;
         create index profiles_ws_key_idx on profiles (workspace_id, search_text, id);
         create index profiles_ws_client_idx on profiles (workspace_id, client_id);
         create index profiles_ws_used_idx on profiles (workspace_id, last_started_at);"
    ))?;

    // Free-text client labels -> client records (one per workspace and case-insensitive name).
    let labels: Vec<(String, String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "select workspace_id, client_label, max(client_colour) from profiles
              where client_label is not null and workspace_id is not null
              group by workspace_id, client_label order by workspace_id, client_label",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut clients: std::collections::HashMap<(String, String), String> = Default::default();
    for (ws, label, colour) in labels {
        let key = (ws.clone(), name_key(&label));
        let id = match clients.get(&key) {
            Some(id) => id.clone(),
            None => {
                let id = ClientId::generate()
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    .to_string();
                tx.execute(
                    "insert into clients_local (id, workspace_id, name, name_key, colour) values (?1, ?2, ?3, ?4, ?5)",
                    params![id, ws, label.trim(), key.1, colour],
                )?;
                clients.insert(key, id.clone());
                id
            }
        };
        tx.execute(
            "update profiles set client_id = ?1 where workspace_id = ?2 and client_label = ?3",
            params![id, ws, label],
        )?;
    }

    // Folder labels -> tags (tags are at most 40 characters).
    let folders: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "select distinct workspace_id, folder_label from profiles
              where folder_label is not null and workspace_id is not null",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut tags: std::collections::HashMap<(String, String), String> = Default::default();
    for (ws, folder) in folders {
        let name: String = folder.trim().chars().take(40).collect();
        if name.is_empty() {
            continue;
        }
        let key = (ws.clone(), name_key(&name));
        let id = match tags.get(&key) {
            Some(id) => id.clone(),
            None => {
                let id = TagId::generate()
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    .to_string();
                tx.execute(
                    "insert into tags (id, workspace_id, name, name_key) values (?1, ?2, ?3, ?4)",
                    params![id, ws, name, key.1],
                )?;
                tags.insert(key, id.clone());
                id
            }
        };
        tx.execute(
            "insert or ignore into profile_tags (profile_id, tag_id)
               select id, ?1 from profiles where workspace_id = ?2 and folder_label = ?3",
            params![id, ws, folder],
        )?;
    }

    // Unicode-aware search key (SQLite's lower() only folds ASCII).
    let names: Vec<(String, String)> = {
        let mut stmt = tx.prepare("select id, name from profiles")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    {
        let mut stmt = tx.prepare("update profiles set search_text = ?2 where id = ?1")?;
        for (id, name) in names {
            stmt.execute(params![id, name_key(&name)])?;
        }
    }

    tx.execute_batch(
        "alter table profiles drop column client_label;
         alter table profiles drop column client_colour;
         alter table profiles drop column folder_label;

         create table audit_log_v4 (
           seq         integer primary key autoincrement,
           at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           profile_id  text,
           action      text not null check (action in ('start', 'stop', 'force_stop', 'exit', 'crash', 'adopt',
                         'interrupted', 'recover', 'backup', 'runtime_install', 'runtime_remove',
                         'create', 'trash', 'restore', 'delete', 'purge', 'bulk', 'import', 'export')),
           outcome     text not null check (length(outcome) <= 40),
           run_id      text,
           detail      text check (detail is null or length(detail) <= 200)
         ) strict;
         insert into audit_log_v4 (seq, at, profile_id, action, outcome, run_id, detail)
           select seq, at, profile_id, action, outcome, run_id, detail from audit_log;
         drop table audit_log;
         alter table audit_log_v4 rename to audit_log;
         create index audit_log_profile_idx on audit_log (profile_id, seq);",
    )
}

/// Milestone 05: proxies (metadata only: logins live in the OS keychain under `credential_ref`), per-profile routing,
/// connectivity checks (kept 7 days), privacy/environment settings, and the loopback gateway of each running profile.
fn v5(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(&format!(
        "create table proxy_configs (
           id              text primary key check (id glob 'prx_*' and length(id) = 30),
           workspace_id    text not null references workspaces(id) on delete restrict,
           owner_scope     text not null default 'workspace' check (owner_scope in ('workspace')),
           name            text not null check (length(name) between 1 and 80),
           name_key        text not null,
           type            text not null check (type in ('http', 'https', 'socks5')),
           host            text not null check (length(host) between 1 and 253),
           port            integer not null check (port between 1 and 65535),
           credential_ref  text check (credential_ref is null or credential_ref glob 'proxy:prx_*'),
           expires_at      text check (expires_at is null or expires_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
           notes           text not null default '' check (length(notes) <= 500),
           version         integer not null default 1,
           created_at      text not null default {NOW},
           updated_at      text not null default {NOW}
         ) strict;
         create unique index proxy_configs_ws_name on proxy_configs (workspace_id, name_key);

         create table profile_network_settings (
           profile_id      text primary key references profiles(id) on delete cascade,
           proxy_id        text references proxy_configs(id) on delete restrict,
           fail_closed     integer not null default 1 check (fail_closed in (0, 1)),
           config_version  integer not null default 1
         ) strict;
         create index profile_network_proxy_idx on profile_network_settings (proxy_id);

         create table network_checks (
           id          text primary key check (id glob 'nck_*' and length(id) = 30),
           proxy_id    text not null references proxy_configs(id) on delete cascade,
           result      text not null check (result in ('ok', 'error')),
           error_code  text check (error_code is null or length(error_code) <= 40),
           latency_ms  integer check (latency_ms is null or latency_ms >= 0),
           egress_ip   text check (egress_ip is null or length(egress_ip) <= 45),
           checked_at  text not null default {NOW}
         ) strict;
         create index network_checks_proxy_idx on network_checks (proxy_id, checked_at);
         create index network_checks_age_idx on network_checks (checked_at);

         create table gateway_sessions (
           profile_id     text primary key references profiles(id) on delete cascade,
           port           integer not null check (port between 1 and 65535),
           proxy_id       text not null,
           proxy_version  integer not null,
           fail_closed    integer not null check (fail_closed in (0, 1)),
           started_at     text not null default {NOW}
         ) strict;

         alter table profiles add column privacy_json text not null default '{{}}'
           check (json_valid(privacy_json) and json_type(privacy_json) = 'object');

         create table audit_log_v5 (
           seq         integer primary key autoincrement,
           at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           profile_id  text,
           action      text not null check (action in ('start', 'stop', 'force_stop', 'exit', 'crash', 'adopt',
                         'interrupted', 'recover', 'backup', 'runtime_install', 'runtime_remove',
                         'create', 'trash', 'restore', 'delete', 'purge', 'bulk', 'import', 'export',
                         'proxy', 'network')),
           outcome     text not null check (length(outcome) <= 40),
           run_id      text,
           detail      text check (detail is null or length(detail) <= 200)
         ) strict;
         insert into audit_log_v5 (seq, at, profile_id, action, outcome, run_id, detail)
           select seq, at, profile_id, action, outcome, run_id, detail from audit_log;
         drop table audit_log;
         alter table audit_log_v5 rename to audit_log;
         create index audit_log_profile_idx on audit_log (profile_id, seq);"
    ))
}
