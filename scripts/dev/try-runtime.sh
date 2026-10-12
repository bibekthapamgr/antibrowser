#!/usr/bin/env bash
# Try milestone 03 on your own Mac (Apple Silicon) or Linux machine before a signed runtime manifest exists.
#
# Downloads the Chrome for Testing build the pipeline tested (checked against its pinned SHA-256), then either
#   - opens the manager as a debug build that uses it (default), or
#   - runs the five real-browser tests (--tests).
#
# Usage (from the repository root):
#   scripts/dev/try-runtime.sh            # open the manager
#   scripts/dev/try-runtime.sh --tests    # run the isolation / crash / double-launch / ten-cycle tests
#
# Needs: Node 24, pnpm, Rust (rustup), curl. Release builds never use this path; they only run the runtime from the
# signed manifest (docs/runtime-pipeline.md).
set -euo pipefail

VERSION=155.0.8059.39
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    PLATFORM=mac-arm64
    SHA256=529a71bd61aaa2ef266a4d4bd300ae9572ba6a3468a8d55c3023ffeffb5b6b4e
    EXE="chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    ;;
  Linux-x86_64)
    PLATFORM=linux64
    SHA256=55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea
    EXE="chrome-linux64/chrome"
    ;;
  *)
    echo "This helper supports macOS on Apple Silicon and Linux x64 only (found $(uname -s) $(uname -m))." >&2
    exit 1
    ;;
esac

mode="${1:-app}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cache="${PB_RUNTIME_CACHE:-$HOME/.cache/project-browser/cft-$VERSION-$PLATFORM}"
browser="$cache/$EXE"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }
}
need curl "Install curl."
need node "Install Node.js 24 (https://nodejs.org)."
need pnpm "Run: corepack enable  (or npm install -g pnpm@10)"
need cargo "Install Rust: https://rustup.rs"
if ! node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"; then
  echo "The Node.js at $(command -v node) cannot run on this computer (for example an Intel build on Apple Silicon" >&2
  echo "without Rosetta). Install Node.js 24 for this machine from https://nodejs.org and put it first in PATH." >&2
  exit 1
fi
if [ "$node_major" != "24" ]; then
  echo "Warning: Node $node_major found; the project is tested with Node 24." >&2
fi
if [ "$(id -u)" = "0" ]; then
  echo "Run this as your normal user, not root: Chromium's sandbox stays on and refuses to run as root." >&2
  exit 1
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

if [ ! -x "$browser" ]; then
  echo "Downloading Chrome for Testing $VERSION ($PLATFORM)..."
  mkdir -p "$cache"
  zip="$cache/download.zip"
  curl -fL --retry 3 -o "$zip" \
    "https://storage.googleapis.com/chrome-for-testing-public/$VERSION/$PLATFORM/chrome-$PLATFORM.zip"
  got="$(sha256_of "$zip")"
  if [ "$got" != "$SHA256" ]; then
    rm -f "$zip"
    echo "SHA-256 mismatch (expected $SHA256, got $got). Not using this download." >&2
    exit 1
  fi
  if [ "$PLATFORM" = mac-arm64 ]; then
    ditto -x -k "$zip" "$cache"     # keeps the app bundle's symbolic links and permissions
  else
    need unzip "Install unzip."
    unzip -q -o "$zip" -d "$cache"
  fi
  rm -f "$zip"
  [ -x "$browser" ] || { echo "The browser was not found after extraction: $browser" >&2; exit 1; }
fi
echo "Browser: $browser"

cd "$repo"
pnpm install --frozen-lockfile

if [ "$mode" = "--tests" ]; then
  # The desktop crate embeds the built UI, so build it first.
  pnpm --filter @pb/desktop build
  PB_TEST_BROWSER="$browser" PB_TEST_BROWSER_VERSION="$VERSION" PB_TEST_BROWSER_REQUIRED=1 \
    cargo test -p pb-desktop --test browser -- --test-threads=1
else
  cd apps/desktop
  PB_DEV_BROWSER="$browser" PB_DEV_BROWSER_VERSION="$VERSION" pnpm tauri dev
fi
