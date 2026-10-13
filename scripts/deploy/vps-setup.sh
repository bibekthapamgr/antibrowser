#!/usr/bin/env bash
# Project Browser — test-server setup for a Linux VPS (RHEL/Rocky/Alma/CentOS Stream 8-10, Debian 12+, Ubuntu 22.04+).
#
# What it does (idempotent; safe to re-run to update):
#   1. Installs git, Node.js 24 LTS (official tarball, SHA-256 verified, into /opt/node only), pnpm via corepack,
#      and PostgreSQL 18 (PGDG). Nothing global is replaced: the system node/pnpm, if any, are untouched.
#   2. Creates an unprivileged user `pb` with a read-only GitHub deploy key; GitHub's host key is verified.
#   3. Clones/updates the private repository, installs dependencies, creates DB roles with RANDOM passwords,
#      runs migrations, seeds the two fixture tenants, runs the test suite.
#   4. Installs SeaweedFS (pinned release, SHA-256 verified) as the snapshot storage (S3 API on 127.0.0.1:8333, its
#      own system user and data folder) and creates the backup root key once (/etc/project-browser/kms-root.json,
#      pb user only; never regenerated: see root-key.sh and docs/sync/key-recovery-runbook.md).
#   5. Runs the API, the worker and the storage as hardened systemd services bound to 127.0.0.1 only, then proves a
#      snapshot round trip (upload, verification by the worker, restore).
#
# It never opens firewall ports, never changes SSH settings and never exposes PostgreSQL, the storage or the API
# publicly. Access them through an SSH tunnel (printed at the end).
#
# Usage (as root):  bash vps-setup.sh [--skip-tests]
# Env overrides:    PB_REPO (default git@github.com:bibekthapamgr/antibrowser.git), PB_BRANCH (main), PB_API_PORT (8080)
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR

REPO="${PB_REPO:-git@github.com:bibekthapamgr/antibrowser.git}"
BRANCH="${PB_BRANCH:-main}"
API_PORT="${PB_API_PORT:-8080}"
RUN_TESTS=1
[[ "${1:-}" == "--skip-tests" ]] && RUN_TESTS=0
SELF=$(readlink -f "$0")
# Work from / : commands run as the pb user (git, pnpm) fail when the caller's directory is not readable to pb.
cd /

APP_USER=pb
APP_HOME=/home/$APP_USER
APP_DIR=$APP_HOME/antibrowser
ENV_DIR=/etc/project-browser
ENV_FILE=$ENV_DIR/api.env
NODE_ROOT=/opt/node
# github.com ed25519 host key fingerprint, published at
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }
as_pb() {
  runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$NODE_ROOT/bin:/usr/local/bin:/usr/bin:/bin" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=yes -o BatchMode=yes" "$@"
}
port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
randhex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ----------------------------------------------------------------------------- preflight
step "Preflight"
[[ $EUID -eq 0 ]] || die "run as root (sudo bash $SELF)"
[[ -r /etc/os-release ]] || die "cannot detect the operating system"
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*) FAMILY=rhel ;;
  *debian*|*ubuntu*) FAMILY=debian ;;
  *) die "unsupported OS: ${PRETTY_NAME:-$ID}" ;;
esac
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "unsupported CPU architecture $(uname -m)" ;;
esac
ok "${PRETTY_NAME:-$ID} ($FAMILY, $(uname -m)), $(nproc) CPU, $(free -m | awk '/^Mem:/{print $2}') MB RAM, $(df -Pm / | awk 'NR==2{print $4}') MB free disk"
(( $(df -Pm / | awk 'NR==2{print $4}') > 3000 )) || die "need at least 3 GB free disk space"

# ----------------------------------------------------------------------------- base packages
step "Base packages"
if [[ $FAMILY == rhel ]]; then
  dnf install -y -q git tar xz curl openssh-clients iproute procps-ng >/dev/null
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git xz-utils curl ca-certificates openssh-client iproute2 procps >/dev/null
fi
ok "git $(git --version | awk '{print $3}')"

# ----------------------------------------------------------------------------- Node.js 24 LTS
step "Node.js 24 LTS"
if [[ -x $NODE_ROOT/bin/node ]] && [[ "$($NODE_ROOT/bin/node -v)" == v24.* ]]; then
  ok "already installed: $($NODE_ROOT/bin/node -v)"
else
  tmp=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
  file=$(awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$" {print $2}' "$tmp/SHASUMS256.txt" | head -1)
  [[ -n $file ]] || die "could not find a Node 24 build for linux-$NODE_ARCH"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node download failed checksum"
  ver_dir="/opt/${file%.tar.xz}"
  rm -rf "$ver_dir" && tar -xJf "$tmp/$file" -C /opt
  ln -sfn "$ver_dir" "$NODE_ROOT"
  rm -rf "$tmp"
  ok "installed $($NODE_ROOT/bin/node -v) at $ver_dir (checksum verified)"
fi
if [[ -x $NODE_ROOT/bin/corepack ]]; then
  PATH="$NODE_ROOT/bin:$PATH" "$NODE_ROOT/bin/corepack" enable --install-directory "$NODE_ROOT/bin" pnpm
else
  PATH="$NODE_ROOT/bin:$PATH" "$NODE_ROOT/bin/npm" install -g --silent pnpm@10.34.6
fi
ok "pnpm shim in $NODE_ROOT/bin (version pinned by the repository)"

# ----------------------------------------------------------------------------- PostgreSQL 18
step "PostgreSQL 18"
if [[ $FAMILY == rhel ]]; then
  PG_BIN=/usr/pgsql-18/bin; PG_SERVICE=postgresql-18
else
  PG_BIN=/usr/lib/postgresql/18/bin; PG_SERVICE=postgresql
fi
if ! systemctl is-active --quiet "$PG_SERVICE" 2>/dev/null && port_in_use 5432; then
  die "port 5432 is already used by another PostgreSQL/service on this server. Stop or move it first, then re-run."
fi
if [[ ! -x $PG_BIN/postgres ]]; then
  if [[ $FAMILY == rhel ]]; then
    major=$(rpm -E %rhel)
    rpm_arch=$([[ $NODE_ARCH == x64 ]] && echo x86_64 || echo aarch64)
    dnf install -y -q "https://download.postgresql.org/pub/repos/yum/reporpms/EL-${major}-${rpm_arch}/pgdg-redhat-repo-latest.noarch.rpm" >/dev/null
    dnf -qy module disable postgresql >/dev/null 2>&1 || true
    dnf install -y -q postgresql18-server postgresql18 >/dev/null
  else
    apt-get install -y -qq postgresql-common >/dev/null
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
    apt-get install -y -qq postgresql-18 >/dev/null
  fi
fi
if [[ $FAMILY == rhel ]] && [[ ! -s /var/lib/pgsql/18/data/PG_VERSION ]]; then
  PGSETUP_INITDB_OPTIONS="--auth-local=peer --auth-host=scram-sha-256" "$PG_BIN/postgresql-18-setup" initdb >/dev/null
fi
systemctl enable --now "$PG_SERVICE" >/dev/null 2>&1
for _ in $(seq 1 30); do runuser -u postgres -- "$PG_BIN/pg_isready" -q -h 127.0.0.1 && break; sleep 1; done
runuser -u postgres -- "$PG_BIN/pg_isready" -q -h 127.0.0.1 || die "PostgreSQL did not start (journalctl -u $PG_SERVICE)"
PSQL="$PG_BIN/psql"
ok "$(cd /tmp && runuser -u postgres -- "$PSQL" -tAc 'select version()' | cut -d, -f1)"
listen=$(cd /tmp && runuser -u postgres -- "$PSQL" -tAc 'show listen_addresses')
[[ $listen == localhost || $listen == 127.0.0.1 ]] || echo "    WARNING: PostgreSQL listen_addresses='$listen' (expected localhost)"

# ----------------------------------------------------------------------------- app user + deploy key
step "App user and GitHub deploy key"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/.ssh"
if [[ ! -f $APP_HOME/.ssh/id_ed25519 ]]; then
  as_pb ssh-keygen -q -t ed25519 -N "" -C "project-browser-deploy@$(hostname)" -f "$APP_HOME/.ssh/id_ed25519"
fi
scan=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)
fp=$(printf '%s\n' "$scan" | ssh-keygen -lf - | awk '{print $2}')
[[ $fp == "$GITHUB_ED25519_FP" ]] || die "github.com host key fingerprint mismatch ($fp). Not continuing."
printf '%s\n' "$scan" > "$APP_HOME/.ssh/known_hosts"
chown "$APP_USER:$APP_USER" "$APP_HOME/.ssh/known_hosts"; chmod 644 "$APP_HOME/.ssh/known_hosts"
ok "github.com host key verified ($fp)"

if ! as_pb git ls-remote --heads "$REPO" "$BRANCH" >/dev/null 2>&1; then
  echo
  echo "======================================================================================"
  echo " ONE-TIME STEP: give this server READ-ONLY access to the repository."
  echo " Add this public key as a deploy key (read-only, 'Allow write access' unchecked):"
  echo "   GitHub -> bibekthapamgr/antibrowser -> Settings -> Deploy keys -> Add deploy key"
  echo
  cat "$APP_HOME/.ssh/id_ed25519.pub"
  echo
  echo " Then run this script again:  bash $SELF"
  echo "======================================================================================"
  exit 0
fi
ok "repository access confirmed"

# ----------------------------------------------------------------------------- code + dependencies
step "Code"
if [[ -d $APP_DIR/.git ]]; then
  as_pb git -C "$APP_DIR" fetch -q origin "$BRANCH"
  as_pb git -C "$APP_DIR" checkout -q "$BRANCH"
  as_pb git -C "$APP_DIR" merge -q --ff-only "origin/$BRANCH" || die "server checkout has local changes; not overwriting"
else
  as_pb git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
ok "$(as_pb git -C "$APP_DIR" log -1 --format='%h %s')"
as_pb bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile --reporter=silent"
ok "dependencies installed (pnpm $(as_pb bash -c "cd '$APP_DIR' && pnpm --version"))"

# ----------------------------------------------------------------------------- snapshot storage + root key (07)
step "Snapshot storage (SeaweedFS) and the backup root key"
SW_VERSION=4.48
case "$NODE_ARCH" in
  x64)   SW_ASSET=linux_amd64.tar.gz; SW_SHA256=4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124 ;;
  arm64) SW_ASSET=linux_arm64.tar.gz; SW_SHA256=557e92c38c5c7d180748eb8e2b2b45e426f8e5282a4caca8e098a90d09f03a07 ;;
esac
SW_DIR=/opt/seaweedfs/$SW_VERSION
STORE_USER=pbstore
STORE_DATA=/var/lib/pb-seaweedfs
STORE_CONF_DIR=/etc/pb-seaweedfs
S3_PORT=8333
STORE_PORTS="$S3_PORT 9333 19333 8090 18090 8888 18888"
KMS_FILE=$ENV_DIR/kms-root.json
if [[ ! -x $SW_DIR/weed ]]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 "https://github.com/seaweedfs/seaweedfs/releases/download/$SW_VERSION/$SW_ASSET" -o "$tmp/sw.tgz"
  echo "$SW_SHA256  $tmp/sw.tgz" | sha256sum -c --quiet - || die "the SeaweedFS download does not match its pinned SHA-256"
  install -d -m 755 "$SW_DIR"
  tar -xzf "$tmp/sw.tgz" -C "$SW_DIR" weed
  chmod 755 "$SW_DIR/weed"
  rm -rf "$tmp"
fi
ln -sfn "$SW_DIR" /opt/seaweedfs/current
ok "SeaweedFS $SW_VERSION ($SW_ASSET, SHA-256 verified)"
id "$STORE_USER" >/dev/null 2>&1 \
  || useradd --system --home-dir "$STORE_DATA" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$STORE_USER"
install -d -m 700 -o "$STORE_USER" -g "$STORE_USER" "$STORE_DATA"
if ! systemctl is-active --quiet pb-storage; then
  for port in $STORE_PORTS; do
    port_in_use "$port" && die "port $port is already in use; SeaweedFS needs $STORE_PORTS on 127.0.0.1"
  done
fi
# New random S3 credentials on every run, like the database passwords; storage and API get them together.
S3_KEY="pb$(randhex 8)"; S3_SECRET=$(randhex 24)
install -d -m 750 -o root -g "$STORE_USER" "$STORE_CONF_DIR"
umask 027
printf '{"identities":[{"name":"project-browser","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","List","Tagging","Write"]}]}\n' \
  "$S3_KEY" "$S3_SECRET" > "$STORE_CONF_DIR/s3.json"
umask 022
chown root:"$STORE_USER" "$STORE_CONF_DIR/s3.json"; chmod 640 "$STORE_CONF_DIR/s3.json"
cat > /etc/systemd/system/pb-storage.service <<UNIT
[Unit]
Description=Project Browser snapshot storage (SeaweedFS; S3 on 127.0.0.1:$S3_PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$STORE_USER
Group=$STORE_USER
ExecStart=/opt/seaweedfs/current/weed server -dir=$STORE_DATA -ip=127.0.0.1 -ip.bind=127.0.0.1 -master.port=9333 -master.volumeSizeLimitMB=1024 -volume.port=8090 -volume.max=50 -filer.port=8888 -s3 -s3.port=$S3_PORT -s3.config=$STORE_CONF_DIR/s3.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=$STORE_DATA
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q pb-storage
systemctl restart pb-storage
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/" && break; sleep 1; done
curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/" || { journalctl -u pb-storage -n 30 --no-pager; die "the snapshot storage did not start"; }
ok "pb-storage running (S3 on 127.0.0.1:$S3_PORT, data in $STORE_DATA)"
# The root key wraps every organization's backup keys. Created once; this script never replaces it.
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
NEW_ROOT_KEY=0
if [[ ! -s $KMS_FILE ]]; then
  kid="root-$(date -u +%Y%m%d%H%M%S)"
  umask 077
  printf '{"active":"%s","keys":{"%s":"%s"}}\n' "$kid" "$kid" "$(head -c 32 /dev/urandom | base64 | tr -d '\n')" > "$KMS_FILE"
  umask 022
  NEW_ROOT_KEY=1
  ok "created the backup root key $kid"
else
  ok "backup root key kept ($KMS_FILE)"
fi
chown "$APP_USER:$APP_USER" "$KMS_FILE"; chmod 600 "$KMS_FILE"

# ----------------------------------------------------------------------------- database roles + secrets
step "Database roles and secrets"
(cd /tmp && runuser -u postgres -- "$PSQL" -q -v ON_ERROR_STOP=1 -f - < "$APP_DIR/infra/db/bootstrap-local.sql")
OWNER_PW=$(randhex 24); APP_PW=$(randhex 24); WORKER_PW=$(randhex 24); DEV_SECRET=$(randhex 32)
(cd /tmp && runuser -u postgres -- "$PSQL" -q -v ON_ERROR_STOP=1 \
  -c "alter role pb_owner password '$OWNER_PW'" \
  -c "alter role pb_app password '$APP_PW'" \
  -c "alter role pb_worker password '$WORKER_PW'")
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
umask 027
cat > "$ENV_FILE" <<EOF
# Generated by vps-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Regenerated (new random secrets) on every run.
# Test server: APP_ENV=dev with development tokens, so the API must stay on 127.0.0.1 (SSH tunnel only).
APP_ENV=dev
HOST=127.0.0.1
PORT=$API_PORT
LOG_LEVEL=info
DATABASE_URL=postgres://pb_app:$APP_PW@127.0.0.1:5432/pb_dev
WORKER_DATABASE_URL=postgres://pb_worker:$WORKER_PW@127.0.0.1:5432/pb_dev
MIGRATION_DATABASE_URL=postgres://pb_owner:$OWNER_PW@127.0.0.1:5432/pb_dev
DEV_AUTH_ENABLED=true
DEV_AUTH_SECRET=$DEV_SECRET
OBJECT_STORE_ENDPOINT=http://127.0.0.1:$S3_PORT
OBJECT_STORE_PUBLIC_ENDPOINT=http://127.0.0.1:$S3_PORT
OBJECT_STORE_BUCKET=pb-snapshots-dev
OBJECT_STORE_REGION=us-east-1
OBJECT_STORE_ACCESS_KEY_ID=$S3_KEY
OBJECT_STORE_SECRET_ACCESS_KEY=$S3_SECRET
OBJECT_STORE_FORCE_PATH_STYLE=true
KMS_LOCAL_KEY_FILE=$KMS_FILE
EOF
umask 022
chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
ok "random passwords set for pb_owner, pb_app, pb_worker; secrets in $ENV_FILE (root:pb 0640)"

step "Migrations and fixture tenants"
as_pb bash -c "cd '$APP_DIR' && node --env-file='$ENV_FILE' services/api/scripts/migrate.ts && node --env-file='$ENV_FILE' services/api/scripts/seed.ts" | sed 's/^/    /'
# Buckets for this server and for the test suite; the API's own credentials write, read and delete a probe.
as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/storage-check.ts pb-snapshots-test" | sed 's/^/    /'

# ----------------------------------------------------------------------------- tests
if [[ $RUN_TESTS == 1 ]]; then
  step "Test suite (uses the separate pb_test database)"
  if as_pb bash -c "cd '$APP_DIR' && \
      TEST_DATABASE_URL='postgres://pb_app:$APP_PW@127.0.0.1:5432/pb_test' \
      TEST_WORKER_DATABASE_URL='postgres://pb_worker:$WORKER_PW@127.0.0.1:5432/pb_test' \
      TEST_MIGRATION_DATABASE_URL='postgres://pb_owner:$OWNER_PW@127.0.0.1:5432/pb_test' \
      TEST_OBJECT_STORE_ACCESS_KEY_ID='$S3_KEY' TEST_OBJECT_STORE_SECRET_ACCESS_KEY='$S3_SECRET' \
      NO_COLOR=1 FORCE_COLOR=0 pnpm run test" > /tmp/pb-tests.log 2>&1; then
    # pnpm prefixes each line with the package path, e.g. "services/api test:  Tests  25 passed (25)".
    ok "$( (sed 's/\x1b\[[0-9;]*m//g' /tmp/pb-tests.log | grep -oE 'Tests +[0-9]+ passed' || true) | awk '{s+=$2} END {print s+0" tests passed"}')"
  else
    grep -E "FAIL|×|Error" /tmp/pb-tests.log | head -20
    die "tests failed; full log: /tmp/pb-tests.log"
  fi
fi

# ----------------------------------------------------------------------------- services
step "Services (systemd)"
if ! systemctl is-active --quiet pb-api && port_in_use "$API_PORT"; then
  die "port $API_PORT is already in use on this server. Re-run with PB_API_PORT=<free port> bash $SELF"
fi
unit() {  # name, description, workdir, entry
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target $PG_SERVICE.service pb-storage.service
Wants=network-online.target pb-storage.service
Requires=$PG_SERVICE.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$3
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_ROOT/bin/node $4
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
}
unit pb-api "Project Browser API (test server)" "$APP_DIR/services/api" "src/server.ts"
unit pb-worker "Project Browser outbox worker (test server)" "$APP_DIR/services/worker" "src/main.ts"
systemctl daemon-reload
systemctl enable -q pb-api pb-worker
systemctl restart pb-api pb-worker
ok "pb-api and pb-worker enabled and restarted"

# ----------------------------------------------------------------------------- smoke test
step "Smoke test"
base="http://127.0.0.1:$API_PORT/v1"
for _ in $(seq 1 30); do curl -fsS "$base/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$base/health" >/dev/null || { journalctl -u pb-api -n 30 --no-pager; die "API did not become healthy"; }
ok "health: $(curl -fsS "$base/health")"
TOKEN=$(as_pb bash -c "cd '$APP_DIR' && node --env-file='$ENV_FILE' services/api/scripts/dev-token.ts acmeOwner")
me=$(curl -fsS -H "authorization: Bearer $TOKEN" "$base/me")
[[ $me == *'"role":"owner"'* ]] && ok "fixture login works (acmeOwner)" || die "unexpected /me response: $me"
own=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$base/orgs/org_01J9ZSEED0ACME000000000000/profiles")
other=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$base/orgs/org_01J9ZSEED0BETA000000000000/profiles")
[[ $own == 200 && $other == 404 ]] && ok "own tenant 200, other tenant 404 (isolation holds)" || die "tenant check failed: own=$own other=$other"
sleep 2
systemctl is-active --quiet pb-worker && ok "worker running" || { journalctl -u pb-worker -n 30 --no-pager; die "worker not running"; }
if as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/snapshot-smoke.ts" > /tmp/pb-snapshot-smoke.log 2>&1; then
  ok "$(tail -1 /tmp/pb-snapshot-smoke.log)"
else
  tail -5 /tmp/pb-snapshot-smoke.log; journalctl -u pb-worker -n 20 --no-pager
  die "the snapshot round trip failed"
fi
pub=$(ss -ltnH | awk '{print $4}' | grep -E ":(5432|$API_PORT|${STORE_PORTS// /|})\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
[[ -z $pub ]] && ok "PostgreSQL, storage and API listen on localhost only" || die "something listens publicly: $pub"

# ----------------------------------------------------------------------------- summary
step "Done"
TUNNEL_EXTRA=" -L $S3_PORT:127.0.0.1:$S3_PORT"; SIGN_IN_HINT=""
if [[ -f $ENV_DIR/oidc.env ]]; then  # sign-in through the local Keycloak (keycloak-setup.sh) needs its port too
  kc_port=$(sed -nE 's|^OIDC_ISSUER=http://127\.0\.0\.1:([0-9]+)/.*|\1|p' "$ENV_DIR/oidc.env")
  [[ -n $kc_port ]] && TUNNEL_EXTRA="$TUNNEL_EXTRA -L $kc_port:127.0.0.1:$kc_port"
  SIGN_IN_HINT=$'\n'"    Sign-in: Keycloak is connected (keycloak-setup.sh); in Project Browser use http://127.0.0.1:$API_PORT"
fi
cat <<EOF
    Code:      $APP_DIR ($(as_pb git -C "$APP_DIR" log -1 --format=%h))
    Services:  systemctl status pb-api pb-worker pb-storage    |  logs: journalctl -u pb-api -f
    Update:    \\cp -f $APP_DIR/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh
               (refreshes this script, pulls main, migrates, tests, restarts; \\cp skips the "overwrite?" prompt)

    Use the API from your Mac (new Terminal tab, keep it open):
      ssh -N -L $API_PORT:127.0.0.1:$API_PORT$TUNNEL_EXTRA root@<this-server>
    then open http://127.0.0.1:$API_PORT/v1/health$SIGN_IN_HINT
    Fixture token (on this server):
      runuser -u pb -- bash -c "cd $APP_DIR && /opt/node/bin/node --env-file=$ENV_FILE services/api/scripts/dev-token.ts acmeOwner"
    Backups:   encrypted snapshots are stored on 127.0.0.1:$S3_PORT (the tunnel above carries it)
    Root key:  $KMS_FILE   |  bash $APP_DIR/scripts/deploy/root-key.sh status
EOF
if [[ $NEW_ROOT_KEY == 1 ]]; then
  printf '\n\033[1;33m    IMPORTANT:\033[0m a new backup root key was created. Without it no organization backup on this\n'
  printf '    server can ever be decrypted. Copy it off the server now and keep it offline:\n'
  printf '      scp root@<this-server>:%s ./project-browser-root-key.json\n' "$KMS_FILE"
fi
