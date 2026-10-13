#!/usr/bin/env bash
# Starts SeaweedFS (S3-compatible, Apache-2.0) on 127.0.0.1 for CI: the same pinned release the test-server script
# installs, checksum verified. S3 on 127.0.0.1:8333 with the repository's fixture credentials and the test buckets.
# Usage: scripts/ci/seaweedfs.sh [data-dir]
set -euo pipefail

VERSION=4.48
case "$(uname -m)" in
  x86_64) ASSET=linux_amd64.tar.gz; SHA256=4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124 ;;
  aarch64) ASSET=linux_arm64.tar.gz; SHA256=557e92c38c5c7d180748eb8e2b2b45e426f8e5282a4caca8e098a90d09f03a07 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
DATA=${1:-${RUNNER_TEMP:-/tmp}/seaweedfs}
BIN_DIR=${RUNNER_TEMP:-/tmp}/seaweedfs-bin
mkdir -p "$DATA" "$BIN_DIR"

curl -fsSL "https://github.com/seaweedfs/seaweedfs/releases/download/$VERSION/$ASSET" -o "$BIN_DIR/$ASSET"
echo "$SHA256  $BIN_DIR/$ASSET" | sha256sum -c --quiet -
tar -xzf "$BIN_DIR/$ASSET" -C "$BIN_DIR" weed

cat > "$DATA/s3.json" <<'EOF'
{"identities":[{"name":"pb","credentials":[{"accessKey":"pb-local","secretKey":"pb-local-fixture-secret-key"}],
  "actions":["Admin","Read","List","Tagging","Write"]}]}
EOF

nohup "$BIN_DIR/weed" server -dir="$DATA" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
  -master.port=9333 -master.volumeSizeLimitMB=256 -volume.port=8090 -volume.max=16 -filer.port=8888 \
  -s3 -s3.port=8333 -s3.config="$DATA/s3.json" > "$DATA/weed.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:8333/ && break
  sleep 1
done
curl -s -o /dev/null http://127.0.0.1:8333/ || { tail -40 "$DATA/weed.log"; exit 1; }

s3() {
  AWS_ACCESS_KEY_ID=pb-local AWS_SECRET_ACCESS_KEY=pb-local-fixture-secret-key \
    aws --endpoint-url http://127.0.0.1:8333 --region us-east-1 s3api "$@" >/dev/null 2>&1
}
for bucket in pb-snapshots-test pb-snapshots-dev; do
  for _ in $(seq 1 30); do
    s3 head-bucket --bucket "$bucket" && break
    s3 create-bucket --bucket "$bucket" || sleep 1
  done
  s3 head-bucket --bucket "$bucket" || { tail -40 "$DATA/weed.log"; echo "bucket $bucket missing" >&2; exit 1; }
done
echo "SeaweedFS $VERSION: S3 on http://127.0.0.1:8333"
