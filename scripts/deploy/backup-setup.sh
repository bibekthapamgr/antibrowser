#!/usr/bin/env bash
# Project Browser — off-site backups for the test server (milestone 12, ADR-0019; runbook: docs/security/dr-runbook.md).
#
#   Database          pgBackRest: point-in-time recovery for PostgreSQL. A full backup weekly, a differential one
#                     daily, and the write-ahead log pushed at least every 60 seconds, to a Cloudflare R2 bucket.
#                     Encrypted here (AES-256) before upload with a passphrase that exists only on this server and in
#                     your offline copy. Retention: 4 weekly full backups with their log (about 4-5 weeks).
#   Snapshot objects  rclone copies the snapshot storage to the same bucket every 2 minutes with a READ-ONLY storage
#                     identity. Objects deleted here move to objects-deleted/<date>/ there; an R2 lifecycle rule you
#                     add deletes them after 30 days. Snapshots are already encrypted with organization keys, and the
#                     root key that unlocks those is never copied to R2.
#   Separation        The R2 token (limited to one bucket) and the passphrase are root-only files. The app's database
#                     roles and storage credentials cannot reach the backups; the backup jobs cannot change app data.
#                     A full disk is never caused by a broken upload: at most 2 GiB of log waits for R2, after which
#                     pgBackRest reports the gap instead of filling the disk.
#
# Usage (as root):
#   bash backup-setup.sh                    set up or update (vps-setup.sh runs it; does nothing until backup.env is
#                                           filled in)
#   bash backup-setup.sh status             last backups, log archiving, last object copy
#   bash backup-setup.sh backup-now [full|diff]
#   bash backup-setup.sh restore-server [--target 'YYYY-MM-DD HH:MM:SS+00'] --yes-replace-this-database
#                                           replace THIS server's database with the off-site backup and copy the
#                                           snapshot objects back (a lost or corrupted server; see the runbook)
# The timers run a root-owned copy of this script (/usr/local/libexec/pb-backup), never the pb user's checkout.
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR
cd /

ENV_DIR=/etc/project-browser
BACKUP_ENV=$ENV_DIR/backup.env
CIPHER_FILE=$ENV_DIR/backup-cipher-pass
STORE_RO_ENV=$ENV_DIR/store-readonly.env
RCLONE_DIR=/etc/pb-backup
RCLONE_CONF=$RCLONE_DIR/rclone.conf
PGBR_CONF=/etc/pgbackrest/pgbackrest.conf
STATE_DIR=/var/lib/pb-backup
LIBEXEC=/usr/local/libexec/pb-backup
BACKUP_USER=pb-backup
STANZA=pb
RCLONE_VERSION=v1.75.2
# R6: this server's snapshot bucket (pb-snapshots-dev, -staging or -prod), as the API is configured. The copy job
# runs as pb-backup, which cannot read api.env: setup records the bucket in bucket.env (its own file) for it.
OBJECT_BUCKET=$(sed -n 's/^OBJECT_STORE_BUCKET=//p' "$ENV_DIR/api.env" 2>/dev/null || true)
[[ -n $OBJECT_BUCKET ]] || OBJECT_BUCKET=$(sed -n 's/^OBJECT_BUCKET=//p' "$STATE_DIR/bucket.env" 2>/dev/null || true)
OBJECT_BUCKET=${OBJECT_BUCKET:-pb-snapshots-dev}
[[ $OBJECT_BUCKET =~ ^pb-snapshots-(dev|staging|prod)$ ]] || { echo "unexpected OBJECT_STORE_BUCKET in $ENV_DIR/api.env" >&2; exit 1; }
ARCHIVE_QUEUE_MAX=2GiB

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }

family() {
  . /etc/os-release
  case "${ID} ${ID_LIKE:-}" in
    *rhel*|*fedora*|*centos*|*rocky*|*almalinux*) echo rhel ;;
    *) echo debian ;;
  esac
}
pg_bin() { [[ $(family) == rhel ]] && echo /usr/pgsql-18/bin || echo /usr/lib/postgresql/18/bin; }
pg_service() { [[ $(family) == rhel ]] && echo postgresql-18 || echo postgresql; }
psql_su() { (cd /tmp && runuser -u postgres -- "$(pg_bin)/psql" -X -q -tA -v ON_ERROR_STOP=1 "$@"); }
as_pg() { (cd /tmp && runuser -u postgres -- "$@"); }

# Reads backup.env without executing it (only KEY=value lines; values are never echoed).
load_backup_env() {
  R2_ACCOUNT_ID=""; R2_BUCKET=""; R2_ACCESS_KEY_ID=""; R2_SECRET_ACCESS_KEY=""; R2_ENDPOINT=""; BACKUP_CA_FILE=""
  BACKUP_RETENTION_FULL=4
  [[ -f $BACKUP_ENV ]] || return 0
  while IFS='=' read -r key value; do
    [[ $key =~ ^[A-Z0-9_]+$ ]] || continue
    value=${value%$'\r'}
    case "$key" in
      R2_ACCOUNT_ID|R2_BUCKET|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ENDPOINT|BACKUP_CA_FILE|BACKUP_RETENTION_FULL)
        printf -v "$key" '%s' "$value" ;;
    esac
  done < <(grep -E '^[A-Z0-9_]+=' "$BACKUP_ENV")
}

configured() {
  [[ -n $R2_BUCKET && -n $R2_ACCESS_KEY_ID && -n $R2_SECRET_ACCESS_KEY && ( -n $R2_ACCOUNT_ID || -n $R2_ENDPOINT ) ]]
}

# host[:port] of the S3 endpoint (R2: <account>.r2.cloudflarestorage.com).
endpoint() { if [[ -n $R2_ENDPOINT ]]; then echo "$R2_ENDPOINT"; else echo "$R2_ACCOUNT_ID.r2.cloudflarestorage.com"; fi; }

write_template() {
  [[ -f $BACKUP_ENV ]] && return 0
  # The folder exists (vps-setup.sh made it root:pb 0750 for the API); never change its owner or mode here.
  [[ -d $ENV_DIR ]] || die "$ENV_DIR is missing (run vps-setup.sh)"
  umask 077
  cat > "$BACKUP_ENV" <<'EOF'
# Off-site backups (milestone 12). Written once by vps-setup.sh; from then on this file is YOURS and never overwritten.
# Fill it in on the server (e.g. with nano), then run vps-setup.sh again. Never paste these values into a chat.
#
# 1. Cloudflare dashboard -> R2 -> Create bucket (for example pb-backups-test). Keep the default (no public access).
# 2. R2 -> Manage API tokens -> Create API token: permission "Object Read & Write", "Apply to specific buckets only"
#    -> that bucket. Copy the Access Key ID and Secret Access Key (shown once) and your Account ID below.
# 3. In the bucket's settings add an Object lifecycle rule: prefix "objects-deleted/", delete objects after 30 days.
#    Do NOT add a bucket lock rule: pgBackRest rewrites its own index files in place, and a lock refuses that.
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
# Weekly full database backups kept (each with its write-ahead log). 4 = about a month of point-in-time recovery.
BACKUP_RETENTION_FULL=4
EOF
  umask 022
  chmod 600 "$BACKUP_ENV"
}

# pgBackRest configuration (root:postgres 0640: PostgreSQL's archive command reads it).
write_pgbackrest_conf() {
  PG_DATA=$(psql_su -c 'show data_directory')
  PG_SOCKET=$(psql_su -c 'show unix_socket_directories' | cut -d, -f1 | xargs)
  EP=$(endpoint)
  EP_HOST=${EP%%:*}; EP_PORT=443; [[ $EP == *:* ]] && EP_PORT=${EP##*:}
  install -d -m 750 -o root -g postgres /etc/pgbackrest
  install -d -m 750 -o postgres -g postgres /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest \
    /var/lib/pgbackrest/lock
  umask 027
  cat > "$PGBR_CONF" <<EOF
# Written by backup-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) from $BACKUP_ENV (rewritten on every run).
[global]
repo1-type=s3
repo1-s3-endpoint=$EP_HOST
repo1-storage-port=$EP_PORT
repo1-s3-bucket=$R2_BUCKET
repo1-s3-region=auto
repo1-s3-uri-style=path
repo1-s3-key=$R2_ACCESS_KEY_ID
repo1-s3-key-secret=$R2_SECRET_ACCESS_KEY
repo1-path=/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$(cat "$CIPHER_FILE")
repo1-retention-full=$BACKUP_RETENTION_FULL
repo1-bundle=y
repo1-block=y
$( [[ -n $BACKUP_CA_FILE ]] && echo "repo1-storage-ca-file=$BACKUP_CA_FILE" )
compress-type=zst
process-max=1
start-fast=y
archive-async=y
archive-push-queue-max=$ARCHIVE_QUEUE_MAX
spool-path=/var/spool/pgbackrest
lock-path=/var/lib/pgbackrest/lock
log-path=/var/log/pgbackrest
log-level-console=info
log-level-file=info

[$STANZA]
pg1-path=$PG_DATA
pg1-socket-path=$PG_SOCKET
EOF
  umask 022
  chown root:postgres "$PGBR_CONF"; chmod 640 "$PGBR_CONF"
}

# ----------------------------------------------------------------------------- subcommands used by the timers
db_backup() {  # runs as postgres
  local type=${1:-auto}
  if [[ $type == auto ]]; then
    # Full on Sundays and whenever the newest full backup is older than 8 days; differential otherwise.
    local last_full
    last_full=$(pgbackrest --stanza=$STANZA --output=json info 2>/dev/null | /opt/node/bin/node -e '
      let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const stops = ((JSON.parse(d || "[]")[0] || {}).backup || []).filter((b) => b.type === "full").map((b) => b.timestamp.stop);
        console.log(stops.length ? Math.max(...stops) : "");
      });' || true)
    if [[ $(date -u +%u) == 7 || -z $last_full ]] || (( $(date +%s) - last_full > 8 * 86400 )); then
      type="full"
    else
      type="diff"
    fi
  fi
  pgbackrest --stanza=$STANZA --type="$type" backup
}

objects_copy() {  # runs as pb-backup (reads only its own files: rclone.conf and bucket.env)
  R2_BUCKET=$(sed -n 's/^R2_BUCKET=//p' "$STATE_DIR/bucket.env")
  [[ -n $R2_BUCKET ]] || { echo "no bucket configured" >&2; return 1; }
  local load_ca=()
  [[ -n ${BACKUP_CA_FILE:-} ]] && load_ca=(--ca-cert "$BACKUP_CA_FILE")
  local day; day=$(date -u +%F)
  /opt/rclone/current/rclone --config "$RCLONE_CONF" "${load_ca[@]}" sync "store:$OBJECT_BUCKET" \
    "r2:$R2_BUCKET/objects/$OBJECT_BUCKET" --backup-dir "r2:$R2_BUCKET/objects-deleted/$day/$OBJECT_BUCKET" \
    --size-only --fast-list --transfers 2 --checkers 4 --retries 3 --low-level-retries 10 --stats-one-line -v 2>&1 \
    | tail -5
  local count
  count=$(/opt/rclone/current/rclone --config "$RCLONE_CONF" "${load_ca[@]}" size --json "r2:$R2_BUCKET/objects/$OBJECT_BUCKET" 2>/dev/null || echo '{}')
  printf '{"at":"%s","copy":%s}\n' "$(date -u +%FT%TZ)" "$count" > "$STATE_DIR/objects.json"
}

# SELinux (AlmaLinux and other EL systems): PostgreSQL runs confined (postgresql_t) and starts pgBackRest's log
# upload itself. Let that domain reach HTTPS and use pgBackRest's own folders; nothing else is widened.
selinux_for_pgbackrest() {
  command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled || return 0
  local cil=/etc/pgbackrest/pb-pgbackrest.cil
  printf '%s\n' '; Project Browser: PostgreSQL archives its log to R2 over HTTPS through pgBackRest.' \
    '(allow postgresql_t http_port_t (tcp_socket (name_connect)))' > "$cil"
  if semodule -i "$cil" 2>/dev/null; then
    ok "SELinux: PostgreSQL may reach HTTPS for pgBackRest (module pb-pgbackrest)"
  else
    warn "SELinux: could not load $cil; if log archiving fails, see: ausearch -m avc -ts recent -c pgbackrest"
  fi
  chcon -R -t postgresql_db_t /var/spool/pgbackrest /var/lib/pgbackrest 2>/dev/null || true
  chcon -R -t postgresql_log_t /var/log/pgbackrest 2>/dev/null || true
}

# Packages (pgBackRest from the distribution) and rclone (pinned, SHA-256 verified).
install_tools() {
  if [[ $(family) == rhel ]]; then
    if ! rpm -q pgbackrest >/dev/null 2>&1; then
      # PostgreSQL's repository has pgBackRest; one of its libraries (libssh2) comes from EPEL on EL 8 and 9.
      if ! rpm -q epel-release >/dev/null 2>&1; then
        dnf install -y -q epel-release >/dev/null 2>&1 \
          || dnf install -y -q "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$(rpm -E %rhel).noarch.rpm" >/dev/null \
          || die "could not enable EPEL (needed for pgBackRest's libssh2)"
        ok "EPEL enabled (for pgBackRest's libssh2)"
      fi
      dnf install -y -q pgbackrest >/dev/null || die "could not install pgBackRest from the PostgreSQL repository"
    fi
    rpm -q unzip >/dev/null 2>&1 || dnf install -y -q unzip >/dev/null
  else
    dpkg -s pgbackrest >/dev/null 2>&1 || apt-get install -y -qq pgbackrest >/dev/null
    dpkg -s unzip >/dev/null 2>&1 || apt-get install -y -qq unzip >/dev/null
  fi
  ok "$(pgbackrest version)"

  case "$(uname -m)" in
    x86_64) RC_ASSET=rclone-$RCLONE_VERSION-linux-amd64; RC_SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702 ;;
    aarch64) RC_ASSET=rclone-$RCLONE_VERSION-linux-arm64; RC_SHA256=7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10 ;;
    *) die "unsupported CPU architecture" ;;
  esac
  if [[ ! -x /opt/rclone/$RCLONE_VERSION/rclone ]]; then
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 "https://github.com/rclone/rclone/releases/download/$RCLONE_VERSION/$RC_ASSET.zip" -o "$tmp/rc.zip"
    echo "$RC_SHA256  $tmp/rc.zip" | sha256sum -c --quiet - || die "the rclone download does not match its pinned SHA-256"
    unzip -q "$tmp/rc.zip" "$RC_ASSET/rclone" -d "$tmp"
    install -d -m 755 "/opt/rclone/$RCLONE_VERSION"
    install -m 755 "$tmp/$RC_ASSET/rclone" "/opt/rclone/$RCLONE_VERSION/rclone"
    rm -rf "$tmp"
  fi
  ln -sfn "/opt/rclone/$RCLONE_VERSION" /opt/rclone/current
  ok "rclone $RCLONE_VERSION (SHA-256 verified)"
}

# The database system the bucket's backups belong to: "" (none yet), or its system identifier. Fails when the
# backups cannot be read (wrong passphrase or token).
repo_system_id() {
  local json
  json=$(as_pg pgbackrest --stanza=$STANZA --output=json --log-level-console=off info) || return 1
  printf '%s' "$json" | /opt/node/bin/node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      // System identifiers exceed JavaScript numbers: read them as text.
      const s = (JSON.parse((d || "[]").replace(/"system-id":(\d+)/g, "\"system-id\":\"$1\""))[0]) || {};
      const db = (s.db || []).at(-1);
      console.log(s.status && s.status.code === 0 && db ? String(db["system-id"]) : "");
    });'
}
local_system_id() { psql_su -c 'select system_identifier from pg_control_system()'; }
last_archived() { psql_su -c "select coalesce(last_archived_wal, '') from pg_stat_archiver"; }

# ----------------------------------------------------------------------------- restore this server from R2
# Replaces THIS server's database with the off-site backup (the newest point, or --target in UTC) and copies every
# snapshot object back into the storage. For a lost or corrupted server; docs/security/dr-runbook.md has the order
# of steps (offline root key and passphrase first; afterwards vps-setup.sh twice and keycloak-setup.sh).
restore_server() {
  [[ $EUID -eq 0 ]] || die "run as root"
  local target="" confirm=0
  while [[ $# -gt 0 ]]; do
    case $1 in
      --target) target=${2:-}; shift 2 ;;
      --yes-replace-this-database) confirm=1; shift ;;
      *) die "unknown option $1 (restore-server [--target 'YYYY-MM-DD HH:MM:SS+00'] --yes-replace-this-database)" ;;
    esac
  done
  if [[ -n $target && ! $target =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}(:[0-9]{2})?\+00$ ]]; then
    die "--target must be a UTC time like '2026-10-14 08:30:00+00'"
  fi
  load_backup_env
  configured || die "fill in $BACKUP_ENV with the R2 bucket and a token for it first"
  [[ -s $CIPHER_FILE ]] || die "$CIPHER_FILE is missing: copy the backup passphrase from your offline copy (root, mode 600)"
  [[ -s $ENV_DIR/kms-root.json ]] || die "$ENV_DIR/kms-root.json is missing: copy the root key from your offline copy first"
  [[ -s $ENV_DIR/api.env ]] || die "run vps-setup.sh first: it installs PostgreSQL, the storage and the app"
  install_tools
  chown root:root "$CIPHER_FILE"; chmod 600 "$CIPHER_FILE"
  write_pgbackrest_conf
  selinux_for_pgbackrest   # the restored server fetches its log from R2 through pgBackRest, as PostgreSQL
  local repo_id here_id
  repo_id=$(repo_system_id) \
    || die "the backups in r2:$R2_BUCKET cannot be read: check the token in $BACKUP_ENV and that $CIPHER_FILE is the passphrase they were made with"
  [[ -n $repo_id ]] || die "r2:$R2_BUCKET holds no database backups"
  here_id=$(local_system_id)
  echo "    backups of database system $repo_id; this server's database: $here_id"
  as_pg pgbackrest --stanza=$STANZA info | sed 's/^/    /'
  (( confirm )) || die "this REPLACES this server's database with the backup above. Run again with --yes-replace-this-database"

  step "Restoring the database from r2:$R2_BUCKET${target:+ to $target}"
  if [[ $repo_id == "$here_id" && $(psql_su -c 'show archive_mode') == on ]]; then
    # The same database (corruption, a mistake): its newest changes go off-site first, so nothing is lost.
    local wal
    wal=$(psql_su -c 'select pg_walfile_name(pg_switch_wal())')
    for _ in $(seq 1 60); do
      [[ ! "$(last_archived)" < "$wal" ]] && break
      sleep 2
    done
  fi
  local unit
  for unit in pb-backup-db.timer pb-backup-objects.timer pb-worker pb-api keycloak; do
    systemctl stop "$unit" 2>/dev/null || true
  done
  local data aside
  data=$(psql_su -c 'show data_directory')
  systemctl stop "$(pg_service)"
  aside="$data.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$data" "$aside"
  install -d -m 700 -o postgres -g postgres "$data"
  local args=("--stanza=$STANZA" --archive-mode=off --log-level-console=warn)
  [[ -n $target ]] && args+=(--type=time "--target=$target" --target-action=promote)
  if ! as_pg pgbackrest "${args[@]}" restore; then
    rm -rf "$data"; mv "$aside" "$data"; systemctl start "$(pg_service)" || true
    die "the restore failed; the previous database was put back"
  fi
  systemctl start "$(pg_service)"
  for _ in $(seq 1 1800); do
    [[ $(psql_su -c 'select pg_is_in_recovery()' 2>/dev/null) == f ]] && break
    sleep 2
  done
  [[ $(psql_su -c 'select pg_is_in_recovery()') == f ]] || die "the restored database did not finish recovery (journalctl -u $(pg_service))"
  ok "database restored (the previous one is kept in $aside until you delete it)"

  step "Copying the snapshot objects back from r2:$R2_BUCKET"
  local tmp key sec store_ep load_ca=()
  tmp=$(mktemp -d); chmod 700 "$tmp"
  key=$(sed -n 's/^OBJECT_STORE_ACCESS_KEY_ID=//p' "$ENV_DIR/api.env")
  sec=$(sed -n 's/^OBJECT_STORE_SECRET_ACCESS_KEY=//p' "$ENV_DIR/api.env")
  store_ep=$(sed -n 's/^OBJECT_STORE_ENDPOINT=//p' "$ENV_DIR/api.env")
  [[ -n $BACKUP_CA_FILE ]] && load_ca=(--ca-cert "$BACKUP_CA_FILE")
  umask 077
  cat > "$tmp/rclone.conf" <<RCLONE
[store]
type = s3
provider = SeaweedFS
access_key_id = $key
secret_access_key = $sec
endpoint = $store_ep
force_path_style = true

[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://$(endpoint)
region = auto
no_check_bucket = true
RCLONE
  umask 022
  if ! /opt/rclone/current/rclone --config "$tmp/rclone.conf" "${load_ca[@]}" copy "r2:$R2_BUCKET/objects/$OBJECT_BUCKET" \
      "store:$OBJECT_BUCKET" --size-only --transfers 2 --checkers 4 --retries 3 --stats-one-line -v > "$tmp/copy.log" 2>&1; then
    tail -5 "$tmp/copy.log" >&2; rm -rf "$tmp"
    die "copying the objects back failed; run restore-server again (the database step is repeated)"
  fi
  tail -2 "$tmp/copy.log" | sed 's/^/    /'
  ok "snapshot objects copied back into $OBJECT_BUCKET (objects newer than the restored database are removed later by the worker's orphan sweep)"
  # Every committed snapshot in the restored database should have its object. One committed after the last object copy
  # (at most a few minutes before a total loss) has none: its computer still has the profile, and its next backup
  # replaces it; the profile's older versions are intact.
  local db missing
  db=$(sed -n 's#^DATABASE_URL=.*/\([A-Za-z0-9_]*\)$#\1#p' "$ENV_DIR/api.env")
  missing=$(comm -23 \
    <(psql_su -d "$db" -c "select object_key from app.snapshot_manifests where status = 'committed' and object_deleted_at is null" | sort -u) \
    <(/opt/rclone/current/rclone --config "$tmp/rclone.conf" lsf -R --files-only "store:$OBJECT_BUCKET" | sort -u) | wc -l)
  rm -rf "$tmp"
  if (( missing == 0 )); then
    ok "every committed snapshot has its object"
  else
    warn "$missing committed snapshot(s) have no object (committed after the last off-site copy): the computers that made them still have the profiles; their next backups replace them"
  fi
  # Keycloak keeps its data in the restored cluster; on a new server keycloak-setup.sh gives its role the right password.
  systemctl list-unit-files keycloak.service >/dev/null 2>&1 && { systemctl start keycloak 2>/dev/null || true; }
  printf '\n    Next: run vps-setup.sh twice (new database passwords for the restored roles, log archiving back on, services\n'
  printf '    started), then keycloak-setup.sh. Check with: bash %s status, and run restore-drill.sh.\n' "$LIBEXEC"
}

status() {
  load_backup_env
  if ! configured; then echo "Off-site backups: not set up yet (fill in $BACKUP_ENV, then run vps-setup.sh)."; return 0; fi
  echo "Database (pgBackRest, stanza $STANZA):"
  as_pg pgbackrest --stanza=$STANZA info | sed 's/^/    /'
  echo "Log archiving:"
  psql_su -c "select '    archived ' || archived_count || ', last ' || coalesce(last_archived_wal, '-') || ' at ' || coalesce(last_archived_time::text, '-') || '; failed ' || failed_count || coalesce(', last failure ' || last_failed_time::text, '') from pg_stat_archiver"
  echo "Snapshot objects:"
  if [[ -f $STATE_DIR/objects.json ]]; then sed 's/^/    /' "$STATE_DIR/objects.json"; else echo "    not copied yet"; fi
  echo "Timers:"
  systemctl list-timers 'pb-backup-*' --no-pager | sed 's/^/    /'
  # R6: a failing backup is said plainly (and the exit code is 3), not left to be read from the numbers above.
  if [[ $(psql_su -c "select coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) from pg_stat_archiver") == t ]]; then
    echo "ALERT: log archiving to R2 is FAILING (the newest attempt failed). Check R2 (token, bucket, network):"
    echo "       journalctl -u $(pg_service) -n 50 | grep -i archive ; the staff console's Operations page shows it too."
    return 3
  fi
}

case "${1:-setup}" in
  db-backup) shift; db_backup "${1:-auto}"; exit 0 ;;
  objects) objects_copy; exit 0 ;;
  status) rc=0; status || rc=$?; exit "$rc" ;;
  backup-now)
    load_backup_env; configured || die "off-site backups are not set up (fill in $BACKUP_ENV)"
    as_pg pgbackrest --stanza=$STANZA --type="${2:-full}" backup; ok "database backup done"
    systemctl start pb-backup-objects.service; ok "object copy done"; exit 0 ;;
  restore-server) shift; restore_server "$@"; exit 0 ;;
  setup) ;;
  *) die "usage: backup-setup.sh [setup|status|backup-now [full|diff]|restore-server [--target …] --yes-replace-this-database]" ;;
esac

# ----------------------------------------------------------------------------- setup
[[ $EUID -eq 0 ]] || die "run as root"
step "Off-site backups (pgBackRest + rclone to Cloudflare R2)"
write_template
load_backup_env
if ! configured; then
  ok "off-site backups not set up yet: fill in $BACKUP_ENV (Cloudflare R2), then run vps-setup.sh again"
  exit 0
fi
[[ $BACKUP_RETENTION_FULL =~ ^[1-9][0-9]?$ ]] || die "BACKUP_RETENTION_FULL must be 1-99"
[[ $R2_BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "R2_BUCKET is not a valid bucket name"
[[ -z $R2_ACCOUNT_ID || $R2_ACCOUNT_ID =~ ^[0-9a-f]{32}$ ]] || die "R2_ACCOUNT_ID should be 32 hexadecimal characters"
[[ -z $BACKUP_CA_FILE || -r $BACKUP_CA_FILE ]] || die "BACKUP_CA_FILE is not readable"
# A custom endpoint is for test stand-ins on this machine only.
[[ -z $R2_ENDPOINT || $R2_ENDPOINT =~ ^127\.0\.0\.1:[0-9]+$ ]] || die "R2_ENDPOINT may only point at 127.0.0.1 (tests)"

install_tools

id "$BACKUP_USER" >/dev/null 2>&1 \
  || useradd --system --home-dir "$STATE_DIR" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$BACKUP_USER"
install -d -m 750 -o "$BACKUP_USER" -g "$BACKUP_USER" "$STATE_DIR"
install -d -m 750 -o root -g root "$STATE_DIR/drills"

# The passphrase: created once, never replaced (backups made with it cannot be read without it).
NEW_CIPHER=0
if [[ ! -s $CIPHER_FILE ]]; then
  umask 077
  head -c 48 /dev/urandom | base64 -w0 > "$CIPHER_FILE"
  umask 022
  NEW_CIPHER=1
fi
chown root:root "$CIPHER_FILE"; chmod 600 "$CIPHER_FILE"

write_pgbackrest_conf
selinux_for_pgbackrest
ok "pgBackRest writes to r2:$R2_BUCKET/pgbackrest (encrypted here; configuration root:postgres 0640)"

# Log archiving: at most 60 s of the newest changes can be missing from the off-site copy (plus upload time).
before=$(psql_su -c 'show archive_mode')
psql_su -c "alter system set archive_mode = 'on'" \
        -c "alter system set archive_command = 'pgbackrest --stanza=$STANZA archive-push %p'" \
        -c "alter system set archive_timeout = '60s'"
if [[ $before != on ]]; then
  systemctl restart "$(pg_service)"
  for _ in $(seq 1 30); do as_pg "$(pg_bin)/pg_isready" -q -h 127.0.0.1 && break; sleep 1; done
  ok "PostgreSQL restarted with log archiving on"
else
  psql_su -c 'select pg_reload_conf()' >/dev/null
fi
# A bucket that holds another database's backups is never taken over (a new server must restore them instead).
repo_id=$(repo_system_id) \
  || die "the backups already in r2:$R2_BUCKET cannot be read with this token and $CIPHER_FILE (restore the passphrase from your offline copy, or use a new, empty bucket)"
if [[ -n $repo_id && $repo_id != "$(local_system_id)" ]]; then
  die "r2:$R2_BUCKET holds backups of another database (system $repo_id). To restore them onto this server: bash $0 restore-server (docs/security/dr-runbook.md). To start fresh: use a new, empty bucket."
fi
as_pg pgbackrest --stanza=$STANZA --log-level-console=warn stanza-create
if ! as_pg pgbackrest --stanza=$STANZA --log-level-console=warn check; then
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled && command -v ausearch >/dev/null 2>&1; then
    ausearch -m avc -ts recent 2>/dev/null | grep -i pgbackrest | tail -5 | sed 's/^/    SELinux: /' || true
  fi
  die "pgBackRest cannot archive to R2 (check $BACKUP_ENV; on SELinux systems see the lines above)"
fi
ok "log archiving to R2 works (pgbackrest check)"

# rclone: snapshot storage (read-only identity written by vps-setup.sh) -> R2.
[[ -r $STORE_RO_ENV ]] || die "$STORE_RO_ENV is missing (run vps-setup.sh)"
STORE_RO_KEY=$(sed -n 's/^STORE_READONLY_ACCESS_KEY_ID=//p' "$STORE_RO_ENV")
STORE_RO_SECRET=$(sed -n 's/^STORE_READONLY_SECRET_ACCESS_KEY=//p' "$STORE_RO_ENV")
STORE_ENDPOINT=$(sed -n 's/^STORE_ENDPOINT=//p' "$STORE_RO_ENV")
R2_URL="https://$EP"
install -d -m 750 -o root -g "$BACKUP_USER" "$RCLONE_DIR"
umask 027
cat > "$RCLONE_CONF" <<EOF
# Written by backup-setup.sh (rewritten on every run). The store identity can only read and list.
[store]
type = s3
provider = SeaweedFS
access_key_id = $STORE_RO_KEY
secret_access_key = $STORE_RO_SECRET
endpoint = $STORE_ENDPOINT
force_path_style = true

[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = $R2_URL
region = auto
no_check_bucket = true
EOF
umask 022
chown root:"$BACKUP_USER" "$RCLONE_CONF"; chmod 640 "$RCLONE_CONF"

# The timers run a root-owned copy of this script.
install -d -m 755 /usr/local/libexec
install -m 755 -o root -g root "$(readlink -f "$0")" "$LIBEXEC"
CA_ENV=""; [[ -n $BACKUP_CA_FILE ]] && CA_ENV="Environment=BACKUP_CA_FILE=$BACKUP_CA_FILE"
cat > /etc/systemd/system/pb-backup-db.service <<UNIT
[Unit]
Description=Project Browser database backup to R2 (pgBackRest; full weekly, differential daily)
After=$(pg_service).service
[Service]
Type=oneshot
User=postgres
Group=postgres
ExecStart=$LIBEXEC db-backup
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest
UNIT
cat > /etc/systemd/system/pb-backup-db.timer <<'UNIT'
[Unit]
Description=Daily database backup (full on Sundays)
[Timer]
OnCalendar=*-*-* 03:17:00 UTC
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/pb-backup-objects.service <<UNIT
[Unit]
Description=Project Browser snapshot objects copy to R2 (rclone, read-only source)
After=pb-storage.service
[Service]
Type=oneshot
User=$BACKUP_USER
Group=$BACKUP_USER
$CA_ENV
ExecStart=$LIBEXEC objects
Nice=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR
UNIT
cat > /etc/systemd/system/pb-backup-objects.timer <<'UNIT'
[Unit]
Description=Copy of snapshot objects to R2 every 2 minutes
[Timer]
OnCalendar=*:0/2
RandomizedDelaySec=20
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now pb-backup-db.timer pb-backup-objects.timer
# The object copy runs as the backup user, which cannot read backup.env: it gets the bucket name from here.
umask 027
printf 'R2_BUCKET=%s\nOBJECT_BUCKET=%s\n' "$R2_BUCKET" "$OBJECT_BUCKET" > "$STATE_DIR/bucket.env"
umask 022
chown root:"$BACKUP_USER" "$STATE_DIR/bucket.env"; chmod 640 "$STATE_DIR/bucket.env"

# First backups.
if ! as_pg pgbackrest --stanza=$STANZA --output=json info | grep -q '"type":"full"'; then
  bk_log=$(mktemp)
  if ! as_pg pgbackrest --stanza=$STANZA --type=full --log-level-console=warn backup > "$bk_log" 2>&1; then
    tail -25 "$bk_log"
    if grep -q 'ObjectLockedByBucketPolicy' "$bk_log"; then
      rm -f "$bk_log"
      die "the bucket r2:$R2_BUCKET has a bucket lock rule, which refuses pgBackRest's rewritten index files. Cloudflare → R2 → $R2_BUCKET → Settings → Bucket lock rules → delete the rule, then run vps-setup.sh again"
    fi
    rm -f "$bk_log"
    die "the first full database backup failed (see above)"
  fi
  rm -f "$bk_log"
  ok "first full database backup made"
else
  ok "database backups present ($(as_pg pgbackrest --stanza=$STANZA --output=json info | grep -o '"label":"[^"]*"' | wc -l) kept)"
fi
systemctl start pb-backup-objects.service || { journalctl -u pb-backup-objects -n 20 --no-pager; die "the object copy failed"; }
ok "snapshot objects copied to r2:$R2_BUCKET/objects/$OBJECT_BUCKET"
ok "timers: database daily 03:17 UTC (full on Sundays), log every 60 s, objects every 2 min  |  status: bash /usr/local/libexec/pb-backup status"

if [[ $NEW_CIPHER == 1 ]]; then
  printf '\n\033[1;33m    IMPORTANT:\033[0m a new backup passphrase was created. Without it the database backups in R2 can\n'
  printf '    never be read. Copy it off the server now and keep it offline, next to the root key copy:\n'
  printf '      scp root@<this-server>:%s ./project-browser-backup-passphrase.txt\n' "$CIPHER_FILE"
fi
