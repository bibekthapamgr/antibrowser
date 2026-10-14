#!/usr/bin/env bash
# Project Browser — self-hosted Keycloak, the reference sign-in provider (ADR-0013), on the test server.
#
# Run it AFTER vps-setup.sh, as root. Idempotent: re-run it to update or repair.
#   1. Java 21 (the distribution's OpenJDK; Eclipse Temurin 21 when the distribution has none, checksum verified) and
#      Keycloak (official release, SHA-256 pinned below) in /opt/keycloak-<version>, run as the user `keycloak`.
#   2. Its own PostgreSQL role and database (random password). Production mode, single node, plain HTTP on
#      127.0.0.1 only: you reach it through the same SSH tunnel as the API. Firewall and SSH settings are not touched.
#   3. Realm `project-browser` with the public desktop client `project-browser-desktop` (Authorization Code + PKCE S256,
#      redirect projectbrowser://auth/callback only), no self-registration, brute-force protection, password policy.
#   4. Accounts made here count as e-mail-verified (this server sends no e-mail) and get a temporary password that
#      must be replaced at the first sign-in.
#   5. Connects the API: /etc/project-browser/oidc.env (issuer, client, a persistent session-signing key) plus a
#      systemd drop-in for pb-api. vps-setup.sh never touches either, so later updates keep sign-in working.
#   6. Milestone 11: the support console's own public client `project-browser-console` (Authorization Code + PKCE
#      S256 from the console page at http://127.0.0.1:<API port>/console/, that origin only for the token endpoint).
#      Staff roles are not given here: see services/api/scripts/staff.ts.
#
# Usage (as root):
#   bash keycloak-setup.sh --owner-email you@example.com [--otp]   install or update; creates your account
#   bash keycloak-setup.sh add-user someone@example.com [--otp]     another account (temporary password shown once)
#   bash keycloak-setup.sh reset-password someone@example.com       new temporary password; also unlocks the account
#   --otp: the account must also set up an authenticator app (one-time codes) at its first sign-in.
# Env overrides: PB_KC_PORT (8081), PB_API_PORT (8080); PB_TEMP_PASSWORD_FILE (tests: write temporary passwords
#                to this file instead of the screen)
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR

KC_VERSION=26.6.2
# SHA-256 of keycloak-26.6.2.tar.gz as published on https://github.com/keycloak/keycloak/releases/tag/26.6.2
KC_SHA256=6837fcd1c7ed2a1375227501116949098e56995ea53d7379b3d54f4dd786433d
KC_DOWNLOAD=https://github.com/keycloak/keycloak/releases/download/$KC_VERSION/keycloak-$KC_VERSION.tar.gz
KC_PORT="${PB_KC_PORT:-8081}"
API_PORT="${PB_API_PORT:-8080}"

KC_HOME=/opt/keycloak-$KC_VERSION
KC_LINK=/opt/keycloak
KC_USER=keycloak
KC_ADMIN_USER="admin"
KC_BASE=http://127.0.0.1:$KC_PORT
REALM=project-browser
CLIENT_ID=project-browser-desktop
REDIRECT=projectbrowser://auth/callback
CONSOLE_CLIENT_ID=project-browser-console
CONSOLE_ORIGIN=http://127.0.0.1:$API_PORT
CONSOLE_REDIRECT=$CONSOLE_ORIGIN/console/
ISSUER=$KC_BASE/realms/$REALM
UNIT=/etc/systemd/system/keycloak.service
ENV_DIR=/etc/project-browser
ADMIN_FILE=$ENV_DIR/keycloak-admin           # Keycloak administrator password (root only)
BOOTSTRAP_ENV=$ENV_DIR/keycloak-bootstrap.env # exists only until the first administrator is confirmed
DB_PW_FILE=$ENV_DIR/keycloak-db               # PostgreSQL password of the keycloak role (root only)
OIDC_ENV=$ENV_DIR/oidc.env
DROPIN=/etc/systemd/system/pb-api.service.d/oidc.conf
NODE=/opt/node/bin/node
SELF=$(readlink -f "$0")
cd /  # independent of the caller's directory

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33mWARNING:\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '/^# Usage/,/^# Env/p' "$SELF" | sed 's/^# \{0,1\}//'; }
port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
randhex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
temp_password() { head -c 12 /dev/urandom | base64 | tr '+/' '-_'; }
# js 'expression of d': evaluates against the JSON on stdin; exit 3 when the result is null/undefined.
js() {
  "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=s?JSON.parse(s):null;
    const v=new Function("d","return ("+process.argv[1]+")")(d);if(v===undefined||v===null)process.exit(3);
    process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1"
}
# mkjson 'expression of e': prints JSON; e is the environment (pass values as VAR=value before the call).
mkjson() { "$NODE" -e 'process.stdout.write(JSON.stringify(new Function("e","return ("+process.argv[1]+")")(process.env)))' "$1"; }

# ----------------------------------------------------------------------------- arguments
CMD=setup; EMAIL=""; OTP=0
if [[ ${1:-} == add-user || ${1:-} == reset-password ]]; then
  CMD=$1; EMAIL=${2:-}
  shift $(( $# > 1 ? 2 : 1 ))
fi
while (( $# )); do
  case $1 in
    --owner-email) [[ $CMD == setup && $# -ge 2 ]] || die "usage: bash $SELF --owner-email you@example.com"
                   EMAIL=$2; shift 2 ;;
    --owner-email=*) [[ $CMD == setup ]] || die "--owner-email is for the setup run"; EMAIL=${1#*=}; shift ;;
    --otp) OTP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see: bash $SELF --help)" ;;
  esac
done
EMAIL=${EMAIL,,}
email_re='^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
[[ -z $EMAIL || $EMAIL =~ $email_re ]] || die "not an e-mail address: $EMAIL"
[[ $CMD == setup || -n $EMAIL ]] || die "usage: bash $SELF $CMD someone@example.com"
[[ $KC_PORT =~ ^[0-9]+$ && $API_PORT =~ ^[0-9]+$ && $KC_PORT != "$API_PORT" ]] || die "invalid PB_KC_PORT / PB_API_PORT"

WORK=$(mktemp -d -p /var/tmp pb-keycloak.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
HDR=$WORK/auth-header

# ----------------------------------------------------------------------------- Keycloak administration API
kc_login() {  # administrator token into $HDR (read by curl from the file, so it never appears in a process list)
  [[ -s $ADMIN_FILE ]] || return 1
  local status
  status=$(printf '%s' "$(<"$ADMIN_FILE")" | curl -sS -o "$WORK/token" -w '%{http_code}' \
    --data-urlencode grant_type=password --data-urlencode client_id=admin-cli \
    --data-urlencode "username=$KC_ADMIN_USER" --data-urlencode "password@-" \
    "$KC_BASE/realms/master/protocol/openid-connect/token") || return 1
  [[ $status == 200 ]] || return 1
  printf 'Authorization: Bearer %s\n' "$(js 'd.access_token' < "$WORK/token")" > "$HDR"
  rm -f "$WORK/token"
}
kc_call() {  # METHOD PATH [curl args...]: body in $WORK/body, HTTP status in $KC_STATUS (signs in again once on 401)
  local method=$1 path=$2 try; shift 2
  for try in 1 2; do
    KC_STATUS=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X "$method" -H @"$HDR" \
      -H 'content-type: application/json' "$@" "$KC_BASE/admin/realms$path")
    [[ $KC_STATUS == 401 && $try == 1 ]] || return 0
    admin_login_or_die
  done
}
admin_login_or_die() {
  kc_login || die "cannot sign in to the Keycloak administration as '$KC_ADMIN_USER' with the password in $ADMIN_FILE.
         If you changed that password in the admin console, write the new one into the file and re-run."
}
user_id() {  # e-mail -> Keycloak user id ("" when there is none)
  kc_call GET "/$REALM/users" -G --data-urlencode "email=$1" --data-urlencode exact=true
  [[ $KC_STATUS == 200 ]] || die "Keycloak user lookup failed ($KC_STATUS)"
  js 'd.length ? d[0].id : ""' < "$WORK/body"
}
account_box() {  # e-mail, temporary password
  local first="choose your own password and enter your name" shown=$2
  if (( OTP )); then first="choose your own password, set up an authenticator app and enter your name"; fi
  if [[ -n ${PB_TEMP_PASSWORD_FILE:-} ]]; then  # automated tests: keep the password out of the log
    (umask 077; printf '%s' "$2" > "$PB_TEMP_PASSWORD_FILE")
    shown="(written to $PB_TEMP_PASSWORD_FILE)"
  fi
  cat <<EOF

    +--------------------------------------------------------------------------------
    | Project Browser account:  $1
    | Temporary password:       $shown
    | Shown only once; type it only into the sign-in page.
    | At the first sign-in you $first.
    +--------------------------------------------------------------------------------
EOF
}
USER_RESULT=""; ACCOUNT_TEXT=""
create_user() {  # e-mail -> USER_RESULT=created|exists, ACCOUNT_TEXT
  local pw; pw=$(temp_password)
  E=$1 P=$pw O=$OTP mkjson '({ username: e.E, email: e.E, emailVerified: true, enabled: true,
      requiredActions: e.O === "1" ? ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] : ["UPDATE_PASSWORD"],
      credentials: [{ type: "password", value: e.P, temporary: true }] })' > "$WORK/user.json"
  kc_call POST "/$REALM/users" --data-binary @"$WORK/user.json"
  rm -f "$WORK/user.json"
  case $KC_STATUS in
    201) USER_RESULT=created; ACCOUNT_TEXT=$(account_box "$1" "$pw") ;;
    409) USER_RESULT=exists ;;
    *) die "Keycloak refused the account ($KC_STATUS): $(<"$WORK/body")" ;;
  esac
}
reset_password() {  # e-mail -> ACCOUNT_TEXT
  local uid pw
  uid=$(user_id "$1")
  [[ -n $uid ]] || die "there is no account for $1 (create it: bash $SELF add-user $1)"
  pw=$(temp_password)
  P=$pw mkjson '({ type: "password", value: e.P, temporary: true })' > "$WORK/pw.json"
  kc_call PUT "/$REALM/users/$uid/reset-password" --data-binary @"$WORK/pw.json"
  rm -f "$WORK/pw.json"
  [[ $KC_STATUS == 204 ]] || die "Keycloak refused the new password ($KC_STATUS): $(<"$WORK/body")"
  if (( OTP )); then
    kc_call PUT "/$REALM/users/$uid" --data-binary '{"requiredActions":["UPDATE_PASSWORD","CONFIGURE_TOTP"]}'
    [[ $KC_STATUS == 204 ]] || die "could not require an authenticator app ($KC_STATUS)"
  fi
  kc_call DELETE "/$REALM/attack-detection/brute-force/users/$uid"  # unlock after too many failed attempts
  ACCOUNT_TEXT=$(account_box "$1" "$pw")
}

# ----------------------------------------------------------------------------- preflight
step "Preflight"
[[ $EUID -eq 0 ]] || die "run as root (sudo bash $SELF ...)"
[[ -r /etc/os-release ]] || die "cannot detect the operating system"
# shellcheck source=/dev/null
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*) FAMILY=rhel; PG_BIN=/usr/pgsql-18/bin; PG_SERVICE=postgresql-18 ;;
  *debian*|*ubuntu*) FAMILY=debian; PG_BIN=/usr/lib/postgresql/18/bin; PG_SERVICE=postgresql ;;
  *) die "unsupported OS: ${PRETTY_NAME:-$ID}" ;;
esac
if ! { [[ -x $NODE && -f $ENV_DIR/api.env && -x $PG_BIN/psql ]] && systemctl cat pb-api >/dev/null 2>&1; }; then
  die "run vps-setup.sh first: it installs PostgreSQL, Node.js and the API that this script connects to."
fi
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
ok "${PRETTY_NAME:-$ID} ($FAMILY, $(uname -m)), $(nproc) CPU, $MEM_MB MB RAM"

if [[ $CMD != setup ]]; then
  systemctl is-active --quiet keycloak || die "Keycloak is not running. Set it up first: bash $SELF --owner-email you@example.com"
  admin_login_or_die
  if [[ $CMD == add-user ]]; then
    create_user "$EMAIL"
    [[ $USER_RESULT == created ]] || die "$EMAIL already has an account. New temporary password: bash $SELF reset-password $EMAIL"
    ok "account created"
  else
    reset_password "$EMAIL"
    ok "new temporary password set; the account is unlocked"
  fi
  printf '%s\n' "$ACCOUNT_TEXT"
  exit 0
fi

(( MEM_MB >= 1800 )) || warn "Keycloak needs about 1 GB of memory by itself and this server has $MEM_MB MB in total;
             it may be slow, or be stopped when memory runs out (journalctl -u keycloak shows it)."
(( $(df -Pm /opt | awk 'NR==2{print $4}') > 1500 )) || die "need at least 1.5 GB free disk space in /opt"

# ----------------------------------------------------------------------------- Java 21
step "Java 21"
java_ok() { [[ -x $1/bin/java ]] && "$1/bin/java" -version 2>&1 | grep -qE 'version "21[."]'; }
distro_java() {  # stable paths (they survive package updates), not the versioned directories behind them
  local d
  for d in /usr/lib/jvm/jre-21 /usr/lib/jvm/jre-21-openjdk /usr/lib/jvm/java-21-openjdk-amd64 \
           /usr/lib/jvm/java-21-openjdk-arm64 /usr/lib/jvm/java-21-openjdk; do
    if java_ok "$d"; then echo "$d"; return 0; fi
  done
  return 1
}
install_temurin() {
  local arch meta link sum rel dest
  arch=$([[ $(uname -m) == x86_64 ]] && echo x64 || echo aarch64)
  meta=$(curl -fsSL "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=$arch&image_type=jre&os=linux&vendor=eclipse") \
    || die "this distribution has no OpenJDK 21 package and api.adoptium.net is not reachable"
  link=$(js 'd[0].binary.package.link' <<<"$meta")
  sum=$(js 'd[0].binary.package.checksum' <<<"$meta")
  rel=$(js 'd[0].release_name' <<<"$meta")
  [[ $rel =~ ^jdk-21[0-9.+]*$ && $sum =~ ^[0-9a-f]{64}$ && $link == https://* ]] || die "unexpected answer from api.adoptium.net"
  dest=/opt/temurin-${rel#jdk-}-jre
  if ! java_ok "$dest"; then
    curl -fsSL "$link" -o "$WORK/jre.tar.gz"
    echo "$sum  $WORK/jre.tar.gz" | sha256sum -c --quiet - || die "Java download failed its checksum"
    rm -rf "$dest" && mkdir -p "$dest"
    tar -xzf "$WORK/jre.tar.gz" -C "$dest" --strip-components=1 --no-same-owner
    rm -f "$WORK/jre.tar.gz"
  fi
  ln -sfn "$dest" /opt/java-21
  ok "Eclipse Temurin $rel in $dest (checksum verified; re-running this script updates it)"
}
if JAVA_HOME=$(distro_java); then
  :
else
  if [[ $FAMILY == rhel ]]; then
    dnf install -y -q java-21-openjdk-headless >/dev/null 2>&1 || true
  else
    export DEBIAN_FRONTEND=noninteractive
    { apt-get update -qq && apt-get install -y -qq openjdk-21-jre-headless; } >/dev/null 2>&1 || true
  fi
  if ! JAVA_HOME=$(distro_java); then
    install_temurin
    JAVA_HOME=/opt/java-21
  fi
fi
java_ok "$JAVA_HOME" || die "no working Java 21 in $JAVA_HOME"
ok "$("$JAVA_HOME/bin/java" -version 2>&1 | head -1) ($JAVA_HOME)"

# ----------------------------------------------------------------------------- Keycloak
step "Keycloak $KC_VERSION"
CHANGED=0
id "$KC_USER" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/keycloak --no-create-home --shell /usr/sbin/nologin "$KC_USER"
if [[ ! -x $KC_HOME/bin/kc.sh ]]; then
  curl -fsSL "$KC_DOWNLOAD" -o "$WORK/keycloak.tar.gz"
  echo "$KC_SHA256  $WORK/keycloak.tar.gz" | sha256sum -c --quiet - \
    || die "Keycloak download failed its checksum (expected SHA-256 $KC_SHA256). Not installing it."
  tar -xzf "$WORK/keycloak.tar.gz" -C "$WORK" --no-same-owner
  rm -rf "$KC_HOME" && mv "$WORK/keycloak-$KC_VERSION" "$KC_HOME"
  rm -f "$WORK/keycloak.tar.gz"
  chown -R root:root "$KC_HOME"
  CHANGED=1
  ok "downloaded and verified (SHA-256 $KC_SHA256) into $KC_HOME"
else
  ok "installed in $KC_HOME"
fi
previous=""
if [[ -L $KC_LINK ]]; then
  previous=$(readlink -f "$KC_LINK")
elif [[ -e $KC_LINK ]]; then
  die "$KC_LINK exists and is not a link made by this script (an earlier manual install?). Move it away, then re-run."
fi
ln -sfn "$KC_HOME" "$KC_LINK"
if [[ -n $previous && $previous != "$KC_HOME" ]]; then
  CHANGED=1
  ok "now using $KC_HOME instead of $previous (delete the old folder once this version works)"
fi

# ----------------------------------------------------------------------------- database
step "Database"
if ! runuser -u postgres -- "$PG_BIN/pg_isready" -q -h 127.0.0.1; then
  die "PostgreSQL is not running (systemctl status $PG_SERVICE)"
fi
if [[ -s $DB_PW_FILE ]]; then
  DB_PW=$(<"$DB_PW_FILE")
else
  DB_PW=$(randhex 24)
  (umask 077; printf '%s' "$DB_PW" > "$DB_PW_FILE")
fi
[[ $DB_PW =~ ^[0-9a-f]{48}$ ]] || die "$DB_PW_FILE does not contain a password generated by this script"
(cd /tmp && runuser -u postgres -- "$PG_BIN/psql" -q -v ON_ERROR_STOP=1 -f -) <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'keycloak') then create role keycloak login; end if;
end \$\$;
alter role keycloak password '$DB_PW';
select 'create database keycloak owner keycloak'
where not exists (select 1 from pg_database where datname = 'keycloak') \gexec
SQL
ok "role and database 'keycloak' (password in $DB_PW_FILE, readable by root only)"

# ----------------------------------------------------------------------------- configuration + optimized build
step "Configuration"
CONF=$KC_HOME/conf/keycloak.conf
conf_text=$(cat <<EOF
# Generated by scripts/deploy/keycloak-setup.sh. Re-run the script instead of editing: changes are overwritten.
# Production mode, single node, plain HTTP on the loopback interface only (reached through the SSH tunnel).
db=postgres
db-url-host=127.0.0.1
db-url-port=5432
db-url-database=keycloak
db-username=keycloak
db-password=$DB_PW
http-enabled=true
http-host=127.0.0.1
http-port=$KC_PORT
hostname=$KC_BASE
cache=local
health-enabled=false
metrics-enabled=false
EOF
)
if [[ ! -f $CONF || "$(<"$CONF")" != "$conf_text" ]]; then
  (umask 027; printf '%s\n' "$conf_text" > "$CONF")
  CHANGED=1
fi
chown root:"$KC_USER" "$CONF"; chmod 640 "$CONF"
build_id=$(grep -v '^db-password=' "$CONF" | sha256sum | cut -c1-64)
if [[ ! -f $KC_HOME/lib/.pb-build || "$(<"$KC_HOME/lib/.pb-build")" != "$build_id" ]]; then
  if ! JAVA_HOME=$JAVA_HOME "$KC_HOME/bin/kc.sh" build > "$WORK/build.log" 2>&1; then
    tail -40 "$WORK/build.log"; die "Keycloak build failed"
  fi
  printf '%s' "$build_id" > "$KC_HOME/lib/.pb-build"
  CHANGED=1
  ok "optimized build done"
fi
install -d -o "$KC_USER" -g "$KC_USER" -m 750 "$KC_HOME/data"
chown -R "$KC_USER:$KC_USER" "$KC_HOME/data"
ok "$CONF (root:$KC_USER 0640): PostgreSQL, HTTP on 127.0.0.1:$KC_PORT, no clustering"

# ----------------------------------------------------------------------------- service
step "Service (systemd)"
if ! systemctl is-active --quiet keycloak && port_in_use "$KC_PORT"; then
  die "port $KC_PORT is already used on this server. Re-run with PB_KC_PORT=<free port> bash $SELF ..."
fi
if [[ ! -s $ADMIN_FILE ]]; then
  # First start: Keycloak creates its administrator from these variables (only while it has none), then the file goes.
  (umask 077
   printf '%s' "$(randhex 24)" > "$ADMIN_FILE"
   printf 'KC_BOOTSTRAP_ADMIN_USERNAME=%s\nKC_BOOTSTRAP_ADMIN_PASSWORD=%s\n' "$KC_ADMIN_USER" "$(<"$ADMIN_FILE")" > "$BOOTSTRAP_ENV")
fi
if [[ -f $BOOTSTRAP_ENV ]]; then CHANGED=1; fi
unit_text=$(cat <<EOF
[Unit]
Description=Keycloak sign-in provider for Project Browser (test server)
After=network-online.target $PG_SERVICE.service
Wants=network-online.target
Requires=$PG_SERVICE.service

[Service]
Type=exec
User=$KC_USER
Group=$KC_USER
Environment=JAVA_HOME=$JAVA_HOME
Environment="JAVA_OPTS_KC_HEAP=-Xms64m -Xmx512m"
EnvironmentFile=-$BOOTSTRAP_ENV
ExecStart=$KC_LINK/bin/kc.sh start --optimized
SuccessExitStatus=143
TimeoutStartSec=300
Restart=on-failure
RestartSec=5
StateDirectory=keycloak
ReadWritePaths=$KC_HOME/data
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
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
EOF
)
if [[ ! -f $UNIT || "$(<"$UNIT")" != "$unit_text" ]]; then
  printf '%s\n' "$unit_text" > "$UNIT"
  CHANGED=1
fi
systemctl daemon-reload
systemctl enable -q keycloak
if (( CHANGED )); then
  systemctl restart keycloak
  ok "keycloak (re)started"
else
  systemctl start keycloak
  ok "keycloak running, nothing changed"
fi
if ! curl -fsS -o /dev/null "$KC_BASE/realms/master" 2>/dev/null; then
  printf '    waiting for Keycloak (the first start creates its database tables and takes a minute or two) '
  for _ in $(seq 1 150); do
    curl -fsS -o /dev/null "$KC_BASE/realms/master" 2>/dev/null && break
    printf '.'; sleep 2
  done
  echo
fi
if ! curl -fsS -o /dev/null "$KC_BASE/realms/master"; then
  journalctl -u keycloak -n 60 --no-pager
  die "Keycloak did not start (journalctl -u keycloak)"
fi
admin_login_or_die
rm -f "$BOOTSTRAP_ENV"
ok "Keycloak answers on $KC_BASE; administrator sign-in works"

# ----------------------------------------------------------------------------- realm, client, owner account
step "Realm '$REALM' and the desktop client"
kc_call GET "/$REALM"
case $KC_STATUS in
  200) ok "realm exists (its settings are yours to change in the admin console; this script leaves them)" ;;
  404)
    R=$REALM mkjson '({ realm: e.R, enabled: true, displayName: "Project Browser",
        registrationAllowed: false, registrationEmailAsUsername: true, loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false, editUsernameAllowed: false, resetPasswordAllowed: false, rememberMe: false,
        verifyEmail: false, sslRequired: "external",
        bruteForceProtected: true, permanentLockout: false, failureFactor: 10,
        waitIncrementSeconds: 60, maxFailureWaitSeconds: 900, maxDeltaTimeSeconds: 43200,
        passwordPolicy: "length(12) and notUsername and notEmail and passwordHistory(3)" })' > "$WORK/realm.json"
    kc_call POST "" --data-binary @"$WORK/realm.json"
    [[ $KC_STATUS == 201 ]] || die "could not create the realm ($KC_STATUS): $(<"$WORK/body")"
    ok "realm created: no self-registration, brute-force protection, passwords of 12+ characters"
    ;;
  *) die "realm lookup failed ($KC_STATUS): $(<"$WORK/body")" ;;
esac
# The client's security settings are what the API and the desktop rely on, so they are enforced on every run.
C=$CLIENT_ID U=$REDIRECT mkjson '({ clientId: e.C, name: "Project Browser desktop", enabled: true,
    protocol: "openid-connect", publicClient: true, standardFlowEnabled: true, implicitFlowEnabled: false,
    directAccessGrantsEnabled: false, serviceAccountsEnabled: false, consentRequired: false,
    frontchannelLogout: false, redirectUris: [e.U], webOrigins: [],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "",
                  "oauth2.device.authorization.grant.enabled": "false", "oidc.ciba.grant.enabled": "false" } })' \
  > "$WORK/client.json"
kc_call GET "/$REALM/clients" -G --data-urlencode "clientId=$CLIENT_ID"
[[ $KC_STATUS == 200 ]] || die "client lookup failed ($KC_STATUS)"
client_uuid=$(js 'd.length ? d[0].id : ""' < "$WORK/body")
if [[ -z $client_uuid ]]; then
  kc_call POST "/$REALM/clients" --data-binary @"$WORK/client.json"
  [[ $KC_STATUS == 201 ]] || die "could not create the client ($KC_STATUS): $(<"$WORK/body")"
  ok "client '$CLIENT_ID' created"
else
  kc_call PUT "/$REALM/clients/$client_uuid" --data-binary @"$WORK/client.json"
  [[ $KC_STATUS == 204 ]] || die "could not update the client ($KC_STATUS): $(<"$WORK/body")"
  ok "client '$CLIENT_ID' checked"
fi
ok "public client, Authorization Code + PKCE (S256) only, redirect $REDIRECT only"

# Milestone 11: the support console signs staff in from its page in the browser, so its token endpoint calls come from
# the console's origin (CORS for exactly that origin). Enforced on every run like the desktop client.
C=$CONSOLE_CLIENT_ID U=$CONSOLE_REDIRECT O=$CONSOLE_ORIGIN mkjson '({ clientId: e.C,
    name: "Project Browser support console", enabled: true,
    protocol: "openid-connect", publicClient: true, standardFlowEnabled: true, implicitFlowEnabled: false,
    directAccessGrantsEnabled: false, serviceAccountsEnabled: false, consentRequired: false,
    frontchannelLogout: false, redirectUris: [e.U], webOrigins: [e.O],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "",
                  "oauth2.device.authorization.grant.enabled": "false", "oidc.ciba.grant.enabled": "false" } })' \
  > "$WORK/console-client.json"
kc_call GET "/$REALM/clients" -G --data-urlencode "clientId=$CONSOLE_CLIENT_ID"
[[ $KC_STATUS == 200 ]] || die "console client lookup failed ($KC_STATUS)"
console_uuid=$(js 'd.length ? d[0].id : ""' < "$WORK/body")
if [[ -z $console_uuid ]]; then
  kc_call POST "/$REALM/clients" --data-binary @"$WORK/console-client.json"
  [[ $KC_STATUS == 201 ]] || die "could not create the console client ($KC_STATUS): $(<"$WORK/body")"
  ok "client '$CONSOLE_CLIENT_ID' created"
else
  kc_call PUT "/$REALM/clients/$console_uuid" --data-binary @"$WORK/console-client.json"
  [[ $KC_STATUS == 204 ]] || die "could not update the console client ($KC_STATUS): $(<"$WORK/body")"
  ok "client '$CONSOLE_CLIENT_ID' checked"
fi
ok "support console client: PKCE (S256) only, redirect $CONSOLE_REDIRECT only, browser origin $CONSOLE_ORIGIN only"

if [[ -n $EMAIL ]]; then
  create_user "$EMAIL"
  if [[ $USER_RESULT == created ]]; then
    ok "account $EMAIL created (temporary password at the end)"
  else
    ok "account $EMAIL exists (new temporary password: bash $SELF reset-password $EMAIL)"
  fi
fi

# ----------------------------------------------------------------------------- connect the API
step "Connect the API"
key=""
if [[ -f $OIDC_ENV ]]; then key=$(sed -nE "s/^SESSION_SIGNING_KEY='(.*)'$/\1/p" "$OIDC_ENV"); fi
if [[ -z $key ]]; then
  key=$("$NODE" -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign'])
    .then(k=>crypto.subtle.exportKey('jwk',k.privateKey))
    .then(j=>process.stdout.write(JSON.stringify({kty:j.kty,crv:j.crv,x:j.x,y:j.y,d:j.d,kid:'pb-session-1'})))")
fi
[[ $key =~ ^\{\"kty\":\"EC\".*\"d\":\" ]] || die "could not create or read the session signing key in $OIDC_ENV"
env_text=$(cat <<EOF
# Generated by scripts/deploy/keycloak-setup.sh; read by pb-api through $DROPIN.
# vps-setup.sh does not touch this file. The session-signing key is kept across runs, so restarts keep sessions.
OIDC_ISSUER=$ISSUER
OIDC_CLIENT_ID=$CLIENT_ID
OIDC_CONSOLE_CLIENT_ID=$CONSOLE_CLIENT_ID
SESSION_SIGNING_KEY='$key'
EOF
)
API_CHANGED=0
if [[ ! -f $OIDC_ENV || "$(<"$OIDC_ENV")" != "$env_text" ]]; then
  (umask 077; printf '%s\n' "$env_text" > "$OIDC_ENV")
  API_CHANGED=1
fi
chown root:root "$OIDC_ENV"; chmod 600 "$OIDC_ENV"
dropin_text=$(cat <<EOF
# Generated by scripts/deploy/keycloak-setup.sh: sign-in through the local Keycloak.
[Unit]
Wants=keycloak.service
After=keycloak.service

[Service]
EnvironmentFile=$OIDC_ENV
EOF
)
install -d -m 755 "$(dirname "$DROPIN")"
if [[ ! -f $DROPIN || "$(<"$DROPIN")" != "$dropin_text" ]]; then
  printf '%s\n' "$dropin_text" > "$DROPIN"
  API_CHANGED=1
fi
systemctl daemon-reload
api=http://127.0.0.1:$API_PORT/v1
current=$(curl -fsS "$api/auth/config" 2>/dev/null | js 'd.issuer' 2>/dev/null || true)
if (( API_CHANGED )) || [[ $current != "$ISSUER" ]]; then
  systemctl restart pb-api
  ok "pb-api restarted with the sign-in settings"
fi
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$api/health" 2>/dev/null && break; sleep 1; done
cfg=$(curl -fsS "$api/auth/config") || { journalctl -u pb-api -n 30 --no-pager; die "the API does not answer on $api"; }
[[ $(js 'd.issuer' <<<"$cfg") == "$ISSUER" && $(js 'd.client_id' <<<"$cfg") == "$CLIENT_ID" ]] \
  || die "the API reports another sign-in configuration: $cfg"
ok "the API offers sign-in through $ISSUER ($OIDC_ENV, root only)"
ccfg=$(curl -fsS "$api/support/auth/config") || die "the API does not offer the support console sign-in ($api/support/auth/config)"
[[ $(js 'd.client_id' <<<"$ccfg") == "$CONSOLE_CLIENT_ID" ]] || die "the API reports another console client: $ccfg"
ok "the support console signs in with '$CONSOLE_CLIENT_ID' ($CONSOLE_REDIRECT)"

# ----------------------------------------------------------------------------- checks
step "Checks"
disc=$(curl -fsS "$ISSUER/.well-known/openid-configuration") || die "no OpenID configuration at $ISSUER"
[[ $(js 'd.issuer' <<<"$disc") == "$ISSUER" ]] || die "the provider names another issuer than $ISSUER"
js 'd.code_challenge_methods_supported.includes("S256") || undefined' <<<"$disc" >/dev/null || die "the provider does not offer PKCE S256"
ok "discovery: issuer $ISSUER, PKCE S256"
auth_try() {  # query -> "<HTTP status> <Location>"
  local status
  status=$(curl -sS -o /dev/null -D "$WORK/headers" -w '%{http_code}' "$ISSUER/protocol/openid-connect/auth?$1")
  printf '%s %s' "$status" "$(sed -n 's/^[Ll]ocation: *//p' "$WORK/headers" | tr -d '\r')"
}
q="response_type=code&client_id=$CLIENT_ID&scope=openid&state=check&nonce=check"
cb=projectbrowser%3A%2F%2Fauth%2Fcallback
pkce="code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
read -r code _ <<<"$(auth_try "$q&redirect_uri=$cb&$pkce")"
[[ $code == 200 ]] || die "the sign-in page does not open (HTTP $code)"
read -r code loc <<<"$(auth_try "$q&redirect_uri=$cb")"
[[ ($code == 302 && ${loc:-} == *error=invalid_request*) || $code == 400 ]] || die "Keycloak accepts a sign-in without PKCE (HTTP $code)"
read -r code _ <<<"$(auth_try "$q&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback&$pkce")"
[[ $code == 400 ]] || die "Keycloak accepts an unregistered redirect address (HTTP $code)"
ok "the sign-in page opens; requests without PKCE or with another redirect address are refused"
cq="response_type=code&client_id=$CONSOLE_CLIENT_ID&scope=openid&state=check&nonce=check&max_age=600"
console_cb=$("$NODE" -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$CONSOLE_REDIRECT")
read -r code _ <<<"$(auth_try "$cq&redirect_uri=$console_cb&$pkce")"
[[ $code == 200 ]] || die "the support console sign-in page does not open (HTTP $code)"
read -r code _ <<<"$(auth_try "$cq&redirect_uri=$cb&$pkce")"
[[ $code == 400 ]] || die "the console client accepts the desktop's redirect address (HTTP $code)"
ok "the console sign-in page opens; the console client refuses other redirect addresses"
pids=$(pgrep -d'|' -u "$KC_USER" || true)
[[ -n $pids ]] || die "no Keycloak process is running"
listening=$(ss -ltnpH | { grep -E "pid=($pids)," || true; } | awk '{print $4}' | sort -u | tr '\n' ' ')
[[ -n $listening ]] || die "cannot see Keycloak's listening sockets"
public=$(tr ' ' '\n' <<<"$listening" | { grep -vE '^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):' || true; } | { grep . || true; })
[[ -z $public ]] || die "Keycloak listens on a public address: $public"
ok "Keycloak listens on ${listening% } only (not reachable from the internet)"
rss=$(ps -o rss= -u "$KC_USER" | awk '{s+=$1} END {print int(s/1024)}')
ok "Keycloak uses about $rss MB of memory now"

# ----------------------------------------------------------------------------- summary
step "Done"
cat <<EOF
    Keycloak:  $KC_HOME   |   systemctl status keycloak   |   logs: journalctl -u keycloak -f
    Sign-in:   $ISSUER (client $CLIENT_ID; support console: $CONSOLE_CLIENT_ID)
    Console:   $CONSOLE_REDIRECT through the tunnel. Staff roles (the person signs in once first, e.g. on the console):
               runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/staff.ts add you@example.com --roles support_lead,billing_admin"
    Admin:     http://127.0.0.1:$KC_PORT/admin/ (through the tunnel), user '$KC_ADMIN_USER', password: cat $ADMIN_FILE
    Accounts:  bash $SELF add-user someone@example.com
               bash $SELF reset-password someone@example.com
    Update:    \\cp -f /home/pb/antibrowser/scripts/deploy/keycloak-setup.sh /root/ && bash /root/keycloak-setup.sh
               (after vps-setup.sh; keeps accounts, passwords and the signing key)

    On your computer, open the tunnel for BOTH ports and keep that window open while you use Project Browser:
      ssh -N -L $API_PORT:127.0.0.1:$API_PORT -L $KC_PORT:127.0.0.1:$KC_PORT root@<this-server>
    In Project Browser: Account -> Organization server -> http://127.0.0.1:$API_PORT -> Save -> Sign in or create an account
EOF
if [[ -n $ACCOUNT_TEXT ]]; then
  printf '%s\n' "$ACCOUNT_TEXT"
elif [[ -z $EMAIL ]]; then
  kc_call GET "/$REALM/users/count"
  echo
  if [[ $KC_STATUS == 200 && $(<"$WORK/body") =~ ^[1-9][0-9]*$ ]]; then
    ok "accounts in the realm: $(<"$WORK/body") (more: bash $SELF add-user someone@example.com)"
  else
    warn "there is no account yet. Create yours: bash $SELF add-user you@example.com"
  fi
fi
