#!/usr/bin/env bash
# Runs a command, streams its output, and on failure re-emits the most useful lines as GitHub
# annotations (::error::). Annotations are visible on the run page and through the API, so failures
# can be diagnosed even where raw logs are not reachable.
# Usage: scripts/ci/annotate.sh "<title>" <command...>
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  sed -e 's/\x1b\[[0-9;]*m//g' "$log" \
    | grep -E "^error(\[E[0-9]+\])?:|panicked at|^---- .* stdout ----|^test .* FAILED|^failures:|assertion|error: could not|ERR_|Error:|  --> | FAIL |×" \
    | grep -v "^error: test failed" | head -40 > "$log.sel" || true
  # Group lines into at most 10 annotations (GitHub's per-step limit).
  split -l 4 -a 2 "$log.sel" "$log.part." 2>/dev/null || true
  n=0
  for part in "$log".part.*; do
    [ -f "$part" ] || continue
    n=$((n + 1)); [ "$n" -gt 10 ] && break
    msg=$(sed -e 's/%/%25/g' -e 's/\r//g' "$part" | awk '{printf "%s%%0A", $0}')
    echo "::error title=${title} (${n})::${msg}"
  done
  # Always show where the run stopped (a hang killed by a timeout leaves no failure lines).
  echo "::error title=${title} (last lines)::exit ${status}; $(sed -e 's/\x1b\[[0-9;]*m//g' "$log" | tail -8 | tr '\n' ' ' | cut -c1-1500)"
fi
exit "$status"
