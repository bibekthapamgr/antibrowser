#!/usr/bin/env bash
# Project Browser — IP geolocation database for the desktop proxy check (ADR-0027).
#
# The API's GET /v1/netcheck tells the desktop app which address a proxy exits from and, with this database, where
# that address probably is (country, city, coordinates; the API derives the time zone and language). The database is
# DB-IP's free "IP to City Lite" (MaxMind MMDB format), licensed CC BY 4.0: "IP geolocation by DB-IP"
# (https://db-ip.com) must be shown where the data is used (website footer, desktop Proxies screen, docs).
#
#   bash geo-setup.sh            set up or update (vps-setup.sh runs it): installs a root-owned copy of this script
#                                as /usr/local/libexec/pb-geo, a monthly timer, and downloads the database now
#   bash geo-setup.sh refresh    download this month's database (or last month's while this month's is not out yet),
#                                check it (gzip, size, MMDB format, opened by the API's own reader as user pb, a test
#                                lookup) and only then replace the file in use; the previous file is kept as .prev.
#                                A failed download or check leaves the current file untouched.
#   bash geo-setup.sh status     the file in use, its age and the timer
#
# The API notices a replaced file by itself (it checks the file's time every 10 minutes); no restart is needed.
# A missing database is never fatal: the check then answers with the address only (the desktop says so).
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR
cd /

GEO_DIR=/var/lib/pb-geo
GEO_DB=$GEO_DIR/dbip-city-lite.mmdb
LIBEXEC=/usr/local/libexec/pb-geo
APP_USER=pb
APP_DIR=${PB_APP_DIR:-/home/$APP_USER/antibrowser}
NODE=${PB_NODE:-/opt/node/bin/node}
BASE_URL=https://download.db-ip.com/free
# Lite City is about 120 MB uncompressed; anything far smaller is an error page or a truncated file.
MIN_BYTES=$((20 * 1024 * 1024))
MAX_BYTES=$((1024 * 1024 * 1024))

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"

# Opens the file with the same reader the API uses (services/api's maxmind package), as the API's user, and looks up a
# public address. Prints the country found (may be empty for that address) or fails.
api_can_open() {
  local file=$1
  [[ -x $NODE && -d $APP_DIR/services/api/node_modules/maxmind ]] || return 2
  runuser -u "$APP_USER" -- env HOME=/tmp "$NODE" --input-type=module -e '
    const { default: maxmind } = await import(process.argv[1]);
    const r = await maxmind.open(process.argv[2]);
    const md = r.metadata;
    if (!/city/i.test(md.databaseType) || md.nodeCount < 100000) throw new Error("not a city database: " + md.databaseType);
    const hit = r.get("1.1.1.1") ?? r.get("8.8.8.8");
    console.log(md.databaseType + " " + new Date(md.buildEpoch).toISOString().slice(0, 10) + " " + (hit?.country?.iso_code ?? "-"));
  ' "$APP_DIR/services/api/node_modules/maxmind/lib/index.js" "$file"
}

refresh() {
  install -d -m 755 -o root -g root "$GEO_DIR"
  local work rc=0
  work=$(mktemp -d "$GEO_DIR/.incoming.XXXXXX")
  chmod 755 "$work"
  fetch_and_install "$work" || rc=$?
  rm -rf "$work"   # the download folder never stays behind
  return "$rc"
}

fetch_and_install() {
  local work=$1 got="" month
  for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do
    if curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 5 --max-time 900 \
         -o "$work/db.mmdb.gz" "$BASE_URL/dbip-city-lite-$month.mmdb.gz" 2>"$work/curl.log"; then
      got=$month
      break
    fi
  done
  if [[ -z $got ]]; then
    warn "could not download the DB-IP City Lite database ($(tail -1 "$work/curl.log" 2>/dev/null || echo 'no answer')); the current file is kept"
    return 1
  fi
  if ! gzip -t "$work/db.mmdb.gz" 2>/dev/null; then
    warn "the download for $got is not a valid gzip file; the current file is kept"
    return 1
  fi
  gzip -dc "$work/db.mmdb.gz" > "$work/db.mmdb"
  rm -f "$work/db.mmdb.gz"
  local size
  size=$(stat -c %s "$work/db.mmdb")
  if (( size < MIN_BYTES || size > MAX_BYTES )); then
    warn "the database for $got has an unexpected size ($size bytes); the current file is kept"
    return 1
  fi
  # MMDB files end with a metadata section that starts with this marker.
  if ! tail -c 131072 "$work/db.mmdb" | LC_ALL=C grep -aq $'\xab\xcd\xefMaxMind.com'; then
    warn "the file for $got is not in MMDB format; the current file is kept"
    return 1
  fi
  chmod 644 "$work/db.mmdb"
  local probe rc=0
  probe=$(api_can_open "$work/db.mmdb" 2>&1) || rc=$?
  if (( rc == 2 )); then
    warn "the API's reader is not installed yet ($APP_DIR); the file passed the format checks only"
  elif (( rc != 0 )); then
    warn "the API's reader could not use the database for $got ($(printf '%s' "$probe" | tail -1)); the current file is kept"
    return 1
  else
    ok "opened by the API's reader: $probe"
  fi
  [[ -f $GEO_DB ]] && cp -p "$GEO_DB" "$GEO_DB.prev"
  mv -f "$work/db.mmdb" "$GEO_DB.new"
  mv -f "$GEO_DB.new" "$GEO_DB"
  printf 'MONTH=%s\nUPDATED=%s\n' "$got" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$GEO_DIR/source.env"
  ok "IP geolocation: DB-IP City Lite $got in use ($GEO_DB, $((size / 1024 / 1024)) MB)"
}

status() {
  if [[ -s $GEO_DB ]]; then
    ok "$GEO_DB ($(stat -c %s "$GEO_DB") bytes, changed $(date -u -r "$GEO_DB" +%Y-%m-%d))"
    [[ -f $GEO_DIR/source.env ]] && sed 's/^/    /' "$GEO_DIR/source.env"
  else
    warn "no database yet: the proxy check answers with the address only"
  fi
  systemctl list-timers pb-geo-refresh.timer --no-pager 2>/dev/null | sed 's/^/    /' || true
}

case "${1:-setup}" in
  refresh) if refresh; then exit 0; else exit 1; fi ;;
  status) status; exit 0 ;;
  setup) ;;
  *) die "usage: geo-setup.sh [setup|refresh|status]" ;;
esac

step "IP geolocation database (DB-IP City Lite, CC BY 4.0)"
install -d -m 755 /usr/local/libexec
install -m 755 -o root -g root "$(readlink -f "$0")" "$LIBEXEC"
install -d -m 755 -o root -g root "$GEO_DIR"
cat > /etc/systemd/system/pb-geo-refresh.service <<UNIT
[Unit]
Description=Project Browser IP geolocation database refresh (DB-IP City Lite, monthly)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
Environment=PB_APP_DIR=$APP_DIR PB_NODE=$NODE
ExecStart=$LIBEXEC refresh
Nice=10
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
UNIT
cat > /etc/systemd/system/pb-geo-refresh.timer <<'UNIT'
[Unit]
Description=Monthly refresh of the IP geolocation database (DB-IP publishes at the start of each month)
[Timer]
OnCalendar=*-*-03 04:41:00 UTC
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now pb-geo-refresh.timer
ok "timer: monthly on the 3rd (pb-geo-refresh.timer)  |  status: bash $LIBEXEC status"
if [[ -s $GEO_DB ]] && (( $(date +%s) - $(stat -c %Y "$GEO_DB") < 20 * 86400 )); then
  ok "database present and recent ($GEO_DB); the timer keeps it current"
  exit 0
fi
refresh || { [[ -s $GEO_DB ]] && warn "keeping the database already in use"; exit 1; }
