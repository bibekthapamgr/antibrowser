#!/usr/bin/env bash
# Runs a command with a time limit on Linux, macOS and Windows (Git Bash). macOS has no `timeout`; Windows'
# timeout.exe is a different tool, so GNU timeout is detected by --version and perl's alarm is the fallback.
# Usage: scripts/ci/with-timeout.sh <seconds> <command...>
secs="$1"; shift
if timeout --version >/dev/null 2>&1; then
  exec timeout "$secs" "$@"
fi
exec perl -e 'alarm shift @ARGV; exec @ARGV or die "exec failed: $!"' "$secs" "$@"
