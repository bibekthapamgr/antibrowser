#!/usr/bin/env bash
# Installs Chrome for Testing's headless shell (stable) for the tests that drive a real browser and exports
# PB_CHROME_PATH. Retries: the download host occasionally fails a request, which used to fail whole CI jobs.
# Run from apps/desktop (where @puppeteer/browsers is a dev dependency).
set -euo pipefail
dest="${RUNNER_TEMP:-/tmp}/chrome"
for attempt in 1 2 3; do
  if out=$(pnpm exec browsers install chrome-headless-shell@stable --path "$dest" 2>&1); then
    path=$(echo "$out" | tail -1 | awk '{print $2}')
    if [ -x "$path" ]; then
      echo "$out" | tail -1
      [ -n "${GITHUB_ENV:-}" ] && echo "PB_CHROME_PATH=$path" >> "$GITHUB_ENV"
      exit 0
    fi
  fi
  echo "headless shell install attempt $attempt failed:" >&2
  echo "$out" | tail -5 >&2
  sleep $((attempt * 15))
done
echo "::error title=headless shell::could not install chrome-headless-shell@stable after 3 attempts"
exit 1
