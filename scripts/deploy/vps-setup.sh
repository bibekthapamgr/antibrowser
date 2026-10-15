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
#   6. Keeps the pb user's processes (API, worker) away from private networks with an nftables table of its own
#      (outbound only; proven with a refused test connection), so webhook deliveries cannot reach internal addresses.
#   7. Builds the internal support console (served by the API at /console/) and, once you have put a Stripe TEST key
#      into /etc/project-browser/billing.env, installs the Stripe CLI (pinned, SHA-256 verified) as a forwarder of
#      Stripe's test-mode events to the API, so this tunnel-only server needs no public webhook address.
#
# On a test (dev) server it never opens firewall ports, never changes SSH settings, never touches other firewall
# rules and never exposes PostgreSQL, the storage or the API publicly. Access them through an SSH tunnel.
#
# R6 (ADR-0025): the same script sets up a STAGING or PRODUCTION server (one environment per server):
#   PB_ENV=prod bash vps-setup.sh      (or staging; remembered in /etc/project-browser/environment)
#   - its own database (pb_prod / pb_staging), storage bucket (pb-snapshots-prod), sign-in realm and secrets;
#   - no development tokens, no fixture tenants, no test suite on the server, staff need a one-time code;
#   - the public addresses from /etc/project-browser/public.env (yours) behind a TLS reverse proxy (public-setup.sh,
#     run from here): only ports 80 and 443 are opened; PostgreSQL, the storage, Keycloak's administration and the
#     service ports stay on 127.0.0.1;
#   - Stripe: your live (prod) or test (staging) key and the signing secret of the webhook endpoint you add in the
#     Stripe Dashboard (billing.env); no Stripe CLI forwarder;
#   - ends with the preflight report (preflight.sh): named PASS/FAIL checks, no secret values.
# A test (dev) server can be turned into staging or prod; a staging or prod server is never turned back into dev.
#
# Usage (as root):  bash vps-setup.sh [--skip-tests]
# Env overrides:    PB_REPO (default git@github.com:bibekthapamgr/antibrowser.git), PB_BRANCH (main), PB_API_PORT (8080),
#                   PB_ENV (dev | staging | prod; default: the environment this server already has, else dev)
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
ENV_MARK=$ENV_DIR/environment
PUBLIC_ENV=$ENV_DIR/public.env
NODE_ROOT=/opt/node
# github.com ed25519 host key fingerprint, published at
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
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
# R6: which environment this server runs. Chosen once (PB_ENV), remembered in $ENV_MARK.
current_env=""
[[ -f $ENV_MARK ]] && current_env=$(sed -n 's/^PB_ENV=//p' "$ENV_MARK")
if [[ -z $current_env && -f $ENV_FILE ]]; then current_env=$(sed -n 's/^APP_ENV=//p' "$ENV_FILE"); fi
PB_ENV=${PB_ENV:-${current_env:-dev}}
[[ $PB_ENV =~ ^(dev|staging|prod)$ ]] || die "PB_ENV must be dev, staging or prod (got '$PB_ENV')"
if [[ -n $current_env && $current_env != "$PB_ENV" ]]; then
  [[ $current_env == dev ]] || die "this server is $current_env; it is never changed to $PB_ENV (set up another server instead)"
  warn "this test server becomes $PB_ENV: its own database pb_$PB_ENV, bucket pb-snapshots-$PB_ENV, realm and secrets."
  warn "the test data (database pb_dev, bucket pb-snapshots-dev) is left as it is and no longer used."
fi
LOCAL_ENV=0; [[ $PB_ENV == dev ]] && LOCAL_ENV=1
DB_NAME=pb_$PB_ENV
BUCKET=pb-snapshots-$PB_ENV
if (( ! LOCAL_ENV )); then
  RUN_TESTS=0
  (( $(free -m | awk '/^Mem:/{print $2}') >= 3500 )) \
    || warn "$PB_ENV with Keycloak, PostgreSQL and the storage on one server needs about 4 GB of memory; this one has less"
fi

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
if (( ! LOCAL_ENV )); then
  install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
  if [[ ! -f $PUBLIC_ENV ]]; then
    install -m 600 -o root -g root "$APP_DIR/scripts/deploy/public.env.example" "$PUBLIC_ENV"
    die "fill in your public addresses in $PUBLIC_ENV (DNS must already point at this server), then run this again"
  fi
  # Parsed, never executed. Checked again (DNS, certificates) by public-setup.sh.
  for k in SITE_HOST ADMIN_HOST ID_HOST FILES_HOST ACME_EMAIL; do
    [[ -n $(sed -n "s/^$k=//p" "$PUBLIC_ENV" | tr -d '"'"'"' \r') ]] || die "$PUBLIC_ENV: $k is empty (see the comments in that file)"
  done
  printf 'PB_ENV=%s\n' "$PB_ENV" > "$ENV_MARK"; chmod 644 "$ENV_MARK"
  ok "public addresses in $PUBLIC_ENV; this server is $PB_ENV from now on ($ENV_MARK)"
  # A test server turned into staging/prod still has the test server's sign-in settings (http issuer on 127.0.0.1 and
  # its session key). They are set aside, never reused: keycloak-setup.sh writes this environment's own, with a new key.
  if [[ -f $ENV_DIR/oidc.env ]] && ! grep -q '^OIDC_ISSUER=https://' "$ENV_DIR/oidc.env"; then
    mv -f "$ENV_DIR/oidc.env" "$ENV_DIR/oidc.env.test-server"
    chmod 600 "$ENV_DIR/oidc.env.test-server"
    ok "the test server's sign-in settings were set aside ($ENV_DIR/oidc.env.test-server); $PB_ENV gets its own"
  fi
fi
as_pb bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile --reporter=silent"
ok "dependencies installed (pnpm $(as_pb bash -c "cd '$APP_DIR' && pnpm --version"))"
# Milestone 11: the internal support console, static files the API serves at /console/ (CONSOLE_DIR).
CONSOLE_DIR=$APP_DIR/apps/web-admin/dist
if as_pb bash -c "cd '$APP_DIR' && pnpm --filter @pb/web-admin build" > /tmp/pb-console-build.log 2>&1; then
  ok "support console built ($CONSOLE_DIR; the API serves it at /console/)"
else
  tail -20 /tmp/pb-console-build.log
  die "the support console did not build; full log: /tmp/pb-console-build.log"
fi
# R4: the customer portal (/app/, WEB_DIR, set by keycloak-setup.sh) and the public website (/, PUBLIC_DIR).
PUBLIC_DIR=$APP_DIR/apps/web-public/dist
if as_pb bash -c "cd '$APP_DIR' && pnpm --filter @pb/web-customer build && pnpm --filter @pb/web-public build" \
  > /tmp/pb-web-build.log 2>&1; then
  ok "customer portal and public website built (the API serves them at /app/ and /)"
else
  tail -20 /tmp/pb-web-build.log
  die "the portal or website did not build; full log: /tmp/pb-web-build.log"
fi

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
# Milestone 12: a second identity that can only read and list the snapshot bucket, for the off-site copy.
S3_KEY="pb$(randhex 8)"; S3_SECRET=$(randhex 24)
S3_RO_KEY="pbro$(randhex 8)"; S3_RO_SECRET=$(randhex 24)
install -d -m 750 -o root -g "$STORE_USER" "$STORE_CONF_DIR"
umask 027
printf '{"identities":[{"name":"project-browser","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","List","Tagging","Write"]},{"name":"backup-readonly","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read:%s","List:%s"]}]}\n' \
  "$S3_KEY" "$S3_SECRET" "$S3_RO_KEY" "$S3_RO_SECRET" "$BUCKET" "$BUCKET" > "$STORE_CONF_DIR/s3.json"
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
umask 077
printf 'STORE_ENDPOINT=http://127.0.0.1:%s\nSTORE_READONLY_ACCESS_KEY_ID=%s\nSTORE_READONLY_SECRET_ACCESS_KEY=%s\n' \
  "$S3_PORT" "$S3_RO_KEY" "$S3_RO_SECRET" > "$ENV_DIR/store-readonly.env"
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
ExecStart=/opt/seaweedfs/current/weed server -dir=$STORE_DATA -ip=127.0.0.1 -ip.bind=127.0.0.1 -master.port=9333 -master.volumeSizeLimitMB=1024 -volume.port=8090 -volume.max=50 -filer.port=8888 -s3 -s3.port=$S3_PORT -s3.port.iceberg=0 -s3.port.lance=0 -s3.config=$STORE_CONF_DIR/s3.json
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
${5:-}

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
if (( ! LOCAL_ENV )); then  # R6: this environment's own database
  (cd /tmp && runuser -u postgres -- "$PSQL" -q -v ON_ERROR_STOP=1 -f -) <<SQL
select 'create database $DB_NAME owner pb_owner'
where not exists (select 1 from pg_database where datname = '$DB_NAME') \gexec
SQL
fi
OWNER_PW=$(randhex 24); APP_PW=$(randhex 24); WORKER_PW=$(randhex 24); DEV_SECRET=$(randhex 32)
(cd /tmp && runuser -u postgres -- "$PSQL" -q -v ON_ERROR_STOP=1 \
  -c "alter role pb_owner password '$OWNER_PW'" \
  -c "alter role pb_app password '$APP_PW'" \
  -c "alter role pb_worker password '$WORKER_PW'")
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
umask 027
# R6: in staging/prod browsers and the desktop app reach the storage through the TLS proxy (FILES_HOST).
STORE_PUBLIC=http://127.0.0.1:$S3_PORT
if (( ! LOCAL_ENV )); then STORE_PUBLIC=https://$(sed -n 's/^FILES_HOST=//p' "$PUBLIC_ENV" | tr -d '"'"'"' \r'); fi
{
cat <<EOF
# Generated by vps-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Regenerated (new random secrets) on every run.
# The API listens on 127.0.0.1 only: on a test (dev) server through the SSH tunnel, in staging/prod behind the TLS
# proxy (public-setup.sh). Sign-in settings and the session key are in oidc.env (keycloak-setup.sh).
APP_ENV=$PB_ENV
HOST=127.0.0.1
PORT=$API_PORT
LOG_LEVEL=info
DATABASE_URL=postgres://pb_app:$APP_PW@127.0.0.1:5432/$DB_NAME
WORKER_DATABASE_URL=postgres://pb_worker:$WORKER_PW@127.0.0.1:5432/$DB_NAME
MIGRATION_DATABASE_URL=postgres://pb_owner:$OWNER_PW@127.0.0.1:5432/$DB_NAME
OBJECT_STORE_ENDPOINT=http://127.0.0.1:$S3_PORT
OBJECT_STORE_PUBLIC_ENDPOINT=$STORE_PUBLIC
OBJECT_STORE_BUCKET=$BUCKET
OBJECT_STORE_REGION=us-east-1
OBJECT_STORE_ACCESS_KEY_ID=$S3_KEY
OBJECT_STORE_SECRET_ACCESS_KEY=$S3_SECRET
OBJECT_STORE_FORCE_PATH_STYLE=true
KMS_LOCAL_KEY_FILE=$KMS_FILE
CONSOLE_DIR=$CONSOLE_DIR
PUBLIC_DIR=$PUBLIC_DIR
EOF
if (( LOCAL_ENV )); then
  printf 'DEV_AUTH_ENABLED=true\nDEV_AUTH_SECRET=%s\n' "$DEV_SECRET"
else
  # One proxy (Caddy) in front: the client address is the one it saw. Every staff sign-in needs a one-time code.
  printf 'TRUST_PROXY_HOPS=1\nSTAFF_REQUIRE_MFA=true\n'
fi
} > "$ENV_FILE"
umask 022
chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
ok "random passwords set for pb_owner, pb_app, pb_worker; secrets in $ENV_FILE (root:pb 0640)"

# Migrations stay backward compatible (ADR-0025): they run before the new code starts, and code still running keeps
# working on the new schema until it is restarted.
if (( LOCAL_ENV )); then
  step "Migrations and fixture tenants"
  as_pb bash -c "cd '$APP_DIR' && node --env-file='$ENV_FILE' services/api/scripts/migrate.ts && node --env-file='$ENV_FILE' services/api/scripts/seed.ts" | sed 's/^/    /'
  # Buckets for this server and for the test suite; the API's own credentials write, read and delete a probe.
  as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/storage-check.ts pb-snapshots-test" | sed 's/^/    /'
else
  step "Migrations ($PB_ENV: no fixture tenants)"
  # These scripts check the whole configuration, which in staging/prod also needs the sign-in settings (oidc.env).
  # Before keycloak-setup.sh has written them (the first run), placeholders satisfy that check for these two only.
  MIG_ENV=$(mktemp -p /run pb-migrate.XXXXXX)
  {
    cat "$ENV_FILE"
    if [[ -f $ENV_DIR/oidc.env ]]; then grep -E '^(OIDC_ISSUER|OIDC_CLIENT_ID|SESSION_SIGNING_KEY)=' "$ENV_DIR/oidc.env" || true; fi
  } > "$MIG_ENV"
  grep -q '^OIDC_ISSUER=' "$MIG_ENV" || printf 'OIDC_ISSUER=https://sign-in.not-configured.invalid\nOIDC_CLIENT_ID=setup\n' >> "$MIG_ENV"
  grep -q '^SESSION_SIGNING_KEY=' "$MIG_ENV" || printf 'SESSION_SIGNING_KEY={"kty":"EC"}\n' >> "$MIG_ENV"
  chown root:"$APP_USER" "$MIG_ENV"; chmod 640 "$MIG_ENV"
  as_pb bash -c "cd '$APP_DIR' && node --env-file='$MIG_ENV' services/api/scripts/migrate.ts" | sed 's/^/    /'
  as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$MIG_ENV' scripts/storage-check.ts" | sed 's/^/    /'
  rm -f "$MIG_ENV"
fi

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

# ----------------------------------------------------------------------------- website settings (R4)
SITE_ENV=$ENV_DIR/site.env
if [[ ! -f $SITE_ENV ]]; then
  (umask 027; cat > "$SITE_ENV" <<'SITE'
# Website and portal settings (R4). Written once by vps-setup.sh; from then on this file is YOURS and never overwritten.
# After any change: systemctl restart pb-api pb-worker
#
# Where messages from the website's contact form are sent (needs the mail server, smtp.env).
SUPPORT_EMAIL=
# Optional: your service status page (https://...), linked in the website footer and the portal.
STATUS_URL=
SITE
  )
  ok "created $SITE_ENV (yours to fill in; never overwritten)"
fi
chown root:"$APP_USER" "$SITE_ENV"; chmod 640 "$SITE_ENV"

# ----------------------------------------------------------------------------- billing (milestone 11)
step "Billing (Stripe $([[ $PB_ENV == prod ]] && echo live || echo test) mode)"
# Your settings live in billing.env (written once, never overwritten). The webhook signing secret is not yours to copy:
# the Stripe CLI forwarder provides it (stripe-webhook.env, re-read on every run). Keys never appear on a command line.
BILLING_ENV=$ENV_DIR/billing.env
HOOK_ENV=$ENV_DIR/stripe-webhook.env
CLI_ENV=$ENV_DIR/stripe-cli.env
STRIPE_USER=pb-stripe
STRIPE_HOME=/var/lib/pb-stripe
STRIPE_CLI_VERSION=1.52.2
case "$NODE_ARCH" in  # SHA-256 from stripe-linux-checksums.txt of the v1.52.2 release (github.com/stripe/stripe-cli)
  x64)   STRIPE_ASSET=linux_x86_64; STRIPE_SHA256=a0b7951c47479931384f5a1ff535f5b5ca4aaa0628b5d1ffad02abf84abb36ed ;;
  arm64) STRIPE_ASSET=linux_arm64;  STRIPE_SHA256=83cc7f95fa83f1f36109b161a8cfcf9aa9321b6f2709488187d05891711e4d8c ;;
esac
STRIPE_EVENTS=customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,checkout.session.completed,checkout.session.async_payment_succeeded,invoice.paid,invoice.payment_failed,invoice.payment_succeeded,invoice.finalized,invoice.updated,invoice.voided,invoice.marked_uncollectible,charge.refunded,charge.dispute.created
if [[ ! -f $BILLING_ENV && $LOCAL_ENV == 0 ]]; then
  (umask 027; cat > "$BILLING_ENV" <<'BILLING'
# Billing settings (R6, staging/production). Written once by vps-setup.sh; from then on this file is YOURS.
# prod takes a LIVE key (sk_live_... or a restricted rk_live_...); staging a TEST key. After any change, run
# vps-setup.sh again. Type the values here on the server (e.g. with nano); never paste them into a chat or a ticket.
#
# 1. Your Stripe secret key (Stripe Dashboard -> Developers -> API keys).
STRIPE_SECRET_KEY=
#
# 2. Products, prices and the customer portal with YOUR prices (amounts in dollars), as root:
#      /opt/node/bin/node --env-file=/etc/project-browser/billing.env \
#        /home/pb/antibrowser/services/api/scripts/stripe-setup.ts \
#        --price starter=AMOUNT --price team=AMOUNT --price agency=AMOUNT --write /etc/project-browser/billing.env
#    It fills in these two lines:
BILLING_STRIPE_PRICES=
STRIPE_PORTAL_CONFIGURATION=
#
# 3. The webhook: Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
#      URL:    https://<SITE_HOST>/v1/webhooks/billing        (SITE_HOST from public.env)
#      Events: the list printed by vps-setup.sh (or docs/r6/operations-guide.md)
#    then "Reveal" the signing secret (whsec_...) and put it here. Several, comma-separated, while you rotate one.
STRIPE_WEBHOOK_SECRETS=
#
# Optional: let Stripe calculate tax (only after your tax registrations are set up in Stripe).
BILLING_AUTOMATIC_TAX=false
# Optional: days customer data is kept after cancellation (30-3650); empty = kept until an owner deletes it.
BILLING_RETENTION_DAYS=
BILLING
  )
  ok "created $BILLING_ENV (yours to fill in; never overwritten)"
fi
if [[ ! -f $BILLING_ENV ]]; then
  (umask 027; cat > "$BILLING_ENV" <<'BILLING'
# Billing settings (milestone 11). Written once by vps-setup.sh; from then on this file is YOURS and never overwritten.
# This test server accepts Stripe TEST-mode keys only. After any change, run vps-setup.sh again.
#
# 1. Your Stripe test secret key: Stripe Dashboard -> Developers -> API keys, with "Test mode" on (sk_test_...).
#    Type it here on the server (e.g. with nano). Never paste it into a chat or a ticket.
STRIPE_SECRET_KEY=
#
# 2. Products, prices and the customer portal, with YOUR prices (no defaults; amounts in dollars), as root:
#      /opt/node/bin/node --env-file=/etc/project-browser/billing.env \
#        /home/pb/antibrowser/services/api/scripts/stripe-setup.ts \
#        --price starter=AMOUNT --price team=AMOUNT --price agency=AMOUNT --write /etc/project-browser/billing.env
#    It fills in these two lines:
BILLING_STRIPE_PRICES=
STRIPE_PORTAL_CONFIGURATION=
#
# Optional: let Stripe calculate tax (only after your tax registrations are set up in Stripe).
BILLING_AUTOMATIC_TAX=false
# Optional: days customer data is kept after cancellation (30-3650); empty = kept until an owner deletes it.
BILLING_RETENTION_DAYS=
#
# The webhook signing secret does not go here: the Stripe CLI forwarder provides it (stripe-webhook.env).
BILLING
  )
  ok "created $BILLING_ENV (yours to fill in; never overwritten)"
fi
chown root:"$APP_USER" "$BILLING_ENV"; chmod 640 "$BILLING_ENV"
stripe_key=$(sed -nE "s/^STRIPE_SECRET_KEY=['\"]?([^'\" ]*)['\"]?[[:space:]]*$/\1/p" "$BILLING_ENV" | tail -1)
BILLING_ON=0
if [[ -z $stripe_key ]]; then
  if [[ -f /etc/systemd/system/pb-stripe-listen.service ]]; then
    systemctl disable -q --now pb-stripe-listen 2>/dev/null || true
    rm -f /etc/systemd/system/pb-stripe-listen.service
  fi
  rm -f "$HOOK_ENV" "$CLI_ENV"
  ok "billing not set up yet: put your Stripe key into $BILLING_ENV, then run this script again"
elif (( ! LOCAL_ENV )); then
  # R6: staging and production receive Stripe's events at their public address (an endpoint you add in the Stripe
  # Dashboard); the signature on every event is checked with that endpoint's secret. No forwarder.
  mode=$([[ $PB_ENV == prod ]] && echo live || echo test)
  [[ $stripe_key =~ ^(sk|rk)_${mode}_[A-Za-z0-9]{8,}$ ]] \
    || die "$BILLING_ENV: $PB_ENV takes a Stripe ${mode^^} secret key only ((sk|rk)_${mode}_...)"
  if [[ -f /etc/systemd/system/pb-stripe-listen.service ]]; then
    systemctl disable -q --now pb-stripe-listen 2>/dev/null || true
    rm -f /etc/systemd/system/pb-stripe-listen.service
  fi
  rm -f "$HOOK_ENV" "$CLI_ENV"
  hook=$(sed -nE "s/^STRIPE_WEBHOOK_SECRETS=['\"]?([^'\" ]*)['\"]?[[:space:]]*$/\1/p" "$BILLING_ENV" | tail -1)
  [[ $hook =~ ^whsec_[A-Za-z0-9]{16,}(,whsec_[A-Za-z0-9]{16,})*$ ]] \
    || die "$BILLING_ENV: STRIPE_WEBHOOK_SECRETS must hold the signing secret (whsec_...) of your webhook endpoint
         https://$(sed -n 's/^SITE_HOST=//p' "$PUBLIC_ENV")/v1/webhooks/billing with these events:
         $STRIPE_EVENTS"
  prices=$(sed -nE "s/^BILLING_STRIPE_PRICES=['\"]?(\{.*\})['\"]?[[:space:]]*$/\1/p" "$BILLING_ENV" | tail -1)
  ok "Stripe $mode mode: key and webhook signing secret present (events arrive at the public webhook address)"
  [[ -n $prices ]] || warn "no prices yet: run stripe-setup.ts with your amounts (see $BILLING_ENV), then this script again"
elif [[ ! $stripe_key =~ ^(sk|rk)_test_[A-Za-z0-9]{8,}$ ]]; then
  die "$BILLING_ENV: this test server accepts a Stripe TEST secret key only (sk_test_... or rk_test_...)"
else
  STRIPE_DIR=/opt/stripe-cli/$STRIPE_CLI_VERSION
  if [[ ! -x $STRIPE_DIR/stripe ]]; then
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/stripe.tgz" \
      "https://github.com/stripe/stripe-cli/releases/download/v$STRIPE_CLI_VERSION/stripe_${STRIPE_CLI_VERSION}_${STRIPE_ASSET}.tar.gz"
    echo "$STRIPE_SHA256  $tmp/stripe.tgz" | sha256sum -c --quiet - || die "the Stripe CLI download does not match its pinned SHA-256"
    install -d -m 755 "$STRIPE_DIR"
    tar -xzf "$tmp/stripe.tgz" -C "$STRIPE_DIR" stripe
    chown root:root "$STRIPE_DIR/stripe"; chmod 755 "$STRIPE_DIR/stripe"
    rm -rf "$tmp"
  fi
  ln -sfn "$STRIPE_DIR" /opt/stripe-cli/current
  ok "Stripe CLI $STRIPE_CLI_VERSION ($STRIPE_ASSET, SHA-256 verified)"
  id "$STRIPE_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$STRIPE_HOME" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$STRIPE_USER"
  install -d -m 700 -o "$STRIPE_USER" -g "$STRIPE_USER" "$STRIPE_HOME"
  (umask 027; printf 'STRIPE_API_KEY=%s\nSTRIPE_CLI_TELEMETRY_OPTOUT=1\n' "$stripe_key" > "$CLI_ENV")
  chown root:"$STRIPE_USER" "$CLI_ENV"; chmod 640 "$CLI_ENV"
  # The forwarder's signing secret (the same for this account and key; re-read on every run). Read from a file inside
  # the command, so the key is never an argument other users could see.
  hook_secret=$(runuser -u "$STRIPE_USER" -- env HOME="$STRIPE_HOME" bash -c \
    "set -a; . '$CLI_ENV'; exec /opt/stripe-cli/current/stripe listen --print-secret --skip-update" 2>/dev/null || true)
  [[ $hook_secret =~ ^whsec_[A-Za-z0-9]{16,}$ ]] \
    || die "Stripe did not accept the key in $BILLING_ENV (could not get a webhook signing secret); check it in the Stripe Dashboard (test mode)"
  (umask 027; printf '# Written by vps-setup.sh from the Stripe CLI forwarder; re-written on every run.\nSTRIPE_WEBHOOK_SECRETS=%s\n' \
    "$hook_secret" > "$HOOK_ENV")
  chown root:"$APP_USER" "$HOOK_ENV"; chmod 640 "$HOOK_ENV"
  # The CLI prints the signing secret when it connects; it is masked before anything reaches the journal.
  cat > /etc/systemd/system/pb-stripe-listen.service <<UNIT
[Unit]
Description=Project Browser: forwards Stripe test-mode events to the API (Stripe CLI)
After=network-online.target pb-api.service
Wants=network-online.target pb-api.service
PartOf=pb-api.service

[Service]
Type=simple
User=$STRIPE_USER
Group=$STRIPE_USER
Environment=HOME=$STRIPE_HOME
EnvironmentFile=$CLI_ENV
ExecStart=/bin/bash -c 'set -o pipefail; /opt/stripe-cli/current/stripe listen --skip-update --events $STRIPE_EVENTS --forward-to http://127.0.0.1:$API_PORT/v1/webhooks/billing 2>&1 | sed -u -E "s/whsec_[A-Za-z0-9]+/whsec_[redacted]/g"'
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=$STRIPE_HOME
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
  BILLING_ON=1
  prices=$(sed -nE "s/^BILLING_STRIPE_PRICES=['\"]?(\{.*\})['\"]?[[:space:]]*$/\1/p" "$BILLING_ENV" | tail -1)
  ok "Stripe test mode: key accepted, events forwarded to the API by pb-stripe-listen"
  [[ -n $prices ]] || warn "no prices yet: run stripe-setup.ts with your amounts (see $BILLING_ENV), then this script again"
fi

# ----------------------------------------------------------------------------- services
step "Services (systemd)"
if ! systemctl is-active --quiet pb-api && port_in_use "$API_PORT"; then
  die "port $API_PORT is already in use on this server. Re-run with PB_API_PORT=<free port> bash $SELF"
fi
unit() {  # name, description, workdir, entry, [extra [Service] lines], [extra [Unit] lines]
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target $PG_SERVICE.service pb-storage.service
Wants=network-online.target pb-storage.service
Requires=$PG_SERVICE.service
${6:-}

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$3
EnvironmentFile=$ENV_FILE
EnvironmentFile=-$ENV_DIR/billing.env
EnvironmentFile=-$ENV_DIR/stripe-webhook.env
EnvironmentFile=-$ENV_DIR/email.env
EnvironmentFile=-$ENV_DIR/site.env
# R6: the environment's sign-in settings (keycloak-setup.sh); in staging/prod the worker's configuration needs them too.
EnvironmentFile=-$ENV_DIR/oidc.env
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
${5:-}

[Install]
WantedBy=multi-user.target
EOF
}
# Milestone 10: the worker delivers webhooks to addresses customers choose. Besides its own checks (public addresses
# only, every DNS answer checked, connect to the checked address, no redirects), processes of the pb user (API,
# worker) may not reach private, link-local (cloud metadata), carrier-grade NAT or local IPv6 networks at all: an
# nftables table of their own rejects those destinations for that user only. Loopback (PostgreSQL, storage, Keycloak)
# and this server's DNS resolvers stay reachable; other users and existing firewall rules are untouched. (systemd's
# IPAddressDeny was used first; RHEL 8's default cgroup v1 accepts it but does not enforce it.)
EGRESS_FILE=$ENV_DIR/egress.nft
EGRESS_OK=0
if ! command -v nft >/dev/null 2>&1; then
  if [[ $FAMILY == rhel ]]; then
    dnf install -y -q nftables >/dev/null 2>&1 || true
  else
    apt-get install -y -qq nftables >/dev/null 2>&1 || true
  fi
fi
NFT=$(command -v nft || true)
egress_blocked() { "$NFT" list counter inet pb_egress blocked 2>/dev/null | awk '/packets/ {print $2; exit}'; }
if [[ -n $NFT ]]; then
  app_uid=$(id -u "$APP_USER")
  res4=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ {print $2}' /etc/resolv.conf 2>/dev/null | paste -sd, - || true)
  res6=$(awk '$1 == "nameserver" && $2 ~ /:/ {sub(/%.*/, "", $2); print $2}' /etc/resolv.conf 2>/dev/null \
    | paste -sd, - || true)
  dns4="" dns6=""
  if [[ -n $res4 ]]; then
    dns4="    ip daddr { $res4 } udp dport 53 accept"$'\n'"    ip daddr { $res4 } tcp dport 53 accept"
  fi
  if [[ -n $res6 ]]; then
    dns6="    ip6 daddr { $res6 } udp dport 53 accept"$'\n'"    ip6 daddr { $res6 } tcp dport 53 accept"
  fi
  cat > "$EGRESS_FILE.new" <<NFT_RULES
# Written by vps-setup.sh (re-written on every run): processes of user $APP_USER (uid $app_uid) may not open
# connections to private, link-local, carrier-grade NAT or local IPv6 networks. Loaded by pb-egress.service.
table inet pb_egress
delete table inet pb_egress
table inet pb_egress {
  counter blocked {
  }
  # Only packets from a socket of this user are judged. Packets without one (the kernel's own ICMP errors and resets,
  # including the refusals below on a server whose own address is private) pass, as does every other user's traffic.
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid $app_uid jump app_user
  }
  chain app_user {
    ct state established,related accept
$dns4
$dns6
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } counter name "blocked" reject with icmpx type admin-prohibited
    ip6 daddr { fc00::/7, fe80::/10 } counter name "blocked" reject with icmpx type admin-prohibited
  }
}
NFT_RULES
  chmod 0644 "$EGRESS_FILE.new"
  mv -f "$EGRESS_FILE.new" "$EGRESS_FILE"
  cat > /etc/systemd/system/pb-egress.service <<EGRESS_UNIT
[Unit]
Description=Project Browser egress policy (no private networks for user $APP_USER)
After=firewalld.service nftables.service
Before=pb-api.service pb-worker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$NFT -f $EGRESS_FILE
ExecStop=$NFT delete table inet pb_egress

[Install]
WantedBy=multi-user.target
EGRESS_UNIT
  systemctl daemon-reload
  systemctl enable -q pb-egress
  if systemctl restart pb-egress 2>/dev/null; then
    # Proof, not configuration: a connection by the pb user to a private address must be refused and counted.
    before=$(egress_blocked)
    runuser -u "$APP_USER" -- timeout 5 bash -c 'exec 3<>/dev/tcp/10.255.255.1/9' >/dev/null 2>&1 || true
    after=$(egress_blocked)
    if (( ${after:-0} > ${before:-0} )); then EGRESS_OK=1; fi
  fi
fi
# With the rules proven, the worker does not start without them (after a reboot as well).
WORKER_UNIT_EXTRA="Wants=pb-egress.service"$'\n'"After=pb-egress.service"
if (( EGRESS_OK )); then WORKER_UNIT_EXTRA="Requires=pb-egress.service"$'\n'"After=pb-egress.service"; fi
SERVER_KIND=$([[ $PB_ENV == dev ]] && echo "test server" || echo "$PB_ENV")
unit pb-api "Project Browser API ($SERVER_KIND)" "$APP_DIR/services/api" "src/server.ts" "" \
  "Wants=pb-egress.service"$'\n'"After=pb-egress.service"
unit pb-worker "Project Browser outbox worker ($SERVER_KIND)" "$APP_DIR/services/worker" "src/main.ts" "" \
  "$WORKER_UNIT_EXTRA"
systemctl daemon-reload
systemctl enable -q pb-api pb-worker
if (( ! LOCAL_ENV )); then
  # R6: the TLS proxy and this environment's sign-in (realm, clients for the public addresses, session key) come
  # first: the API refuses to start in staging/prod without an https issuer. Both run from root-owned copies.
  install -m 700 -o root -g root "$APP_DIR/scripts/deploy/public-setup.sh" /root/.pb-public-setup.sh
  bash /root/.pb-public-setup.sh || die "the public address setup failed (see above)"
  install -m 700 -o root -g root "$APP_DIR/scripts/deploy/keycloak-setup.sh" /root/.pb-keycloak-setup.sh
  bash /root/.pb-keycloak-setup.sh || die "the sign-in setup failed (see above)"
fi
systemctl restart pb-api pb-worker
ok "pb-api and pb-worker enabled and restarted"
LISTEN_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
if (( BILLING_ON )); then
  systemctl daemon-reload
  systemctl enable -q pb-stripe-listen
  systemctl restart pb-stripe-listen
  ok "pb-stripe-listen enabled and restarted"
fi
if (( EGRESS_OK )); then
  ok "worker egress: private, link-local and CGNAT networks refused to user $APP_USER (nftables; test connection refused)"
else
  warn "could not apply the egress rules (nftables); webhook deliveries rely on the worker's own address checks"
fi

# ----------------------------------------------------------------------------- smoke test
step "Smoke test"
base="http://127.0.0.1:$API_PORT/v1"
for _ in $(seq 1 30); do curl -fsS "$base/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$base/health" >/dev/null || { journalctl -u pb-api -n 30 --no-pager; die "API did not become healthy"; }
ok "health: $(curl -fsS "$base/health")"
ready=$(curl -sS "$base/ready" || true)
[[ $ready == *'"status":"ready"'* ]] && ok "ready: $ready" || die "the API is not ready: $ready"
if (( LOCAL_ENV )); then
  TOKEN=$(as_pb bash -c "cd '$APP_DIR' && node --env-file='$ENV_FILE' services/api/scripts/dev-token.ts acmeOwner")
  me=$(curl -fsS -H "authorization: Bearer $TOKEN" "$base/me")
  [[ $me == *'"role":"owner"'* ]] && ok "fixture login works (acmeOwner)" || die "unexpected /me response: $me"
  own=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$base/orgs/org_01J9ZSEED0ACME000000000000/profiles")
  other=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$base/orgs/org_01J9ZSEED0BETA000000000000/profiles")
  [[ $own == 200 && $other == 404 ]] && ok "own tenant 200, other tenant 404 (isolation holds)" || die "tenant check failed: own=$own other=$other"
else
  # R6: no development tokens here; an invented one is refused.
  fake="dev.$(randhex 8)"   # a made-up development token
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $fake" "$base/me")
  [[ $code == 401 ]] && ok "development tokens are refused ($PB_ENV)" || die "a made-up development token got HTTP $code"
fi
sleep 2
systemctl is-active --quiet pb-worker && ok "worker running" || { journalctl -u pb-worker -n 30 --no-pager; die "worker not running"; }
if (( LOCAL_ENV )); then
  if as_pb bash -c "cd '$APP_DIR/services/api' && node --env-file='$ENV_FILE' scripts/snapshot-smoke.ts" > /tmp/pb-snapshot-smoke.log 2>&1; then
    ok "$(tail -1 /tmp/pb-snapshot-smoke.log)"
  else
    tail -5 /tmp/pb-snapshot-smoke.log; journalctl -u pb-worker -n 20 --no-pager
    die "the snapshot round trip failed"
  fi
fi
console_csp=$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$API_PORT/console/" | tr -d '\r' | sed -n 's/^content-security-policy: //Ip')
[[ $console_csp == *"script-src 'self'"* && $console_csp == *"frame-ancestors 'none'"* ]] \
  && ok "support console served at /console/ with its Content-Security-Policy" \
  || die "the support console is not served at /console/ (or without its CSP)"
if (( BILLING_ON )); then
  for _ in $(seq 1 30); do
    journalctl -u pb-stripe-listen --since "$LISTEN_SINCE" --no-pager 2>/dev/null | grep -q 'Ready!' && break; sleep 1
  done
  if journalctl -u pb-stripe-listen --since "$LISTEN_SINCE" --no-pager 2>/dev/null | grep -q 'Ready!'; then
    ok "Stripe events forwarder connected (journalctl -u pb-stripe-listen)"
  else
    journalctl -u pb-stripe-listen -n 20 --no-pager
    die "the Stripe events forwarder did not connect"
  fi
  if journalctl -u pb-stripe-listen --no-pager 2>/dev/null | grep -qE 'whsec_[A-Za-z0-9]{8}'; then
    die "the webhook signing secret reached the journal (it should be masked)"
  fi
fi
pub=$(ss -ltnH | awk '{print $4}' | grep -E ":(5432|$API_PORT|${STORE_PORTS// /|})\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
[[ -z $pub ]] && ok "PostgreSQL, storage and API listen on localhost only" || die "something listens publicly: $pub"

# ----------------------------------------------------------------------------- off-site backups (milestone 12)
# Run from a root-owned copy; it installs its own root-owned copy for the timers.
install -m 700 -o root -g root "$APP_DIR/scripts/deploy/backup-setup.sh" /root/.pb-backup-setup.sh
bash /root/.pb-backup-setup.sh || die "the off-site backup setup failed (see above)"

# ----------------------------------------------------------------------------- preflight report (R6)
if (( ! LOCAL_ENV )); then
  install -m 700 -o root -g root "$APP_DIR/scripts/deploy/preflight.sh" /root/.pb-preflight.sh
  step "Preflight report ($PB_ENV)"
  if bash /root/.pb-preflight.sh; then
    ok "every required check passed"
  else
    warn "some required checks FAILED (above). The service runs, but it is not ready for customers until they pass."
  fi
fi

# ----------------------------------------------------------------------------- summary
step "Done"
if (( ! LOCAL_ENV )); then
  pub() { sed -n "s/^$1=//p" "$PUBLIC_ENV" | tr -d '"'"'"' \r'; }
  cat <<EOF
    Environment: $PB_ENV ($ENV_MARK)   |   code: $APP_DIR ($(as_pb git -C "$APP_DIR" log -1 --format=%h))
    Website:     https://$(pub SITE_HOST)/          customer portal: https://$(pub SITE_HOST)/app/
    Staff:       https://$(pub ADMIN_HOST)/console/  (password + one-time code)
    Sign-in:     https://$(pub ID_HOST)/             (Keycloak administration is NOT public: SSH tunnel to 127.0.0.1:8081)
    Services:    systemctl status pb-api pb-worker pb-storage keycloak pb-proxy
    Preflight:   bash $APP_DIR/scripts/deploy/preflight.sh      (report: /var/lib/pb-preflight/latest.json)
    Update:      \\cp -f $APP_DIR/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh
    Billing:     $BILLING_ENV (yours)   |   Mail: $ENV_DIR/smtp.env (yours)   |   Off-site: $ENV_DIR/backup.env (yours)
    Guide:       docs/r6/operations-guide.md
EOF
  if [[ $NEW_ROOT_KEY == 1 ]]; then
    printf '\n\033[1;33m    IMPORTANT:\033[0m a new backup root key was created. Copy it off the server now and keep it offline:\n'
    printf '      scp root@<this-server>:%s ./project-browser-root-key-%s.json\n' "$KMS_FILE" "$PB_ENV"
  fi
  exit 0
fi
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
    Console:   http://127.0.0.1:$API_PORT/console/ (staff only; needs keycloak-setup.sh and a staff role:
               runuser -u pb -- bash -c "cd $APP_DIR/services/api && /opt/node/bin/node --env-file=$ENV_FILE scripts/staff.ts add you@example.com --roles support_lead,billing_admin")
    Billing:   $BILLING_ENV (yours; Stripe TEST key and prices)  |  forwarder: journalctl -u pb-stripe-listen -f
    Root key:  $KMS_FILE   |  bash $APP_DIR/scripts/deploy/root-key.sh status
    Off-site:  $ENV_DIR/backup.env (yours; Cloudflare R2)  |  status: bash /usr/local/libexec/pb-backup status
               restore drill: \\cp -f $APP_DIR/scripts/deploy/restore-drill.sh /root/ && bash /root/restore-drill.sh
EOF
if [[ $NEW_ROOT_KEY == 1 ]]; then
  printf '\n\033[1;33m    IMPORTANT:\033[0m a new backup root key was created. Without it no organization backup on this\n'
  printf '    server can ever be decrypted. Copy it off the server now and keep it offline:\n'
  printf '      scp root@<this-server>:%s ./project-browser-root-key.json\n' "$KMS_FILE"
fi
