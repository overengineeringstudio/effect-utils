#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  elif [ -n "${DEVENV_BIN:-}" ]; then
    "$DEVENV_BIN" shell --no-reload -- bun "$@"
  else
    echo "bun is not available and DEVENV_BIN is not set" >&2
    return 127
  fi
}

emit_compare_script() {
  run_bun -e "import { compareCiMeasurementsStep } from './genie/ci-workflow/measurements.ts'; process.stdout.write(compareCiMeasurementsStep({ currentDir: '$tmp_dir/current', baselineDir: '$tmp_dir/baseline', outputFile: '$tmp_dir/comparison.json', regressionMode: 'warn' }).run)" >"$tmp_dir/compare.sh"
}

write_measurement() {
  local file="$1"
  local value="$2"
  local protocol="$3"
  local policy="$4"
  mkdir -p "$(dirname "$file")"
  jq -n \
    --argjson value "$value" \
    --arg protocol "$protocol" \
    --argjson policy "$policy" \
    '{
      schemaVersion: 1,
      generatedAt: "2026-05-14T00:00:00Z",
      producer: { name: "test", version: (if $protocol == "legacy" then 1 else 2 end) },
      target: { kind: "devenv", id: "dev-shell", name: "dev-shell", label: "Dev shell", group: "devenv", system: "Linux" },
      observations: [
        {
          id: "devenv.task.duration",
          label: "Task",
          group: "test",
          name: "devenv.task.duration",
          unit: "seconds",
          value: $value,
          policy: $policy,
          statistics: { sampleCount: 6, warmupCount: 1, measuredSampleCount: 5, successfulSampleCount: 5, min: $value, max: $value, median: $value },
          dimensions: (
            { probe: "task", probeLabel: "Task", status: 0, sampleCount: 6, warmupCount: 1, measuredSampleCount: 5 }
            + if $protocol == "legacy" then {} else { measurementProtocol: $protocol, aggregation: "median", phase: "warm" } end
          )
        }
      ]
    }' >"$file"
}

run_compare() {
  CI_MEASUREMENT_CURRENT_DIR="$tmp_dir/current" \
  CI_MEASUREMENT_BASELINE_DIR="$tmp_dir/baseline" \
  CI_MEASUREMENT_COMPARISON_FILE="$tmp_dir/comparison.json" \
  CI_MEASUREMENT_REGRESSION_MODE=warn \
  CI_MEASUREMENT_PR_COMMENT_ENABLED=false \
    bash "$tmp_dir/compare.sh"
}

policy='{"enabled":true,"minBaselineSources":1,"minCurrentSamples":5,"warnRatio":1.1,"failRatio":1.2,"warnAbs":0.25,"failAbs":0.5,"noiseFloor":0.1}'
emit_compare_script

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 12 legacy "$policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 legacy "$policy"
write_measurement "$tmp_dir/baseline/run-1/baseline/run-old/measurements.json" 1 legacy "$policy"
run_compare
actual_sources="$(jq -r '.comparisons[] | .baselineSources' "$tmp_dir/comparison.json")"
actual_baseline="$(jq -r '.comparisons[] | .baseline' "$tmp_dir/comparison.json")"
if [ "$actual_sources" != "1" ] || [ "$actual_baseline" != "10" ]; then
  echo "expected clean top-level baseline only; got sources=$actual_sources baseline=$actual_baseline" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 12 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 legacy "$policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_gate="$(jq -r '.comparisons[] | .gateReason' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "partial" ] || [ "$actual_gate" != "missing_baseline" ]; then
  echo "expected protocol mismatch to be missing_baseline; got status=$actual_status gate=$actual_gate" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "fail" ] || [ "$actual_row" != "fail" ]; then
  echo "expected confirmed regression to fail; got status=$actual_status row=$actual_row" >&2
  exit 1
fi

low_baseline_policy='{"enabled":true,"minBaselineSources":2,"minCurrentSamples":5,"warnRatio":1.1,"failRatio":1.2,"warnAbs":0.25,"failAbs":0.5,"noiseFloor":0.1}'
rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 10.5 devenv-perf-warm-median-v2 "$low_baseline_policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$low_baseline_policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_gate="$(jq -r '.comparisons[] | .gateReason' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "partial" ] || [ "$actual_row" != "pass" ] || [ "$actual_gate" != "low_baseline_count" ]; then
  echo "expected low baseline count to be partial but not a regression; got status=$actual_status row=$actual_row gate=$actual_gate" >&2
  exit 1
fi

echo "ci-measurement-comparison tests passed"
