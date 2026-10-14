#!/usr/bin/env bash
# Project Browser — restore drill (milestone 12, ADR-0019; runbook: docs/security/dr-runbook.md).
#
# Proves the off-site backups restore, without touching the running service:
#   1. makes a fresh committed snapshot for each of the two fixture tenants (test server) and writes a recovery
#      marker into the live database, then waits until the log holding it is in R2;
#   2. restores the database from R2 (pgBackRest, point-in-time to the end of the archived log) into a NEW, isolated
#      cluster: its own folder, port 5499, no network listener, no log archiving;
#   3. restores those snapshots' objects from the off-site copy;
#   4. checks row <-> object <-> key linkage for both tenants and that neither can reach the other
#      (services/api/scripts/restore-drill.ts), and that the marker survived;
#   5. measures the recovery point (marker age when the drill began restoring) and recovery time (restore + checks),
#      writes a report to /var/lib/pb-backup/drills/, then stops the cluster and deletes every restored file.
#
# Usage (as root):  bash restore-drill.sh [--no-seed]     (--no-seed: do not create fixture snapshots first)
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR
cd /

APP_USER=pb
APP_DIR=/home/$APP_USER/antibrowser
ENV_FILE=/etc/project-browser/api.env
NODE=/opt/node/bin/node
DRILL=/var/lib/pb-drill
DRILL_PORT=5499
STATE_DIR=/var/lib/pb-backup
RCLONE=/opt/rclone/current/rclone
RCLONE_CONF=/etc/pb-backup/rclone.conf
STANZA=pb
SEED=1
[[ "${1:-}" == "--no-seed" ]] && SEED=0

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*) PG_BIN=/usr/pgsql-18/bin ;;
  *) PG_BIN=/usr/lib/postgresql/18/bin ;;
esac
as_pg() { (cd /tmp && runuser -u postgres -- "$@"); }
as_pb() { runuser -u "$APP_USER" -- env HOME=/home/$APP_USER PATH="/opt/node/bin:/usr/bin:/bin" "$@"; }
psql_live() { as_pg "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
psql_drill() { as_pg "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -h "$DRILL/run" -p "$DRILL_PORT" -d "$DB" "$@"; }
now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.0f", b - a }'; }

cleanup() {
  if [[ -f $DRILL/data/postmaster.pid ]]; then
    as_pg "$PG_BIN/pg_ctl" -D "$DRILL/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$DRILL"
}

step "Restore drill"
[[ $EUID -eq 0 ]] || die "run as root"
[[ -r /etc/pgbackrest/pgbackrest.conf && -r $STATE_DIR/bucket.env ]] \
  || die "off-site backups are not set up (fill in /etc/project-browser/backup.env and run vps-setup.sh)"
DB=$(sed -nE 's#^MIGRATION_DATABASE_URL=.*/([A-Za-z0-9_]+)(\?.*)?$#\1#p' "$ENV_FILE")
[[ -n $DB ]] || die "cannot read the database name from $ENV_FILE"
R2_BUCKET=$(sed -n 's/^R2_BUCKET=//p' "$STATE_DIR/bucket.env")
CA_ARGS=()
CA=$(systemctl show pb-backup-objects.service -p Environment --value | tr ' ' '\n' | sed -n 's/^BACKUP_CA_FILE=//p')
[[ -n $CA ]] && CA_ARGS=(--ca-cert "$CA")
port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
[[ -e $DRILL ]] && { echo "    a previous drill left $DRILL behind: removing it"; cleanup; }
need=$(( $(psql_live -c "select pg_database_size(current_database())") / 1048576 * 3 + 512 ))
free=$(df -Pm /var/lib | awk 'NR==2{print $4}')
(( free > need )) || die "not enough free disk for the drill: $free MB free, about $need MB needed"
trap 'cleanup' EXIT
DRILL_START=$(date -u +%FT%TZ)

# ----------------------------------------------------------------------------- 1. data to find again
if (( SEED )); then
  for org in acme beta; do
    as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/snapshot-smoke.ts --org $org" \
      | tail -1 | sed "s/^/    $org: /"
  done
fi
MARKER=$(psql_live -c "insert into app.recovery_markers (note) values ('restore drill $DRILL_START') returning id")
MARKER_AT=$(now)
# Close the log segment holding the marker; it must be in R2 before the restore starts.
seg=$(psql_live -c "select pg_walfile_name(pg_switch_wal())")
# The objects of those snapshots go off-site too (the timer does this every 10 minutes).
systemctl start pb-backup-objects.service
archived=0
for _ in $(seq 1 180); do
  last=$(psql_live -c "select coalesce(last_archived_wal, '') from pg_stat_archiver")
  if [[ -n $last && ! $last < $seg ]]; then archived=1; break; fi
  sleep 1
done
(( archived )) || die "the log segment $seg did not reach R2 within 3 minutes ($(psql_live -c "select 'failed ' || failed_count || ', last ' || coalesce(last_failed_wal, '-') from pg_stat_archiver"))"
ok "marker $MARKER written; log archived up to $last"

# ----------------------------------------------------------------------------- 2. restore into an isolated cluster
RESTORE_START=$(now)
install -d -m 711 -o root -g root "$DRILL"
install -d -m 700 -o postgres -g postgres "$DRILL/data"
install -d -m 750 -o postgres -g "$APP_USER" "$DRILL/run"
install -d -m 750 -o pb-backup -g "$APP_USER" "$DRILL/objects"
as_pg pgbackrest --stanza=$STANZA --pg1-path="$DRILL/data" --archive-mode=off --log-level-console=warn restore
cat > "$DRILL/postgresql.conf" <<EOF
# Restore drill: isolated (no network listener, no log archiving), small, temporary.
listen_addresses = ''
port = $DRILL_PORT
unix_socket_directories = '$DRILL/run'
unix_socket_group = '$APP_USER'
unix_socket_permissions = 0770
hba_file = '$DRILL/pg_hba.conf'
ident_file = '$DRILL/pg_ident.conf'
shared_buffers = 32MB
max_connections = 20
# Recover to the end of the archived log, then open: no read-only standby phase (it would also demand at least the
# live server's max_connections and other limits, which this small cluster does not need).
hot_standby = off
archive_mode = off
logging_collector = off
EOF
printf 'local all all trust\n' > "$DRILL/pg_hba.conf"
: > "$DRILL/pg_ident.conf"
chown postgres:postgres "$DRILL/postgresql.conf" "$DRILL/pg_hba.conf" "$DRILL/pg_ident.conf"
chmod 600 "$DRILL/postgresql.conf" "$DRILL/pg_hba.conf" "$DRILL/pg_ident.conf"
port_in_use "$DRILL_PORT" && die "port $DRILL_PORT is in use"
as_pg "$PG_BIN/pg_ctl" -D "$DRILL/data" -o "-c config_file=$DRILL/postgresql.conf" -l "$DRILL/run/drill.log" -w -t 900 start >/dev/null \
  || { tail -30 "$DRILL/run/drill.log" >&2; die "the restored cluster did not start (its log is above)"; }
for _ in $(seq 1 900); do
  [[ $(psql_drill -c 'select pg_is_in_recovery()' 2>/dev/null) == f ]] && break
  sleep 1
done
[[ $(psql_drill -c 'select pg_is_in_recovery()') == f ]] || { tail -30 "$DRILL/run/drill.log"; die "the restored cluster did not finish recovery"; }
[[ $(psql_drill -c 'show archive_mode') == off ]] || die "the drill cluster would archive its log"
RESTORED=$(now)
ok "database restored and recovered in $(elapsed "$RESTORE_START" "$RESTORED") s (isolated: port $DRILL_PORT, socket only)"

# ----------------------------------------------------------------------------- 3. objects from the off-site copy
ORGS=$(psql_drill -c "select string_agg(org_id, ',' order by org_id) from (select org_id from app.snapshot_manifests where status = 'committed' and wrapped_dek is not null group by org_id order by max(committed_at) desc limit 2) t")
KEYS=$(psql_drill -c "select distinct on (org_id) object_key from app.snapshot_manifests where status = 'committed' and wrapped_dek is not null and org_id = any(string_to_array('$ORGS', ',')) order by org_id, committed_at desc, id desc")
printf '%s\n' "$KEYS" > "$DRILL/objects.list"; chmod 644 "$DRILL/objects.list"
runuser -u pb-backup -- bash -c "umask 027; '$RCLONE' --config '$RCLONE_CONF' ${CA_ARGS[*]:-} copy 'r2:$R2_BUCKET/objects/pb-snapshots-dev' '$DRILL/objects' --files-from '$DRILL/objects.list' --retries 3"
ok "$(wc -l < "$DRILL/objects.list") snapshot objects restored from r2:$R2_BUCKET/objects"

# ----------------------------------------------------------------------------- 4. checks
REPORT=$(as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/restore-drill.ts --socket '$DRILL/run' --port $DRILL_PORT --db '$DB' --objects '$DRILL/objects' --marker '$MARKER' --orgs '$ORGS'") \
  && CHECK=pass || CHECK=fail
VERIFIED=$(now)
echo "$REPORT" | sed 's/^/    /'

# ----------------------------------------------------------------------------- 5. report
RPO=$(elapsed "$MARKER_AT" "$RESTORE_START")
RTO=$(elapsed "$RESTORE_START" "$VERIFIED")
BACKUP=$(as_pg pgbackrest --stanza=$STANZA --output=json info | "$NODE" -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const b = ((JSON.parse(d)[0] || {}).backup || []).at(-1);
    console.log(b ? `${b.label} (${b.type}, finished ${new Date(b.timestamp.stop * 1000).toISOString()})` : "none");
  });')
install -d -m 750 -o root -g root "$STATE_DIR/drills"
OUT=$STATE_DIR/drills/$(date -u +%Y%m%dT%H%M%SZ).json
"$NODE" -e '
  const [start, check, rpo, rto, backup, marker, orgs, report] = process.argv.slice(1);
  let r = null; try { r = JSON.parse(report); } catch {}
  console.log(JSON.stringify({ drill_started_at: start, result: check, recovery_point_seconds: Number(rpo),
    recovery_time_seconds: Number(rto), newest_backup: backup, marker_id: marker, tenants: orgs.split(","),
    checks: r }, null, 2));' "$DRILL_START" "$CHECK" "$RPO" "$RTO" "$BACKUP" "$MARKER" "$ORGS" "$REPORT" > "$OUT"
chmod 640 "$OUT"
cleanup
trap - EXIT
[[ $CHECK == pass ]] || die "the restore checks failed (report: $OUT)"
ok "restore drill passed: recovery point ${RPO} s before the restore began (target 15 min), recovery time ${RTO} s (target 4 h)"
ok "report: $OUT  |  the isolated cluster and every restored file were deleted"
