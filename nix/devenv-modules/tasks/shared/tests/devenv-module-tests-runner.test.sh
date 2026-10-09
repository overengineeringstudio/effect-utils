#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TESTS_DIR/../../local/devenv-module-tests.sh"
TEST_BASH="${BASH_BIN:-$BASH}"
tmpdir="$(mktemp -d)"
runner_pid=""
gates_open=false
cleanup() {
  local status=$?
  if [ "$gates_open" = true ]; then
    printf 'release\n' >&4
    for ((release=0; release<4; release++)); do printf 'release\n' >&5; done
  fi
  if [ -n "$runner_pid" ]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
  exit "$status"
}
trap cleanup EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_case() {
  local label="$1" first_exit="$2" second_exit="$3" serial_exit="$4" expected="$5"
  local workers="${6:-4}" weighted="${7:-true}"
  local fixture="$tmpdir/$label" ready status=0 name pid index initial_seen=":"
  local -a names=(
    buck2-capability-daemon.test.sh buck2-capability-publish.test.sh
    buck2-capability-source.test.sh buck2-no-python-actions.test.sh
    buck2-rules-source.test.sh buck2-rust-deps.test.sh worktree-teardown.test.sh
  )
  if [ "$weighted" = true ]; then
    names=(worktree-teardown.test.sh buck2-capability-daemon.test.sh
      buck2-capability-publish.test.sh buck2-capability-source.test.sh
      buck2-no-python-actions.test.sh buck2-rules-source.test.sh buck2-rust-deps.test.sh)
  fi
  mkdir -p "$fixture/tests" "$fixture/state/private"
  printf '%s\n' '{"worktree-teardown.test.sh":90,"buck2-capability-daemon.test.sh":80,"buck2-capability-publish.test.sh":70,"buck2-capability-source.test.sh":60,"buck2-no-python-actions.test.sh":50,"zz-unreviewed fixture.test.sh":999}' >"$fixture/weights.json"
  if [ "$weighted" = false ]; then printf '{}\n' >"$fixture/weights.json"; fi
  mkfifo "$fixture/ready" "$fixture/release-first" "$fixture/release-second"
  exec 3<>"$fixture/ready"
  exec 4<>"$fixture/release-first"
  exec 5<>"$fixture/release-second"
  gates_open=true

  # These names use the production admission list; no test-only scheduler path.
  for name in "${names[@]}"; do
    cat >"$fixture/tests/$name" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
name="${0##*/}"
[ -f "$RUNNER_FIXTURE_STATE/serial-first" ]
[ -f "$RUNNER_FIXTURE_STATE/serial-last" ]
[ "$RUNNER_FIXTURE_VALUE" = inherited ]
[ "$PWD" = "$RUNNER_FIXTURE_CWD" ]
[ ! -e "$RUNNER_FIXTURE_STATE/$name.pid" ]
printf '%s\n' "$$" >"$RUNNER_FIXTURE_STATE/$name.pid"
trap 'printf "cleaned\n" >"$RUNNER_FIXTURE_STATE/$name.cleaned"' EXIT
printf '%s\n' "$name" >"$RUNNER_FIXTURE_READY"
printf 'output:%s\n' "$name"
case "$name" in
  buck2-capability-daemon.test.sh)
    export RUNNER_FIXTURE_VALUE=changed
    cd "$RUNNER_FIXTURE_STATE/private"
    IFS= read -r _ <"$RUNNER_FIXTURE_RELEASE_FIRST"
    exit "$RUNNER_FIXTURE_FIRST_EXIT" ;;
  buck2-capability-publish.test.sh)
    IFS= read -r _ <"$RUNNER_FIXTURE_RELEASE_SECOND"
    exit "$RUNNER_FIXTURE_SECOND_EXIT" ;;
esac
case ":$RUNNER_FIXTURE_BLOCKED:" in
  *":$name:"*) IFS= read -r _ <"$RUNNER_FIXTURE_RELEASE_SECOND" ;;
esac
SCRIPT
  done
  cat >"$fixture/tests/devenv-task-graph.test.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
for pid_file in "$RUNNER_FIXTURE_STATE/"*.pid; do [ ! -f "$pid_file" ]; done
printf 'serial\n' >"$RUNNER_FIXTURE_STATE/serial-first"
exit "$RUNNER_FIXTURE_SERIAL_EXIT"
SCRIPT
  cat >"$fixture/tests/zz-unreviewed fixture.test.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[ -f "$RUNNER_FIXTURE_STATE/serial-first" ]
for pid_file in "$RUNNER_FIXTURE_STATE/"*.pid; do [ ! -f "$pid_file" ]; done
printf 'serial\n' >"$RUNNER_FIXTURE_STATE/serial-last"
SCRIPT

  RUNNER_FIXTURE_STATE="$fixture/state" \
    MODULE_TEST_WORKERS="$workers" MODULE_TEST_WEIGHTS="$fixture/weights.json" \
    RUNNER_FIXTURE_BLOCKED="$(IFS=:; printf '%s' "${names[*]:0:$workers}")" \
    RUNNER_FIXTURE_READY="$fixture/ready" \
    RUNNER_FIXTURE_RELEASE_FIRST="$fixture/release-first" \
    RUNNER_FIXTURE_RELEASE_SECOND="$fixture/release-second" \
    RUNNER_FIXTURE_FIRST_EXIT="$first_exit" \
    RUNNER_FIXTURE_SECOND_EXIT="$second_exit" \
    RUNNER_FIXTURE_SERIAL_EXIT="$serial_exit" \
    RUNNER_FIXTURE_VALUE=inherited RUNNER_FIXTURE_CWD="$PWD" \
    "$TEST_BASH" "$RUNNER" "$fixture/tests" >"$fixture/stdout" 2>"$fixture/stderr" &
  runner_pid=$!
  for ((index=0; index<workers; index++)); do
    IFS= read -r -t 30 -u 3 ready || fail "$label: worker $index did not start"
    case "$initial_seen" in *":$ready:"*) fail "$label: duplicate worker: $ready" ;; esac
    initial_seen="$initial_seen$ready:"
    found=false
    for name in "${names[@]:0:$workers}"; do
      if [ "$ready" = "$name" ]; then found=true; fi
    done
    [ "$found" = true ] || fail "$label: shorter script dispatched before longest: $ready"
  done
  for name in "${names[@]:$workers}"; do
    [ ! -f "$fixture/state/$name.pid" ] || fail "$label: extra worker exceeded bound: $name"
  done

  if [ "$label" = supervisor-term ]; then kill -TERM "$runner_pid"; fi
  printf 'release\n' >&4
  # One worker must continue after a failure while the other is still blocked.
  for name in "${names[@]:$workers}"; do
    IFS= read -r -t 30 -u 3 ready || fail "$label: failure skipped $name"
    [ "$ready" = "$name" ] || fail "$label: expected $name, got $ready"
  done
  for ((index=1; index<workers; index++)); do printf 'release\n' >&5; done
  wait "$runner_pid" || status=$?
  runner_pid=""
  [ "$status" -eq "$expected" ] || fail "$label: expected exit $expected, got $status"
  gates_open=false
  exec 3>&- 4>&- 5>&-

  for name in "${names[@]}"; do
    [ "$(cat "$fixture/state/$name.cleaned")" = cleaned ] || fail "$label: child cleanup was not awaited: $name"
    pid="$(cat "$fixture/state/$name.pid")"
    if kill -0 "$pid" 2>/dev/null; then fail "$label: child was not reaped: $name ($pid)"; fi
    [ "$(grep -cF "script=$name phase=start timestamp=" "$fixture/stderr")" -eq 1 ] || fail "$label: missing or duplicate start: $name"
    [ "$(grep -cF "script=$name phase=end timestamp=" "$fixture/stderr")" -eq 1 ] || fail "$label: missing or duplicate end: $name"
    grep -qF "output:$name" "$fixture/stdout" || fail "$label: stdout lost: $name"
  done
  grep -Eq "script=buck2-capability-daemon.test.sh phase=end timestamp=[^ ]+ scheduling=parallel status=$first_exit$" "$fixture/stderr" || fail "$label: first verdict not recorded"
  grep -Eq "script=buck2-capability-publish.test.sh phase=end timestamp=[^ ]+ scheduling=parallel status=$second_exit$" "$fixture/stderr" || fail "$label: second verdict not recorded"
  grep -Eq "script=devenv-task-graph.test.sh phase=end timestamp=[^ ]+ scheduling=serial status=$serial_exit$" "$fixture/stderr" || fail "$label: serial verdict not recorded"
  grep -qF 'script=zz-unreviewed fixture.test.sh phase=end timestamp=' "$fixture/stderr" || fail "$label: unknown script was skipped"
  for name in devenv-task-graph.test.sh 'zz-unreviewed fixture.test.sh'; do
    [ "$(grep -cF "script=$name phase=start timestamp=" "$fixture/stderr")" -eq 1 ] || fail "$label: serial start missing or duplicated: $name"
    [ "$(grep -cF "script=$name phase=end timestamp=" "$fixture/stderr")" -eq 1 ] || fail "$label: serial end missing or duplicated: $name"
  done
  awk -v workers="$workers" '
    /phase=start / { active++; if (active > peak) peak = active }
    /scheduling=serial/ && active > 1 { invalid = 1 }
    /phase=end / { active--; if (active < 0) invalid = 1 }
    END { exit invalid || active != 0 || peak != workers }
  ' "$fixture/stderr" || fail "$label: timestamp evidence violated the worker / serial bound"
  printf 'PASS: %s (%s workers, serial admission, complete verdicts, isolated shells, reaped children)\n' "$label" "$workers"
}

run_case success 0 0 0 0
run_case first-worker-failure 7 0 0 1
run_case second-worker-failure 0 23 0 1
run_case all-failures 7 255 19 1
run_case supervisor-term 0 0 0 143
run_case fallback-three 0 0 0 0 3
run_case default-weights 0 0 0 0 4 false

mkdir -p "$tmpdir/empty"
if "$TEST_BASH" "$RUNNER" "$tmpdir/empty" >"$tmpdir/empty.stdout" 2>"$tmpdir/empty.stderr"; then
  fail 'empty suite succeeded'
fi
grep -qF 'No devenv module tests found' "$tmpdir/empty.stderr"
if "$TEST_BASH" "$RUNNER" "$tmpdir/missing" >"$tmpdir/missing.stdout" 2>"$tmpdir/missing.stderr"; then
  fail 'missing suite succeeded'
fi
printf 'PASS: empty and missing suites fail\n'
for workers in 0 -1 two 1.5; do
  if MODULE_TEST_WORKERS="$workers" "$TEST_BASH" "$RUNNER" "$tmpdir/success/tests" >"$tmpdir/invalid.stdout" 2>"$tmpdir/invalid.stderr"; then
    fail "invalid worker count succeeded: $workers"
  fi
  grep -qF 'Expected a positive integer MODULE_TEST_WORKERS' "$tmpdir/invalid.stderr"
done
printf 'PASS: invalid worker counts fail before dispatch\n'
