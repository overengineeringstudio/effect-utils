#!/usr/bin/env bash
set -euo pipefail

# Nix-layer coverage for the otel-run primitive (deliverable C) and the
# check:quick:trace / check:all:trace convenience tasks. Proven WITHOUT
# depending on a real OTLP endpoint, a real Grafana, or check:quick passing:
#
#   1. FRESH ROOT: otel-run unsets the ambient TRACEPARENT before invoking
#      otel-span and mints a fresh 32-hex trace id (--trace-id), so the wrapped
#      command's spans form their own trace. Two runs mint distinct ids.
#   2. --join: joins the ambient trace instead — passes NO --trace-id (so the
#      span is not orphaned onto a fresh trace) and keeps TRACEPARENT.
#   3. LABEL derivation: `devenv tasks run <task>` -> <task>; else argv[0]
#      basename; --label overrides.
#   4. GRAFANA LINK: a Grafana explore URL containing the trace id is printed on
#      stderr (gated on OTEL_GRAFANA_URL, so hermetic).
#   5. EXIT CODE forwarding: the wrapped command's exit code is otel-run's.
#   6. WIRING (static): the real check:quick:trace / check:all:trace task execs
#      wrap `devenv tasks run check:quick|all` with otel-run.
#
# otel-run is built directly from the on-disk .nix file (like otel-instr-gating
# imports trace.nix), so this runs before otel-run.nix is git-add-ed. A stub
# otel-span / devenv on PATH records what otel-run passes and runs the wrapped
# command, so nothing real is executed.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

_pass=0
_fail=0
fail() {
  echo "FAIL: $1" >&2
  _fail=$((_fail + 1))
}
ok() {
  _pass=$((_pass + 1))
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running otel-run test..."

# --- build otel-run from the on-disk file (untracked-safe) ---
nix build --impure --no-link --print-out-paths --expr "
  let
    flake = builtins.getFlake (toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in import $ROOT/nix/devenv-modules/otel/otel-run.nix { inherit pkgs; }
" > "$tmpdir/otel-run-path" || { echo "FAIL: nix build otel-run" >&2; exit 1; }
otel_run="$(cat "$tmpdir/otel-run-path")/bin/otel-run"
[ -x "$otel_run" ] || { echo "FAIL: otel-run not built at $otel_run" >&2; exit 1; }

# --- stub otel-span (records what otel-run passed, then runs the command) and
#     stub devenv (so the `devenv tasks run` label case runs nothing real) ---
stubbin="$tmpdir/stubbin"
mkdir -p "$stubbin"

cat > "$stubbin/otel-span" <<'STUB'
#!/usr/bin/env bash
# $OTEL_RUN_TEST_CAPTURE receives the observable inputs; then exec the command.
{
  echo "TRACEPARENT=${TRACEPARENT:-}"
  echo "OTEL_TASK_TRACEPARENT=${OTEL_TASK_TRACEPARENT:-}"
  echo "ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
} > "$OTEL_RUN_TEST_CAPTURE"
shift # drop the `run` subcommand
trace_id=""
positional=()
cmd=()
while [ $# -gt 0 ]; do
  case "$1" in
    --trace-id) trace_id="$2"; shift 2 ;;
    --attr | --span-id | --parent-span-id | --start-time-ns | --end-time-ns) shift 2 ;;
    --) shift; cmd=("$@"); break ;;
    *) positional+=("$1"); shift ;;
  esac
done
{
  echo "TRACE_ID=$trace_id"
  echo "SERVICE=${positional[0]:-}"
  echo "SPAN_NAME=${positional[1]:-}"
} >> "$OTEL_RUN_TEST_CAPTURE"
exec "${cmd[@]}"
STUB
chmod +x "$stubbin/otel-span"

cat > "$stubbin/devenv" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$stubbin/devenv"

VALID_TRACEPARENT="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
AMBIENT_TRACE_ID="0af7651916cd43dd8448eb211c80319c"

cap() { cat "$1"; }
cap_val() { sed -n "s/^$2=//p" "$1"; }

# --- (1) FRESH ROOT: devenv-task label, minted trace id, ambient TP unset, URL ---
capA="$tmpdir/capA"
errA="$tmpdir/errA"
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" \
  OTEL_RUN_TEST_CAPTURE="$capA" \
  TRACEPARENT="$VALID_TRACEPARENT" \
  OTEL_GRAFANA_URL="http://grafana.test:3000" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  "$otel_run" -- devenv tasks run check:quick 2> "$errA" || fail "fresh-root run exited nonzero"

[ "$(cap_val "$capA" SPAN_NAME)" = "check:quick" ] \
  && ok || fail "fresh-root: label should derive to 'check:quick', got '$(cap_val "$capA" SPAN_NAME)'"
tid_a="$(cap_val "$capA" TRACE_ID)"
[[ "$tid_a" =~ ^[0-9a-f]{32}$ ]] \
  && ok || fail "fresh-root: expected a minted 32-hex --trace-id, got '$tid_a'"
[ -z "$(cap_val "$capA" TRACEPARENT)" ] \
  && ok || fail "fresh-root: ambient TRACEPARENT should be unset in the child, got '$(cap_val "$capA" TRACEPARENT)'"
[ "$tid_a" != "$AMBIENT_TRACE_ID" ] \
  && ok || fail "fresh-root: minted trace id must differ from the ambient trace id"
grep -q "grafana.test:3000/explore" "$errA" \
  && ok || fail "fresh-root: expected a Grafana explore URL on stderr; got: $(cat "$errA")"
grep -q "$tid_a" "$errA" \
  && ok || fail "fresh-root: Grafana URL should contain the minted trace id"

# --- (1b) FRESHNESS: a second run mints a different trace id ---
capA2="$tmpdir/capA2"
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" OTEL_RUN_TEST_CAPTURE="$capA2" \
  "$otel_run" -- true 2>/dev/null || fail "second fresh-root run exited nonzero"
[ "$(cap_val "$capA2" TRACE_ID)" != "$tid_a" ] \
  && ok || fail "freshness: two runs must mint distinct trace ids"

# --- (2) --join: no --trace-id, ambient TRACEPARENT preserved, URL uses ambient id ---
capB="$tmpdir/capB"
errB="$tmpdir/errB"
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" \
  OTEL_RUN_TEST_CAPTURE="$capB" \
  TRACEPARENT="$VALID_TRACEPARENT" \
  OTEL_GRAFANA_URL="http://grafana.test:3000" \
  "$otel_run" --join -- true 2> "$errB" || fail "--join run exited nonzero"
[ -z "$(cap_val "$capB" TRACE_ID)" ] \
  && ok || fail "--join: must NOT pass --trace-id (inherit trace), got '$(cap_val "$capB" TRACE_ID)'"
[ "$(cap_val "$capB" TRACEPARENT)" = "$VALID_TRACEPARENT" ] \
  && ok || fail "--join: ambient TRACEPARENT must be preserved for the child"
grep -q "$AMBIENT_TRACE_ID" "$errB" \
  && ok || fail "--join: Grafana URL should reference the ambient trace id"

# --- (3) LABEL: basename fallback + --label override ---
capC="$tmpdir/capC"
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" OTEL_RUN_TEST_CAPTURE="$capC" \
  "$otel_run" -- true 2>/dev/null || fail "basename run exited nonzero"
[ "$(cap_val "$capC" SPAN_NAME)" = "true" ] \
  && ok || fail "label: argv[0] basename should be 'true', got '$(cap_val "$capC" SPAN_NAME)'"

capD="$tmpdir/capD"
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" OTEL_RUN_TEST_CAPTURE="$capD" \
  "$otel_run" --label custom-label -- true 2>/dev/null || fail "--label run exited nonzero"
[ "$(cap_val "$capD" SPAN_NAME)" = "custom-label" ] \
  && ok || fail "label: --label should override, got '$(cap_val "$capD" SPAN_NAME)'"

# --- (5) EXIT CODE forwarding ---
capE="$tmpdir/capE"
set +e
env -i PATH="$stubbin:$PATH" HOME="$tmpdir" OTEL_RUN_TEST_CAPTURE="$capE" \
  "$otel_run" -- bash -c 'exit 7' 2>/dev/null
rc=$?
set -e
[ "$rc" -eq 7 ] \
  && ok || fail "exit-code: otel-run must forward the wrapped command's exit code (7), got $rc"

# --- (6) WIRING: the real check:*:trace task execs wrap devenv with otel-run ---
eval_check_exec() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      mod = (import $ROOT/nix/devenv-modules/tasks/shared/check.nix { }) { lib = pkgs.lib; };
    in mod.tasks.\"$1\".exec
  "
}
quick_exec="$(eval_check_exec check:quick:trace)"
all_exec="$(eval_check_exec check:all:trace)"
printf '%s' "$quick_exec" | grep -qF "otel-run devenv tasks run check:quick" \
  && ok || fail "check:quick:trace exec should be 'otel-run devenv tasks run check:quick', got '$quick_exec'"
printf '%s' "$all_exec" | grep -qF "otel-run devenv tasks run check:all" \
  && ok || fail "check:all:trace exec should be 'otel-run devenv tasks run check:all', got '$all_exec'"

echo ""
echo "$_pass passed, $_fail failed"
[ "$_fail" -eq 0 ] && echo "otel-run test passed"
[ "$_fail" -eq 0 ]
