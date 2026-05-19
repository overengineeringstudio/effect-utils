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
paired_policy='{"enabled":true,"comparisonMode":"paired","minBaselineSources":1,"minCurrentSamples":5,"minPairedSamples":5,"warnRatio":1.1,"failRatio":1.2,"warnAbs":0.25,"failAbs":0.5,"noiseFloor":0.1}'
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
actual_enforceable="$(jq -r '.readiness.enforceable' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "partial" ] || [ "$actual_gate" != "missing_baseline" ] || [ "$actual_enforceable" != "false" ]; then
  echo "expected protocol mismatch to be missing_baseline and unenforceable; got status=$actual_status gate=$actual_gate enforceable=$actual_enforceable" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_enforceable="$(jq -r '.readiness.enforceable' "$tmp_dir/comparison.json")"
actual_impact="$(jq -r '.comparisons[] | .semanticImpactScore' "$tmp_dir/comparison.json")"
actual_impact_kind="$(jq -r '.comparisons[] | .semanticImpactKind' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "fail" ] || [ "$actual_row" != "fail" ] || [ "$actual_enforceable" != "true" ] || [ "$actual_impact_kind" != "fail_boundary" ] || ! awk "BEGIN { exit !($actual_impact > 1) }"; then
  echo "expected confirmed regression to fail and have fail-boundary impact; got status=$actual_status row=$actual_row enforceable=$actual_enforceable impact=$actual_impact kind=$actual_impact_kind" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$paired_policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$paired_policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_gate="$(jq -r '.comparisons[] | .gateReason' "$tmp_dir/comparison.json")"
actual_confidence="$(jq -r '.comparisons[] | .confidence' "$tmp_dir/comparison.json")"
actual_enforceable="$(jq -r '.readiness.enforceable' "$tmp_dir/comparison.json")"
actual_low_paired="$(jq -r '.readiness.lowPairedSampleCount' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "partial" ] || [ "$actual_row" != "pass" ] || [ "$actual_gate" != "low_paired_sample_count" ] || [ "$actual_confidence" != "low_paired_sample_count" ] || [ "$actual_enforceable" != "false" ] || [ "$actual_low_paired" != "1" ]; then
  echo "expected paired wall-clock policy without paired evidence to be partial/non-enforceable; got status=$actual_status row=$actual_row gate=$actual_gate confidence=$actual_confidence enforceable=$actual_enforceable lowPaired=$actual_low_paired" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$paired_policy"
jq '.observations[0].comparison = { mode: "paired", baseline: 12.95, pairedSampleCount: 5 }
  | .observations[0].statistics.pairedSampleCount = 5
  | .observations[0].statistics.pairedDeltaMedian = 0.05
  | .observations[0].statistics.pairedDeltaP25 = 0.04
  | .observations[0].statistics.pairedDeltaP75 = 0.06
  | .observations[0].statistics.pairedDeltaMad = 0.01' \
  "$tmp_dir/current/measurements.json" >"$tmp_dir/current/measurements.updated.json"
mv "$tmp_dir/current/measurements.updated.json" "$tmp_dir/current/measurements.json"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$paired_policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_gate="$(jq -r '.comparisons[] | .gateReason' "$tmp_dir/comparison.json")"
actual_baseline="$(jq -r '.comparisons[] | .baseline' "$tmp_dir/comparison.json")"
actual_enforceable="$(jq -r '.readiness.enforceable' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "pass" ] || [ "$actual_row" != "pass" ] || [ "$actual_gate" != "eligible" ] || [ "$actual_baseline" != "12.95" ] || [ "$actual_enforceable" != "true" ]; then
  echo "expected paired current artifact baseline to override historical baseline; got status=$actual_status row=$actual_row gate=$actual_gate baseline=$actual_baseline enforceable=$actual_enforceable" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$paired_policy"
jq '.observations[0].comparison = { mode: "paired", baseline: 10, pairedSampleCount: 5 }
  | .observations[0].statistics.pairedSampleCount = 5
  | .observations[0].statistics.pairedDeltaMedian = 1.2
  | .observations[0].statistics.pairedDeltaP25 = -1
  | .observations[0].statistics.pairedDeltaP75 = 3
  | .observations[0].statistics.pairedDeltaMad = 1' \
  "$tmp_dir/current/measurements.json" >"$tmp_dir/current/measurements.updated.json"
mv "$tmp_dir/current/measurements.updated.json" "$tmp_dir/current/measurements.json"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$paired_policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_confidence="$(jq -r '.comparisons[] | .confidence' "$tmp_dir/comparison.json")"
actual_impact="$(jq -r '.comparisons[] | .semanticImpactScore' "$tmp_dir/comparison.json")"
actual_lower="$(jq -r '.comparisons[] | .evidenceDeltaLower' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "pass" ] || [ "$actual_row" != "pass" ] || [ "$actual_confidence" != "paired_uncertain" ] || [ "$actual_impact" != "0" ] || ! awk "BEGIN { exit !($actual_lower < 0) }"; then
  echo "expected noisy paired delta to stay pass/uncertain; got status=$actual_status row=$actual_row confidence=$actual_confidence impact=$actual_impact lower=$actual_lower" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/measurements.json" 13 devenv-perf-warm-median-v2 "$paired_policy"
jq '.observations[0].comparison = { mode: "paired", baseline: 10, pairedSampleCount: 5 }
  | .observations[0].statistics.pairedSampleCount = 5
  | .observations[0].statistics.pairedDeltaMedian = 3.2
  | .observations[0].statistics.pairedDeltaP25 = 3.15
  | .observations[0].statistics.pairedDeltaP75 = 3.25
  | .observations[0].statistics.pairedDeltaMad = 0.03' \
  "$tmp_dir/current/measurements.json" >"$tmp_dir/current/measurements.updated.json"
mv "$tmp_dir/current/measurements.updated.json" "$tmp_dir/current/measurements.json"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 10 devenv-perf-warm-median-v2 "$paired_policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_confidence="$(jq -r '.comparisons[] | .confidence' "$tmp_dir/comparison.json")"
actual_impact="$(jq -r '.comparisons[] | .semanticImpactScore' "$tmp_dir/comparison.json")"
actual_lower="$(jq -r '.comparisons[] | .evidenceDeltaLower' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "fail" ] || [ "$actual_row" != "fail" ] || [ "$actual_confidence" != "threshold_exceeded" ] || ! awk "BEGIN { exit !($actual_impact > 1) }" || ! awk "BEGIN { exit !($actual_lower > 2) }"; then
  echo "expected stable paired delta over fail budget to fail; got status=$actual_status row=$actual_row confidence=$actual_confidence impact=$actual_impact lower=$actual_lower" >&2
  exit 1
fi

rm -rf "$tmp_dir/current" "$tmp_dir/baseline"
write_measurement "$tmp_dir/current/run-1/measurements.json" 5.1 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/current/run-2/measurements.json" 5.2 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/current/run-3/measurements.json" 7.0 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/current/run-4/measurements.json" 7.2 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/current/run-5/measurements.json" 7.4 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-1/measurements.json" 4.0 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-2/measurements.json" 4.2 devenv-perf-warm-median-v2 "$policy"
write_measurement "$tmp_dir/baseline/run-3/measurements.json" 4.4 devenv-perf-warm-median-v2 "$policy"
run_compare
actual_status="$(jq -r '.status' "$tmp_dir/comparison.json")"
actual_row="$(jq -r '.comparisons[] | .status' "$tmp_dir/comparison.json")"
actual_confidence="$(jq -r '.comparisons[] | .confidence' "$tmp_dir/comparison.json")"
actual_current_lower="$(jq -r '.comparisons[] | .currentRobustLower' "$tmp_dir/comparison.json")"
actual_baseline_upper="$(jq -r '.comparisons[] | .baselineRobustUpper' "$tmp_dir/comparison.json")"
actual_impact="$(jq -r '.comparisons[] | .semanticImpactScore' "$tmp_dir/comparison.json")"
actual_impact_kind="$(jq -r '.comparisons[] | .semanticImpactKind' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "pass" ] || [ "$actual_row" != "pass" ] || [ "$actual_confidence" != "within_robust_band" ] || [ "$actual_impact" != "0" ] || [ "$actual_impact_kind" != "neutral" ] || ! awk "BEGIN { exit !($actual_current_lower <= $actual_baseline_upper) }"; then
  echo "expected overlapping current/baseline robust bands to pass with neutral impact; got status=$actual_status row=$actual_row confidence=$actual_confidence impact=$actual_impact kind=$actual_impact_kind currentLower=$actual_current_lower baselineUpper=$actual_baseline_upper" >&2
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
actual_enforceable="$(jq -r '.readiness.enforceable' "$tmp_dir/comparison.json")"
actual_gateable_count="$(jq -r '.readiness.gateableCount' "$tmp_dir/comparison.json")"
actual_enabled_count="$(jq -r '.readiness.enabledCount' "$tmp_dir/comparison.json")"
if [ "$actual_status" != "partial" ] || [ "$actual_row" != "pass" ] || [ "$actual_gate" != "low_baseline_count" ] || [ "$actual_enforceable" != "false" ] || [ "$actual_gateable_count" != "0" ] || [ "$actual_enabled_count" != "1" ]; then
  echo "expected low baseline count to be partial but not enforceable; got status=$actual_status row=$actual_row gate=$actual_gate enforceable=$actual_enforceable readiness=$actual_gateable_count/$actual_enabled_count" >&2
  exit 1
fi

echo "ci-measurement-comparison tests passed"
