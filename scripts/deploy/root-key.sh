#!/usr/bin/env bash
# Project Browser — the test server's root key for organization backups (milestone 07).
#
# Each organization's backup key versions are wrapped by a root key kept in KMS_LOCAL_KEY_FILE
# (/etc/project-browser/kms-root.json, created once by vps-setup.sh, readable by the pb user only). Without that file
# nothing in backup storage can be decrypted, by anyone. Keep an offline copy (see `backup-hint`).
#
#   status            the root keys, which one is active, and how many organization key versions each one wraps
#   rotate            adds a new random root key and makes it active; the worker re-wraps every organization key
#                     version with it within about a minute. The old key stays in the file until `retire`.
#   retire <key-id>   removes an old root key once nothing is wrapped by it any more (refused otherwise)
#   backup-hint       how to copy the key file to your computer and keep it offline
#
# Usage (as root): bash root-key.sh status | rotate | retire <key-id> | backup-hint
set -Eeuo pipefail
trap 'echo "ERROR: line $LINENO failed: $BASH_COMMAND" >&2' ERR

KMS_FILE="${PB_KMS_FILE:-/etc/project-browser/kms-root.json}"
NODE="${PB_NODE:-/opt/node/bin/node}"
DB="${PB_DB:-pb_dev}"
RESTART="${PB_RESTART:-1}"
[[ -x $NODE ]] || NODE=$(command -v node || true)

ok()  { printf '    \033[32mok\033[0m  %s\n' "$*"; }
die() { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n $NODE ]] || die "Node.js not found (run vps-setup.sh first)"
[[ -s $KMS_FILE ]] || die "$KMS_FILE does not exist (run vps-setup.sh first)"
[[ $(stat -c '%a' "$KMS_FILE") == 600 ]] || die "$KMS_FILE must be mode 600 (it is $(stat -c '%a' "$KMS_FILE"))"

# Organization key versions per root key id, from the database ("id<TAB>count" lines); empty when unavailable.
wrapped_counts() {
  if [[ ${PB_SKIP_DB:-0} == 1 ]] || ! id postgres >/dev/null 2>&1; then
    return 0
  fi
  (cd /tmp && runuser -u postgres -- psql -d "$DB" -At -F $'\t' -c \
    "select kms_key_id, count(*) from app.organization_key_versions where status <> 'destroyed' group by 1" \
    2>/dev/null) || true
}

restart_services() {
  [[ $RESTART == 1 ]] || return 0
  systemctl restart pb-api pb-worker
  ok "pb-api and pb-worker restarted with the new key file"
}

# Rewrites the key file atomically (same owner, mode 600) from the JSON on stdin.
replace_file() {
  local tmp
  tmp=$(mktemp "$KMS_FILE.XXXXXX")
  chmod 600 "$tmp"
  cat > "$tmp"
  chown --reference="$KMS_FILE" "$tmp"
  mv -f "$tmp" "$KMS_FILE"
}

cmd="${1:-status}"
case "$cmd" in
  status)
    counts=$(wrapped_counts)
    "$NODE" -e '
      const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const counts = new Map((process.argv[2] || "").split("\n").filter(Boolean).map((l) => l.split("\t")));
      for (const id of Object.keys(f.keys)) {
        const n = counts.has(id) ? `${counts.get(id)} organization key version(s)` : "nothing (or the database was not checked)";
        console.log(`    ${id === f.active ? "active " : "old    "} ${id}  wraps ${n}`);
      }' "$KMS_FILE" "$counts"
    ;;
  rotate)
    new_id="root-$(date -u +%Y%m%d%H%M%S)"
    "$NODE" -e '
      const crypto = require("crypto");
      const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (f.keys[process.argv[2]]) { console.error("that key id exists already"); process.exit(1); }
      f.keys[process.argv[2]] = crypto.randomBytes(32).toString("base64");
      f.active = process.argv[2];
      process.stdout.write(JSON.stringify(f) + "\n");' "$KMS_FILE" "$new_id" | replace_file
    ok "new root key $new_id is active; the old key(s) stay until you retire them"
    restart_services
    echo "    The worker re-wraps every organization key version within about a minute."
    echo "    Then:  bash $(readlink -f "$0") status   (old keys should wrap nothing), and back up the file again."
    ;;
  retire)
    id="${2:-}"
    [[ $id =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "usage: root-key.sh retire <key-id>"
    still=$(wrapped_counts | awk -F'\t' -v id="$id" '$1 == id { print $2 }')
    [[ -z $still || $still == 0 ]] || die "$id still wraps $still organization key version(s); wait for the worker, then retry"
    [[ ${PB_SKIP_DB:-0} == 1 ]] || id postgres >/dev/null 2>&1 || die "cannot check the database; refusing to remove a key"
    "$NODE" -e '
      const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const id = process.argv[2];
      if (!f.keys[id]) { console.error("no such key"); process.exit(1); }
      if (f.active === id) { console.error("the active key cannot be retired; rotate first"); process.exit(1); }
      delete f.keys[id];
      process.stdout.write(JSON.stringify(f) + "\n");' "$KMS_FILE" "$id" | replace_file
    ok "root key $id removed from $KMS_FILE"
    restart_services
    ;;
  backup-hint)
    cat <<EOF
    The root key file is the one thing that can decrypt every organization backup on this server.
    Copy it to your computer (run on your computer, not here):
      scp root@<this-server>:$KMS_FILE ./project-browser-root-key.json
    Keep that copy offline (an encrypted USB drive or a password manager's secure file), never in Git or e-mail.
    To recover after losing the server: install again with vps-setup.sh, then before starting the API put the file
    back at $KMS_FILE (owner pb, chmod 600) and restore the database; storage must be restored too.
EOF
    ;;
  *)
    die "usage: root-key.sh status | rotate | retire <key-id> | backup-hint"
    ;;
esac
