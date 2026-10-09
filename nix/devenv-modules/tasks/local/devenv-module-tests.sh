#!/usr/bin/env bash
set -euo pipefail

TEST_BASH="${BASH_BIN:-$BASH}"
TEST_DATE="${DATE_BIN:-date}"
TEST_XARGS="${XARGS_BIN:-xargs}"

run_test() {
  local test_file="$1" scheduling="$2" status=0
  printf 'devenv-modules:test script=%s phase=start timestamp=%s scheduling=%s\n' \
    "${test_file##*/}" "$("$TEST_DATE" -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$scheduling" >&2
  "$TEST_BASH" "$test_file" || status=$?
  printf 'devenv-modules:test script=%s phase=end timestamp=%s scheduling=%s status=%s\n' \
    "${test_file##*/}" "$("$TEST_DATE" -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$scheduling" "$status" >&2
  return "$status"
}

# Each xargs worker owns one child shell. Normalize every test failure, including
# exit 255, to 1: xargs would otherwise stop dispatching and lose coverage.
if [ "${1:-}" = --run ]; then
  [ "$#" -eq 2 ] || exit 2
  run_test "$2" parallel || exit 1
  exit 0
fi

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  printf 'Expected a devenv module test directory: %s\n' "${1:-<missing>}" >&2
  exit 1
fi
test_dir="$1"
runner="${BASH_SOURCE[0]}"

parallel_safe() {
  # Explicitly audited admission, not a default assumption about future scripts.
  # See tasks/README.md for fixture ownership and the serial shared-state barrier.
  case "$1" in
    buck2-capability-daemon.test.sh | buck2-capability-publish.test.sh | \
    buck2-capability-source.test.sh | buck2-no-python-actions.test.sh | \
    buck2-rules-source.test.sh | buck2-rust-deps.test.sh | \
    buck2-stage0-source-inputs.test.sh | changeset-check-bodies.test.sh | \
    check-module-options.test.sh | deploy-task-e2e.test.sh | \
    devenv-eval-input-budget.test.sh | devenv-eval-source-roots.test.sh | \
    devenv-task-env-boundary.test.sh | flake-lock-duplicates.test.sh | \
    genie-compiled-staging.test.sh | genie-module-options.test.sh | \
    lint-no-tailwind.test.sh | lint-oxc-file-list.test.sh | \
    megarepo-lock-sync.test.sh | megarepo-status.test.sh | \
    nix-cli-no-hash-refresh.test.sh | observability-capture.test.sh | \
    otel-instr-gating.test.sh | otel-run.test.sh | otel-scrape-oxfmt-wrap.test.sh | \
    oxlint-plugin-injection.test.sh | oxlint-rule-policy.test.sh | \
    pipeline-run.test.sh | pnpm-gvs.test.sh | \
    pnpm-nested-roots-and-source-inputs.test.sh | pnpm-shared-store-reuse.test.sh | \
    pnpm-source-input-refresh.integration.test.sh | pnpm-source-input-staging.test.sh | \
    pnpm-task-smoke.test.sh | pnpm.test.sh | secretspec-native-tasks.test.sh | \
    setup-cache.test.sh | setup-module-options.test.sh | test-task-smoke.test.sh | \
    workflow-report-module-source.test.sh | workflow-report-task-e2e.test.sh | \
    worktree-teardown.test.sh)
      return 0 ;;
    *) return 1 ;;
  esac
}

serial_tests=()
isolated_tests=()
serial_count=0
isolated_count=0
for test_file in "$test_dir"/*.test.sh; do
  [ -f "$test_file" ] || continue
  if parallel_safe "${test_file##*/}"; then
    isolated_tests+=("$test_file")
    isolated_count=$((isolated_count + 1))
  else
    serial_tests+=("$test_file")
    serial_count=$((serial_count + 1))
  fi
done
if [ "$serial_count" -eq 0 ] && [ "$isolated_count" -eq 0 ]; then
  printf 'No devenv module tests found in %s\n' "$test_dir" >&2
  exit 1
fi

failed=0
pool_pid=""
reap_pool() {
  if [ -n "$pool_pid" ]; then
    wait "$pool_pid" || failed=1
    pool_pid=""
  fi
}
cleanup() {
  local status=$?
  # Do not abandon the worker pool on an error or a signal to this supervisor.
  # xargs waits for every dispatched shell; each shell waits for its test.
  trap '' INT TERM
  reap_pool
  if [ "$status" -eq 0 ] && [ "$failed" -ne 0 ]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Shared-checkout state scripts and all unaudited additions run alone before
# either worker starts. Their failures must not suppress isolated tests.
for ((index=0; index<serial_count; index++)); do
  run_test "${serial_tests[$index]}" serial || failed=1
done

if [ "$isolated_count" -gt 0 ]; then
  # GNU and BSD xargs both support NUL-delimited input and -P. Unlike wait -n,
  # this also works with Darwin's system Bash. The worker limit is fixed at two.
  printf '%s\0' "${isolated_tests[@]}" | \
    "$TEST_XARGS" -0 -n 1 -P 2 "$TEST_BASH" "$runner" --run &
  pool_pid=$!
  reap_pool
fi
exit "$failed"
