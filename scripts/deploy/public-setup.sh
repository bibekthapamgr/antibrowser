#!/usr/bin/env bash
# Project Browser — public addresses with valid TLS for a staging or production server (R6, ADR-0025).
#
# vps-setup.sh runs it for PB_ENV=staging|prod (run it alone to repair or renew the setup). It:
#   1. reads your public addresses from /etc/project-browser/public.env (parsed, never executed) and checks that
#      each one's DNS points at this server;
#   2. installs Caddy (official release, version and SHA-256 pinned below) as the reverse proxy `pb-proxy`, running as
#      its own user with only the right to use ports 80 and 443. It obtains and renews the certificates itself
#      (Let's Encrypt / ZeroSSL), redirects http to https and sends HSTS;
#   3. routes only what is meant to be public:
#        SITE_HOST   website, customer portal (/app/), API (/v1/); never the staff console or staff API
#        ADMIN_HOST  staff console (/console/) and the staff API (/v1/support/, /v1/admin/) only
#        ID_HOST     sign-in (Keycloak realms); its administration (/admin) and the master realm are refused
#        FILES_HOST  the snapshot bucket of this environment only (presigned links; no bucket listing)
#      PostgreSQL, the storage's own ports, Keycloak's port, the API port and metrics stay on 127.0.0.1. No access
#      log is written (request addresses carry one-time codes and signed links);
#   4. opens ports 80 and 443 in the firewall (firewalld or ufw, when one is active). Nothing else is opened and no
#      existing rule is changed.
# Usage (as root): bash public-setup.sh
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR
cd /

CADDY_VERSION=2.11.4
ENV_DIR=/etc/project-browser
PUBLIC_ENV=$ENV_DIR/public.env
ENV_MARK=$ENV_DIR/environment
PROXY_USER=pb-proxy
PROXY_DATA=/var/lib/pb-proxy
PROXY_CONF=/etc/pb-proxy/Caddyfile
PUBLIC_CA=$ENV_DIR/public-ca.pem   # only with TLS_MODE=internal (tests): the private authority's root
API_PORT="${PB_API_PORT:-8080}"
KC_PORT="${PB_KC_PORT:-8081}"
S3_PORT=8333

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }

step "Public addresses"
[[ $EUID -eq 0 ]] || die "run as root"
[[ -f $PUBLIC_ENV ]] || die "$PUBLIC_ENV is missing (vps-setup.sh with PB_ENV=staging or prod creates it)"
PB_ENV=$(sed -n 's/^PB_ENV=//p' "$ENV_MARK" 2>/dev/null || true)
[[ $PB_ENV == staging || $PB_ENV == prod ]] || die "this server is not a staging or production server ($ENV_MARK)"
SITE_HOST="" ADMIN_HOST="" ID_HOST="" FILES_HOST="" ACME_EMAIL="" TLS_MODE=public
while IFS='=' read -r key value; do
  [[ $key =~ ^(SITE_HOST|ADMIN_HOST|ID_HOST|FILES_HOST|ACME_EMAIL|TLS_MODE)$ ]] || continue
  value=${value%$'\r'}; value=${value#\"}; value=${value%\"}; value=${value#\'}; value=${value%\'}
  printf -v "$key" '%s' "${value// /}"
done < "$PUBLIC_ENV"
host_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
for k in SITE_HOST ADMIN_HOST ID_HOST FILES_HOST; do
  v=${!k,,}; printf -v "$k" '%s' "$v"
  [[ $v =~ $host_re ]] || die "$PUBLIC_ENV: $k must be a domain name such as browser.example.com (got '${!k}')"
done
[[ $ACME_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || die "$PUBLIC_ENV: ACME_EMAIL must be your e-mail address"
[[ $TLS_MODE == public || $TLS_MODE == internal ]] || die "$PUBLIC_ENV: TLS_MODE must be public or internal"
dupes=$(printf '%s\n' "$SITE_HOST" "$ADMIN_HOST" "$ID_HOST" "$FILES_HOST" | sort | uniq -d)
[[ -z $dupes ]] || die "$PUBLIC_ENV: every address must be different ($dupes is used twice)"
[[ $TLS_MODE == internal ]] && warn "TLS_MODE=internal: private certificates, for automated tests only (preflight fails it)"

# DNS: each name must lead to this server (a certificate cannot be issued otherwise).
mine=" $(hostname -I 2>/dev/null) 127.0.0.1 ::1 "
for k in SITE_HOST ADMIN_HOST ID_HOST FILES_HOST; do
  addrs=$(getent ahosts "${!k}" | awk '{print $1}' | sort -u | tr '\n' ' ')
  [[ -n $addrs ]] || die "${!k} ($k) does not resolve yet: add its DNS record (pointing at this server) and wait a few minutes"
  hit=0
  for a in $addrs; do [[ $mine == *" $a "* ]] && hit=1; done
  if (( ! hit )); then
    if [[ ${PB_DNS_BEHIND_NAT:-} == 1 ]]; then
      warn "${!k} points at $addrs, not an address of this server (allowed: PB_DNS_BEHIND_NAT=1)"
    else
      die "${!k} ($k) points at $addrs, which is not this server ($(hostname -I | xargs)).
         Fix the DNS record, or, if this server sits behind a NAT/load balancer that forwards 80 and 443 here,
         run again with PB_DNS_BEHIND_NAT=1"
    fi
  fi
done
ok "site $SITE_HOST, staff $ADMIN_HOST, sign-in $ID_HOST, files $FILES_HOST ($PB_ENV)"

step "Reverse proxy (Caddy $CADDY_VERSION)"
case "$(uname -m)" in
  # SHA-256 of caddy_2.11.4_linux_<arch>.tar.gz (github.com/caddyserver/caddy releases; their SHA-512 list agrees)
  x86_64)  CADDY_ASSET=linux_amd64; CADDY_SHA256=527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9 ;;
  aarch64) CADDY_ASSET=linux_arm64; CADDY_SHA256=52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904 ;;
  *) die "unsupported CPU architecture $(uname -m)" ;;
esac
CADDY_DIR=/opt/caddy/$CADDY_VERSION
if [[ ! -x $CADDY_DIR/caddy ]]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/caddy.tgz" \
    "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_${CADDY_ASSET}.tar.gz"
  echo "$CADDY_SHA256  $tmp/caddy.tgz" | sha256sum -c --quiet - || die "the Caddy download does not match its pinned SHA-256"
  install -d -m 755 "$CADDY_DIR"
  tar -xzf "$tmp/caddy.tgz" -C "$CADDY_DIR" caddy
  chown root:root "$CADDY_DIR/caddy"; chmod 755 "$CADDY_DIR/caddy"
  rm -rf "$tmp"
fi
ln -sfn "$CADDY_DIR" /opt/caddy/current
ok "Caddy $("$CADDY_DIR/caddy" version | awk '{print $1}') ($CADDY_ASSET, SHA-256 verified)"
id "$PROXY_USER" >/dev/null 2>&1 \
  || useradd --system --home-dir "$PROXY_DATA" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$PROXY_USER"
install -d -m 700 -o "$PROXY_USER" -g "$PROXY_USER" "$PROXY_DATA"
install -d -m 755 -o root -g root /etc/pb-proxy

BUCKET=pb-snapshots-$PB_ENV
tls_line=""
[[ $TLS_MODE == internal ]] && tls_line="local_certs
	skip_install_trust"
cat > "$PROXY_CONF.new" <<EOF
# Generated by scripts/deploy/public-setup.sh from $PUBLIC_ENV. Re-run the script instead of editing.
{
	email $ACME_EMAIL
	admin off
	storage file_system $PROXY_DATA
	$tls_line
	servers {
		protocols h1 h2
	}
}

(hardening) {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		-Server
		-Via
	}
}

# Website, customer portal and the API the desktop app uses. Never the staff console or the staff API.
$SITE_HOST {
	import hardening
	@staff path /console /console/* /v1/support /v1/support/* /v1/admin /v1/admin/*
	respond @staff 404
	reverse_proxy 127.0.0.1:$API_PORT
}

# Staff console and staff API only.
$ADMIN_HOST {
	import hardening
	@staff path /console /console/* /v1/support/* /v1/admin/* /v1/health /v1/ready
	handle @staff {
		reverse_proxy 127.0.0.1:$API_PORT
	}
	handle / {
		redir * /console/ 302
	}
	handle {
		respond 404
	}
}

# Sign-in. Keycloak's administration and the master realm are never public (SSH tunnel to 127.0.0.1:$KC_PORT).
$ID_HOST {
	import hardening
	@private path /admin /admin/* /realms/master /realms/master/* /metrics /metrics/* /health /health/*
	respond @private 404
	reverse_proxy 127.0.0.1:$KC_PORT
}

# Snapshot storage: this environment's bucket only (path-style presigned links). No listing of buckets.
$FILES_HOST {
	import hardening
	@bucket path /$BUCKET/*
	handle @bucket {
		reverse_proxy 127.0.0.1:$S3_PORT
	}
	handle {
		respond 404
	}
}
EOF
"$CADDY_DIR/caddy" validate --config "$PROXY_CONF.new" --adapter caddyfile >/dev/null 2>"$PROXY_DATA.validate.log" \
  || { cat "$PROXY_DATA.validate.log" >&2; rm -f "$PROXY_CONF.new"; die "the generated proxy configuration is not valid"; }
rm -f "$PROXY_DATA.validate.log"
CHANGED=0
if [[ ! -f $PROXY_CONF ]] || ! cmp -s "$PROXY_CONF.new" "$PROXY_CONF"; then
  mv -f "$PROXY_CONF.new" "$PROXY_CONF"; CHANGED=1
else
  rm -f "$PROXY_CONF.new"
fi
chown root:"$PROXY_USER" "$PROXY_CONF"; chmod 640 "$PROXY_CONF"
cat > /etc/systemd/system/pb-proxy.service.new <<UNIT
[Unit]
Description=Project Browser public TLS reverse proxy (Caddy; ports 80 and 443)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=$PROXY_USER
Group=$PROXY_USER
Environment=HOME=$PROXY_DATA XDG_DATA_HOME=$PROXY_DATA XDG_CONFIG_HOME=$PROXY_DATA
ExecStart=/opt/caddy/current/caddy run --environ=false --config $PROXY_CONF --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=65536
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=$PROXY_DATA
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
if ! cmp -s /etc/systemd/system/pb-proxy.service.new /etc/systemd/system/pb-proxy.service 2>/dev/null; then
  mv -f /etc/systemd/system/pb-proxy.service.new /etc/systemd/system/pb-proxy.service; CHANGED=1
else
  rm -f /etc/systemd/system/pb-proxy.service.new
fi
if ! systemctl is-active --quiet pb-proxy; then
  for port in 80 443; do
    if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      die "port $port is already used by another program on this server (a web server?). Stop it first, then re-run."
    fi
  done
fi
systemctl daemon-reload
systemctl enable -q pb-proxy
if (( CHANGED )) || ! systemctl is-active --quiet pb-proxy; then systemctl restart pb-proxy; fi
ok "pb-proxy running (configuration $PROXY_CONF, certificates in $PROXY_DATA)"

step "Firewall: ports 80 and 443"
if systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd -q --permanent --add-service=http --add-service=https
  firewall-cmd -q --reload
  ok "firewalld: http and https allowed (nothing else changed)"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ok "ufw: 80/tcp and 443/tcp allowed (nothing else changed)"
else
  ok "no active firewall (firewalld/ufw); the services other than the proxy listen on 127.0.0.1 only"
fi

step "Certificates"
CURL_CA=()
if [[ $TLS_MODE == internal ]]; then
  root=$PROXY_DATA/pki/authorities/local/root.crt
  for _ in $(seq 1 30); do [[ -s $root ]] && break; sleep 1; done
  [[ -s $root ]] || die "the private certificate authority was not created ($root)"
  install -m 644 -o root -g root "$root" "$PUBLIC_CA"
  CURL_CA=(--cacert "$PUBLIC_CA")
else
  rm -f "$PUBLIC_CA"
fi
# The API (as a client of the sign-in provider) trusts the private authority only in TLS_MODE=internal.
DROPIN=/etc/systemd/system/pb-api.service.d/public-ca.conf
if [[ $TLS_MODE == internal ]]; then
  install -d -m 755 "$(dirname "$DROPIN")"
  printf '# Generated by public-setup.sh: TLS_MODE=internal (tests only).\n[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=%s\n' "$PUBLIC_CA" > "$DROPIN"
else
  rm -f "$DROPIN"
fi
systemctl daemon-reload
for k in SITE_HOST ADMIN_HOST ID_HOST FILES_HOST; do
  got=0
  for _ in $(seq 1 90); do
    # Any HTTP answer over a verified TLS connection is enough here (the services may not be running yet).
    if curl -sS -o /dev/null "${CURL_CA[@]}" --max-time 10 --resolve "${!k}:443:127.0.0.1" "https://${!k}/" 2>/dev/null; then
      got=1; break
    fi
    sleep 2
  done
  (( got )) || { journalctl -u pb-proxy -n 30 --no-pager; die "no valid certificate for ${!k} yet (the lines above say why;
         usually DNS not pointing here yet, or ports 80/443 blocked by the hosting provider's firewall)"; }
  ok "https://${!k}/ has a valid certificate"
done
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$SITE_HOST:80:127.0.0.1" "http://$SITE_HOST/")
[[ $code == 301 || $code == 302 || $code == 308 ]] && ok "http redirects to https ($code)" || die "http://$SITE_HOST/ does not redirect to https (HTTP $code)"
