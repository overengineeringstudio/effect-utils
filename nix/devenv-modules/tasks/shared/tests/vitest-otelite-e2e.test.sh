#!/usr/bin/env bash
set -euo pipefail

# Exercises Vitest's native OTEL lane and the Effect parent bridge through a
# real otelite OTLP receiver. otelite owns readiness and drain; assertions read
# decoded capture rows, so no receiver sleeps or hand-rolled HTTP server exist.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
FIXTURE="$ROOT/packages/@overeng/utils-dev/src/node-vitest/fixtures/otel-e2e"
VITEST="$ROOT/packages/@overeng/utils-dev/node_modules/.bin/vitest"
TRACE_ID="0af7651916cd43dd8448eb211c80319c"
PARENT_SPAN_ID="b7ad6b7169203331"
TRACEPARENT="00-$TRACE_ID-$PARENT_SPAN_ID-01"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

resolve_otelite() {
  if [ -n "${OTELITE_BIN:-}" ]; then
    printf '%s\n' "$OTELITE_BIN"
  elif command -v otelite >/dev/null 2>&1; then
    command -v otelite
  else
    printf '%s/bin/otelite\n' "$(nix build --no-link --print-out-paths "$ROOT#otelite")"
  fi
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
otelite_bin="$(resolve_otelite)"

run_fixture() {
  local label="$1"
  local enabled="$2"
  local file="$3"
  local expect_exit="$4"
  local capture="$tmpdir/$label.capture"
  local stdout="$tmpdir/$label.stdout"
  local stderr="$tmpdir/$label.stderr"
  local actual_exit

  set +e
  if [ "$enabled" = 1 ]; then
    TRACEPARENT="$TRACEPARENT" VITEST_OTEL_RUNNER=1 \
      "$otelite_bin" run --out "$capture" --protocol http/json --drain-idle 100 -- \
      "$VITEST" run --config "$FIXTURE/vitest.config.mjs" "$file" \
      >"$stdout" 2>"$stderr"
  else
    env -u TRACEPARENT -u OTEL_TASK_TRACEPARENT -u VITEST_OTEL_RUNNER \
      "$otelite_bin" run --out "$capture" --protocol http/json --drain-idle 100 -- \
      "$VITEST" run --config "$FIXTURE/vitest.config.mjs" "$file" \
      >"$stdout" 2>"$stderr"
  fi
  actual_exit=$?
  set -e

  [ "$actual_exit" -eq "$expect_exit" ] \
    || fail "$label: expected exit $expect_exit, got $actual_exit ($(cat "$stderr"))"

  "$otelite_bin" inspect "$capture" --signal traces >"$tmpdir/$label.spans.ndjson"
}

echo "Running Vitest OTEL otelite e2e test..."

# Endpoint availability alone is not enablement: no switch means no SDK and no
# native Vitest spans. This is the negative control for collector gating.
run_fixture disabled 0 success.fixture.test.ts 0
jq -e '.counts.spans == 0 and .counts.rejected == 0 and .child.exit_code == 0' \
  "$tmpdir/disabled.stdout" >/dev/null \
  || fail "disabled: endpoint-only run should capture zero spans and preserve success"

# The positive half of the inherited-context regression: the same real runner
# joins the supplied W3C trace and its top span points at the external parent.
run_fixture bridge 1 bridge.fixture.test.ts 0
jq -e '.counts.spans > 0 and .counts.rejected == 0 and .child.exit_code == 0' \
  "$tmpdir/bridge.stdout" >/dev/null \
  || fail "bridge: enabled run should drain accepted spans and preserve success"
jq -s -e --arg trace "$TRACE_ID" 'all(.[]; .trace_id == $trace)' \
  "$tmpdir/bridge.spans.ndjson" >/dev/null \
  || fail "bridge: every runner and product span should join the inherited trace"
jq -s -e --arg parent "$PARENT_SPAN_ID" '
  any(.[]; .name == "vitest.start" and .parent_span_id == $parent)
' "$tmpdir/bridge.spans.ndjson" >/dev/null \
  || fail "bridge: vitest.start should parent directly to inherited TRACEPARENT"
product_parent="$(
  jq -r 'select(.name == "vitest-otel-e2e.product") | .parent_span_id' \
    "$tmpdir/bridge.spans.ndjson"
)"
[ -n "$product_parent" ] && [ "$product_parent" != null ] \
  || fail "bridge: missing Effect product span parent"
jq -s -e --arg parent "$product_parent" '
  any(.[]; .span_id == $parent and .name == "vitest.test.runner.test.callback")
' "$tmpdir/bridge.spans.ndjson" >/dev/null \
  || fail "bridge: Effect product span should parent to the active Vitest callback"

# The assertion lane uses its own otelite receiver. Its fixture asserts the
# captured product is one root span; the outer receiver must see native runner
# spans but never that capture-owned product tree, proving suppression and
# exporter isolation.
run_fixture suppression 1 suppression.fixture.test.ts 0
jq -e '.counts.spans > 0 and .counts.rejected == 0 and .child.exit_code == 0' \
  "$tmpdir/suppression.stdout" >/dev/null \
  || fail "suppression: outer runner capture should drain without rejects"
jq -s -e '
  any(.[]; .name == "vitest.test.runner.test.callback")
  and all(.[]; .name != "vitest-otel-e2e.captured-product")
' "$tmpdir/suppression.spans.ndjson" >/dev/null \
  || fail "suppression: outer receiver should contain runner spans, not assertion product spans"

# A failing child still completes the otelite drain and exports an ERROR
# callback. No timing assertion is involved: the summary and decoded rows are
# the deterministic completion evidence.
run_fixture failure 1 failure.fixture.test.ts 1
jq -e '.counts.spans > 0 and .counts.rejected == 0 and .child.exit_code == 1' \
  "$tmpdir/failure.stdout" >/dev/null \
  || fail "failure: summary should preserve child failure after draining accepted spans"
jq -s -e '
  any(.[]; .name == "vitest.test.runner.test.callback" and .status_code == 2)
' "$tmpdir/failure.spans.ndjson" >/dev/null \
  || fail "failure: failed callback should export OTEL error status"

echo "Vitest OTEL otelite e2e test passed"
