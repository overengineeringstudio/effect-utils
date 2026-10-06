#!/usr/bin/env bash
set -euo pipefail

output="${CI_BUCK2_CACHE_EVIDENCE_PATH:?cache evidence output not declared}"
projector="$PWD/genie/ci-scripts/buck2-cache-evidence.ts"
if [ "${CI_BUCK2_CACHE_EVIDENCE_DISABLED:-0}" = 1 ]; then
  bun "$projector" --output "$output" --remote-cache-disabled-by-design
  exit 0
fi
bun "$projector" --output "$output"
marker="${CI_BUCK2_CACHE_EVIDENCE_START:?cache evidence start not declared}"
events=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/buck2-cache-events.XXXXXXXX")
trap 'rm -f "$events"' EXIT
for directory in .devenv/otel buck-out/v2/log; do
  [ -d "$directory" ] || continue
  while IFS= read -r -d '' log; do
    buck2 log show "$log" > "$events"
    bun "$projector" --events "$events" --output "$output" --context native-log
  done < <(find "$directory" -type f -name '*.pb.zst' -newer "$marker" -print0)
done
