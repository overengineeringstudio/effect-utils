#!/usr/bin/env bash
set -euo pipefail

# Disposable-project proof that Buck2 rejects a package target whose declared
# platform differs from the local-only execution host. Proving this against the
# real repository cannot reach the rule diagnostic: under `--fake-arch aarch64`
# the executor-capability cell only contains the real host platform, so
# support_tool analysis crashes at toolchains/configured.bzl
# (`CAPABILITIES["aarch64-linux"]`) before package_task can reject the target.
# This gate instead builds a throwaway Buck project, projects simulated-host
# capabilities into it with the same single-platform CLI and exact Nix stage0
# realizations the real projection uses, and asserts the exact mismatch
# diagnostic fires during analysis before any action executes.
#
# usage: buck2-platform-check.sh REPO_ROOT BUCK2_BIN TOOL_ID PROTOCOL EXECUTABLE [...]
repo_root="${1:?usage: buck2-platform-check.sh REPO_ROOT BUCK2_BIN TOOL_ID PROTOCOL EXECUTABLE [...]}"
buck2_bin="${2:?usage: buck2-platform-check.sh REPO_ROOT BUCK2_BIN TOOL_ID PROTOCOL EXECUTABLE [...]}"
shift 2

awk_bin="${AWK_BIN:-awk}"
bash_bin="${BASH_BIN:-bash}"
cat_bin="${CAT_BIN:-cat}"
cp_bin="${CP_BIN:-cp}"
mkdir_bin="${MKDIR_BIN:-mkdir}"
mktemp_bin="${MKTEMP_BIN:-mktemp}"
mv_bin="${MV_BIN:-mv}"
readlink_bin="${READLINK_BIN:-readlink}"
rm_bin="${RM_BIN:-rm}"

# Both sides of the assertion are constants: the fixture always declares
# x86_64-linux while --fake-arch aarch64 always reports an aarch64-linux
# local-only host, so the rejection is independent of the real host.
simulated_platform="aarch64-linux"
declared_platform="x86_64-linux"
expected_prefix="error: fail: package_task platform mismatch:"
expected_diagnostic="target requires ${declared_platform}, local-only execution host is ${simulated_platform}"

isolation="platform-check-$$-$RANDOM"
# The disposable project must live outside the repository: Buck2 resolves the
# project root from the outermost ancestor .buckconfig, so a throwaway project
# under the repo (e.g. tmp/) is claimed as a nested cell of the real project
# and never sees its own cells. This mirrors buck2-invalidation-e2e.sh.
probe_root="$("$mktemp_bin" -d "${TMPDIR:-/tmp}/buck2-platform-check.XXXXXX")"
stderr_file="$probe_root/stderr.log"
evidence_log="$repo_root/tmp/buck2-platform-mismatch.log"

[ $(( $# % 3 )) -eq 0 ] && [ $# -ge 3 ] || {
  echo "buck2-platform-check: tool arguments must be TOOL_ID PROTOCOL EXECUTABLE triples" >&2
  exit 64
}
[ -x "$buck2_bin" ] || {
  echo "buck2-platform-check: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
buck2_bin="$("$readlink_bin" -f "$buck2_bin")"
[ -f "$repo_root/.buckconfig" ] || {
  echo "buck2-platform-check: repository .buckconfig is missing: $repo_root" >&2
  exit 64
}
for foundation_file in \
  "$repo_root/buck2/package_targets.bzl" \
  "$repo_root/buck2/platforms/defs.bzl" \
  "$repo_root/buck2/platforms/BUCK" \
  "$repo_root/toolchains/configured.bzl"; do
  [ -f "$foundation_file" ] || {
    echo "buck2-platform-check: foundation file is missing: $foundation_file" >&2
    exit 64
  }
done

fail_with_evidence() {
  reason="$1"
  echo "buck2-platform-check: $reason" >&2
  if [ -f "$stderr_file" ]; then
    "$cat_bin" "$stderr_file" >&2
    "$mkdir_bin" -p "$repo_root/tmp"
    "$mv_bin" -f "$stderr_file" "$evidence_log"
    echo "buck2-platform-check: stderr evidence retained at $evidence_log" >&2
  fi
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -d "$probe_root" ]; then
    (cd "$probe_root" && "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1) || true
    (cd "$probe_root" && "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1) || true
    "$rm_bin" -rf "$probe_root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$mkdir_bin" -p "$probe_root/buck2/platforms" "$probe_root/toolchains" "$probe_root/probe/src"
"$cp_bin" -p "$repo_root/.buckconfig" "$probe_root/.buckconfig"
"$cp_bin" -p "$repo_root/buck2/package_targets.bzl" "$probe_root/buck2/package_targets.bzl"
"$cp_bin" -p "$repo_root/buck2/platforms/defs.bzl" "$probe_root/buck2/platforms/defs.bzl"
"$cp_bin" -p "$repo_root/buck2/platforms/BUCK" "$probe_root/buck2/platforms/BUCK"
"$cp_bin" -p "$repo_root/toolchains/configured.bzl" "$probe_root/toolchains/configured.bzl"

# Project the simulated host's executor capabilities into the throwaway root so
# support_tool analysis resolves CAPABILITIES under --fake-arch and the probe
# observes the package_task rejection rather than a capability-cell crash.
"$bash_bin" "$repo_root/scripts/buck2-capability-project.sh" "$probe_root" "$simulated_platform" "$@"

{
  printf '%s\n' 'load(":configured.bzl", "support_tool")'
  while [ "$#" -gt 0 ]; do
    tool_id="$1" protocol="$2"
    shift 3
    printf '%s\n' '' \
      'support_tool(' \
      "    name = \"${tool_id//-/_}_tool\"," \
      "    protocol = \"$protocol\"," \
      "    tool_id = \"$tool_id\"," \
      '    visibility = ["PUBLIC"],' \
      ')'
  done
} >"$probe_root/toolchains/BUCK"

printf '%s\n' '// platform-probe input fixture' >"$probe_root/probe/src/mod.ts"
printf '%s\n' '{"name":"platform-probe"}' >"$probe_root/probe/config.json"
printf '%s\n' '{"schemaVersion":1}' >"$probe_root/probe/plan.json"
{
  printf '%s\n' 'load("//buck2:package_targets.bzl", "package_task")' ''
  printf '%s\n' 'package_task(' \
    '    name = "platform_probe_input_plan",' \
    '    package_path = "probe",' \
    '    kind = "typescript-input-plan-evidence",' \
    "    platform = \"${declared_platform}\"," \
    '    sources = [' \
    '        "src/mod.ts",' \
    '    ],' \
    '    configs = [' \
    '        "config.json",' \
    '    ],' \
    '    deps = [' \
    '    ],' \
    '    closure_descriptor = "plan.json",' \
    ')'
} >"$probe_root/probe/BUCK"

cd "$probe_root"
if "$buck2_bin" \
  --isolation-dir "$isolation" \
  build --fake-arch aarch64 \
  //probe:platform_probe_input_plan \
  --local-only --no-remote-cache \
  >/dev/null 2>"$stderr_file"; then
  fail_with_evidence "mismatched platform unexpectedly built"
fi
actual="$("$awk_bin" -v prefix="$expected_prefix" '
  $0 ~ prefix {
    sub(/^.*error: fail: package_task platform mismatch: /, "")
    print
    exit
  }
' "$stderr_file")"
if [ "$actual" != "$expected_diagnostic" ]; then
  fail_with_evidence "unexpected diagnostic: $actual"
fi

echo "buck2-platform-check: PASS diagnostic=$actual"
