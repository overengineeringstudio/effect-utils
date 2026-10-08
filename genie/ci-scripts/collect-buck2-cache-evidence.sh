#!/usr/bin/env bash
# Every collection failure leaves an explicit gap; later logs and finalization still run.
set -uo pipefail

output="${CI_BUCK2_CACHE_EVIDENCE_PATH:?cache evidence output not declared}"
actions="${CI_BUCK2_CACHE_ACTIONS_PATH:?cache actions output not declared}"
projector="$PWD/genie/ci-scripts/buck2-cache-evidence.ts"
args=(--output "$output" --actions-output "$actions")
if [ "${CI_BUCK2_CACHE_EVIDENCE_DISABLED:-0}" = 1 ]; then
  args+=(--remote-cache-disabled-by-design)
fi
failed=0
last_gap=""
record_gap() {
  failed=1
  last_gap="$1"
  printf 'Cache evidence collection gap: %s\n' "$1" >&2
  if ! bun "$projector" "${args[@]}" --evidence-gap "$1" 2>/dev/null; then
    printf 'Cache evidence gap could not be persisted.\n' >&2
  fi
}

marker="${CI_BUCK2_CACHE_EVIDENCE_START:-}"
started_at=""
recorded_root=""
fresh_root=0
window_valid=0
if [ -n "$marker" ] && [ -f "$marker" ]; then
  if { IFS= read -r started_at && IFS= read -r recorded_root && IFS= read -r fresh_root; } < "$marker" &&
     [[ "$started_at" =~ ^[0-9]+$ ]] && [[ "$fresh_root" =~ ^[01]$ ]]; then
    window_valid=1
    export CI_BUCK2_CACHE_EVIDENCE_STARTED_AT="$started_at"
  fi
fi
if [ "$window_valid" = 0 ]; then
  unset CI_BUCK2_CACHE_EVIDENCE_STARTED_AT
fi
# Initializing preserves explicitly collected proof invocations and their first build IDs.
if ! bun "$projector" "${args[@]}" 2>/dev/null; then
  record_gap evidence-initialization-failed
fi
if [ "$window_valid" = 0 ]; then
  record_gap start-window-missing
fi

# A later CI_SOURCE_ROOT redirect or a different canonical root cannot inherit freshness.
# Every native log is a candidate fresh invocation; the projector picks the earliest
# native CommandStart at --finalize and marks later invocations freshRoot=false.
fresh_args=()
if [ "$window_valid" = 1 ] && [ "$fresh_root" = 1 ] && [ "$recorded_root" = "$(pwd -P)" ]; then
  fresh_args=(--fresh-root)
fi

events=""
logs=""
trap 'rm -f "$events" "$logs"' EXIT
if [ "${CI_BUCK2_CACHE_EVIDENCE_DISABLED:-0}" != 1 ] && [ "$window_valid" = 1 ]; then
  if events=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/buck2-cache-events.XXXXXXXX") &&
     logs=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/buck2-cache-logs.XXXXXXXX"); then
    : > "$logs"
    for directory in .devenv/otel buck-out/v2/log; do
      [ -d "$directory" ] || continue
      # Materialize the discovery result so find failures cannot disappear in process substitution.
      if ! find "$directory" -type f -name '*.pb.zst' -newer "$marker" -print0 >> "$logs" 2>/dev/null; then
        record_gap native-log-discovery-failed
      fi
    done
    # Discovery order is arbitrary and mtime cannot order concurrent builds; the earliest
    # native CommandStart wins freshness at finalize rather than file iteration order.
    while IFS= read -r -d '' log; do
      if ! buck2 log show "$log" > "$events" 2>/dev/null; then
        record_gap native-log-decode-failed
        continue
      fi
      if ! bun "$projector" "${args[@]}" --events "$events" --context native-log "${fresh_args[@]}" 2>/dev/null; then
        record_gap native-log-projection-failed
      fi
    done < "$logs"
  else
    record_gap native-log-discovery-failed
  fi
fi

if finished_at=$(bun -e 'console.log(Date.now())' 2>/dev/null) && [[ "$finished_at" =~ ^[0-9]+$ ]]; then
  export CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT="$finished_at"
else
  unset CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT
  record_gap evidence-finalization-failed
fi
finalize_args=(--finalize)
if [ -n "$last_gap" ]; then
  finalize_args+=(--evidence-gap "$last_gap")
fi
if ! bun "$projector" "${args[@]}" "${finalize_args[@]}" 2>/dev/null; then
  record_gap evidence-finalization-failed
fi
exit "$failed"
