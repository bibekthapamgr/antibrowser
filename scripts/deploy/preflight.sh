#!/usr/bin/env bash
# Project Browser — production preflight (R6, ADR-0025). Run on a staging or production server, as root:
#
#   bash preflight.sh            all checks; exit 0 only when no required check FAILED
#
# Each check is named and reported PASS / FAIL / WARN (see docs/r6/preflight-report.md for what each one means and
# how to fix it): HTTPS and the sign-in issuer, publicly trusted certificates, development sign-in off, public
# registration, real e-mail delivery, customer/staff separation, the safe readiness endpoint, billing webhook
# signatures, database connectivity and row-level security, staff second factor, private ports, secret file
# permissions, off-site backup recency, installed release keys, runtime and download eligibility.
#
# It reads the machine as root (listening ports, file permissions, backup state) and runs the remaining checks as the
# app user with the API's own settings. No secret value is printed or written: the report holds names, hosts, counts
# and file names only. Reports: /var/lib/pb-preflight/<time>.json and latest.json (root only).
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR
cd /

APP_USER=pb
APP_DIR=/home/$APP_USER/antibrowser
ENV_DIR=/etc/project-browser
NODE=/opt/node/bin/node
OUT_DIR=/var/lib/pb-preflight
API_PORT="${PB_API_PORT:-8080}"
KC_PORT="${PB_KC_PORT:-8081}"

die() { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 2; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ -f $ENV_DIR/api.env && -x $NODE ]] || die "this server is not set up (vps-setup.sh)"
PB_ENV=$(sed -n 's/^PB_ENV=//p' "$ENV_DIR/environment" 2>/dev/null || true)
PB_ENV=${PB_ENV:-$(sed -n 's/^APP_ENV=//p' "$ENV_DIR/api.env")}
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*) PG_BIN=/usr/pgsql-18/bin ;;
  *) PG_BIN=/usr/lib/postgresql/18/bin ;;
esac
pub() { sed -n "s/^$1=//p" "$ENV_DIR/public.env" 2>/dev/null | tr -d '"'"'"' \r'; }

WORK=$(mktemp -d -p /run pb-preflight.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
chown root:"$APP_USER" "$WORK"; chmod 750 "$WORK"

# ----------------------------------------------------------------------------- facts about the machine
listeners=$(ss -ltnH | awk '{print $4}' | sort -u | paste -sd' ' -)
file_fact() {  # path, expected "mode owner:group"
  if [[ -e $1 ]]; then printf '{"path":"%s","mode":"%s","owner":"%s","expect":"%s"}' "$1" "$(stat -c %a "$1")" "$(stat -c %U:%G "$1")" "$2"
  else printf '{"path":"%s","mode":"missing","owner":"","expect":"%s"}' "$1" "$2"; fi
}
files="[$(file_fact "$ENV_DIR/api.env" "640 root:$APP_USER"),$(file_fact "$ENV_DIR/oidc.env" "600 root:root"),$(file_fact "$ENV_DIR/email.env" "600 root:root"),$(file_fact "$ENV_DIR/billing.env" "640 root:$APP_USER"),$(file_fact "$ENV_DIR/smtp.env" "600 root:root"),$(file_fact "$ENV_DIR/backup.env" "600 root:root"),$(file_fact "$ENV_DIR/backup-cipher-pass" "600 root:root"),$(file_fact "$ENV_DIR/kms-root.json" "600 $APP_USER:$APP_USER"),$(file_fact "$ENV_DIR/keycloak-admin" "600 root:root"),$(file_fact "$ENV_DIR/public.env" "600 root:root")]"

# Backups: newest pgBackRest backup, log archiving, last copy of the snapshot objects.
configured=false; newest=null; newest_type=null; archived=null; failed=null; objects=null
if [[ -r /etc/pgbackrest/pgbackrest.conf && -f /var/lib/pb-backup/bucket.env ]]; then
  configured=true
  info=$( (cd /tmp && runuser -u postgres -- pgbackrest --stanza=pb --output=json info) 2>/dev/null || echo '[]')
  read -r newest newest_type < <("$NODE" -e '
    let d = []; try { d = JSON.parse(process.argv[1]); } catch {}
    const b = ((d[0] || {}).backup || []).at(-1);
    console.log(b ? `${b.timestamp.stop} "${b.type}"` : "null null");' "$info")
  db=$(sed -nE 's#^MIGRATION_DATABASE_URL=.*/([A-Za-z0-9_]+)(\?.*)?$#\1#p' "$ENV_DIR/api.env")
  read -r archived failed < <(cd /tmp && runuser -u postgres -- "$PG_BIN/psql" -X -qtA -F' ' -d "$db" -c \
    "select coalesce(extract(epoch from last_archived_time)::bigint::text, 'null'), coalesce(extract(epoch from last_failed_time)::bigint::text, 'null') from pg_stat_archiver")
  if [[ -f /var/lib/pb-backup/objects.json ]]; then
    objects=$("$NODE" -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Math.floor(Date.parse(j.at) / 1000))' /var/lib/pb-backup/objects.json)
  fi
fi
proxy=false; systemctl is-active --quiet pb-proxy && proxy=true
cat > "$WORK/facts.json" <<EOF
{
  "env": "$PB_ENV",
  "tls_mode": "$(pub TLS_MODE | grep . || echo public)",
  "hosts": { "site": "$(pub SITE_HOST)", "admin": "$(pub ADMIN_HOST)", "id": "$(pub ID_HOST)", "files": "$(pub FILES_HOST)" },
  "listeners": $("$NODE" -e 'console.log(JSON.stringify(process.argv[1].split(" ").filter(Boolean)))' "$listeners"),
  "private_ports": [5432, $API_PORT, $KC_PORT, 8333, 9333, 19333, 8090, 18090, 8888, 18888, 9000, 9187],
  "public_ports": [22, 80, 443],
  "files": $files,
  "backup": { "configured": $configured, "newest_backup_epoch": $newest, "newest_backup_type": $newest_type,
              "last_archived_epoch": $archived, "last_failed_epoch": $failed, "objects_copied_epoch": $objects },
  "proxy_active": $proxy,
  "now_epoch": $(date +%s)
}
EOF
chown root:"$APP_USER" "$WORK/facts.json"; chmod 640 "$WORK/facts.json"

# ----------------------------------------------------------------------------- the API's settings, as pb-api has them
{
  for f in api.env billing.env stripe-webhook.env email.env site.env oidc.env; do
    [[ -f $ENV_DIR/$f ]] && { cat "$ENV_DIR/$f"; echo; }
  done
} > "$WORK/env"
chown root:"$APP_USER" "$WORK/env"; chmod 640 "$WORK/env"
extra=()
[[ -s $ENV_DIR/public-ca.pem ]] && extra=(NODE_EXTRA_CA_CERTS="$ENV_DIR/public-ca.pem")

install -d -m 750 -o root -g root "$OUT_DIR"
touch "$WORK/report.json"; chown "$APP_USER" "$WORK/report.json"
echo "    Preflight of the $PB_ENV server ($(date -u +%FT%TZ)); no secret values are shown"
set +e
trap - ERR   # a FAIL is an expected answer here, not a script error
runuser -u "$APP_USER" -- env HOME=/home/$APP_USER PATH="/opt/node/bin:/usr/bin:/bin" "${extra[@]}" \
  bash -c "cd '$APP_DIR/services/api' && node --env-file='$WORK/env' scripts/preflight.ts --facts '$WORK/facts.json' --repo '$APP_DIR' --json '$WORK/report.json'"
rc=$?
set -e
stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -s $WORK/report.json ]]; then
  install -m 640 -o root -g root "$WORK/report.json" "$OUT_DIR/$stamp.json"
  ln -sfn "$OUT_DIR/$stamp.json" "$OUT_DIR/latest.json"
  echo "    report: $OUT_DIR/$stamp.json"
fi
exit $rc
