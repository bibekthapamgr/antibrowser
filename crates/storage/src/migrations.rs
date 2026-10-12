//! Versioned local schema migrations.
//!
//! Rules (milestone 02, step 4):
//!  - Foreign keys ON and WAL journal mode.
//!  - Before upgrading an existing database, a consistent copy is written next to it (`VACUUM INTO`).
//!  - ALL pending migrations run in ONE transaction together with the `user_version` bump. If any step fails, or
//!    the process is killed mid-way, nothing is committed: the previous database stays intact and usable, and the
//!    caller shows a recovery action (retry / restore backup / export diagnostics).
//!  - A database written by a newer build is refused rather than modified.

use pb_runtime::WorkspaceId;
use rusqlite::{Connection, Transaction, params};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 3;

type Step = fn(&Transaction<'_>) -> rusqlite::Result<()>;

/// (version reached after the step, human name, step)
pub(crate) const MIGRATIONS: &[(i64, &str, Step)] = &[
    (1, "initial", v1),
    (2, "manager_records", v2),
    (3, "runtime_lifecycle", v3),
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
