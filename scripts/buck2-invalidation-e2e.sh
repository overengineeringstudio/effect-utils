#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN PACKAGE_EVIDENCE_TOOL}"
buck2_bin="${2:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN PACKAGE_EVIDENCE_TOOL}"
package_evidence_tool="${3:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN PACKAGE_EVIDENCE_TOOL}"
target="//buck2/evidence:package_evidence"
expected_action="root//buck2/evidence:package_evidence (buck2_package_evidence package_evidence)"
isolation="invalidation-e2e-$$-$RANDOM"
tracked_source="$repo_root/buck2/evidence/source.txt"
sha256_bin="${SHA256_BIN:-sha256sum}"
awk_bin="${AWK_BIN:-awk}"

execution_platform="${BUCK2_EXECUTION_PLATFORM:?BUCK2_EXECUTION_PLATFORM must name the exact host capability}"
case "$execution_platform" in
  x86_64-linux|aarch64-linux|aarch64-macos) ;;
  *)
  echo "buck2-invalidation-e2e: unsupported execution platform: $execution_platform" >&2
  exit 64
  ;;
esac

[ -x "$buck2_bin" ] || {
  echo "buck2-invalidation-e2e: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
buck2_bin="$(readlink -f "$buck2_bin")"
[ -x "$package_evidence_tool" ] || {
  echo "buck2-invalidation-e2e: package-evidence tool is not executable: $package_evidence_tool" >&2
  exit 64
}
package_evidence_tool="$(readlink -f "$package_evidence_tool")"
case "$package_evidence_tool" in
  /nix/store/*) ;;
  *)
  echo "buck2-invalidation-e2e: package-evidence tool must resolve to an exact Nix store artifact" >&2
  exit 64
  ;;
esac
package_evidence_digest="$($sha256_bin "$package_evidence_tool" | "$awk_bin" '{ print $1 }')"
package_evidence_closure="$(dirname "$package_evidence_tool")"
[ -f "$tracked_source" ] || {
  echo "buck2-invalidation-e2e: fixture is missing: $tracked_source" >&2
  exit 64
}

tracked_digest="$($sha256_bin "$tracked_source" | "$awk_bin" '{ print $1 }')"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/buck2-invalidation-repo.XXXXXX")"
source_path="$test_root/buck2/evidence/source.txt"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -d "$test_root" ]; then
    cd "$test_root"
    "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1 || true
    "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
    rm -rf "$test_root"
  fi
  current_tracked_digest="$($sha256_bin "$tracked_source" | "$awk_bin" '{ print $1 }')"
  if [ "$current_tracked_digest" != "$tracked_digest" ]; then
    echo "buck2-invalidation-e2e: tracked fixture changed during isolated proof" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The RED/GREEN control is intentionally destructive, so execute it in a
# disposable Buck project rather than racing another worktree user by editing
# the checked-in fixture in place.
cp -p "$repo_root/.buckconfig" "$test_root/.buckconfig"
cp -R "$repo_root/buck2" "$test_root/buck2"
mkdir -p "$test_root/toolchains"
ln -s "$package_evidence_tool" "$test_root/toolchains/package-evidence-tool"
printf '{"closureIdentity":"%s","contentDigest":"%s","executionPlatform":"%s","executableStorePath":"%s","protocol":"effect-utils/buck2-package-evidence/v1","runtimeContract":"native-executable/v1","schema":"effect-utils/buck2-support-tools/v1","toolId":"package-evidence"}\n' \
  "$package_evidence_closure" "$package_evidence_digest" "$execution_platform" "$package_evidence_tool" \
  >"$test_root/toolchains/package-evidence-manifest.json"
cat >"$test_root/toolchains/exact.bzl" <<'EOF'
def _exact_tool_impl(ctx):
    return [
        DefaultInfo(),
        RunInfo(args = cmd_args([
            ctx.attrs.executable,
            "--capability-manifest", ctx.attrs.manifest,
        ])),
    ]

_exact_tool = rule(
    impl = _exact_tool_impl,
    attrs = {
        "executable": attrs.source(),
        "manifest": attrs.source(),
    },
)

def exact_tool(name, executable, manifest, **kwargs):
    _exact_tool(
        name = name,
        executable = executable,
        manifest = manifest,
        **kwargs
    )
EOF
cat >"$test_root/toolchains/BUCK" <<'EOF'
load(":exact.bzl", "exact_tool")

exact_tool(
    name = "package_evidence_tool",
    executable = "package-evidence-tool",
    manifest = "package-evidence-manifest.json",
    visibility = ["PUBLIC"],
)
EOF
baseline_source="$test_root/baseline-source.txt"
cp -p "$source_path" "$baseline_source"
irrelevant_path="$test_root/buck2/evidence/irrelevant.txt"
printf '%s\n' 'not an input of package_evidence' >"$irrelevant_path"

build_and_observe() {
  phase="$1"
  output="$($buck2_bin \
    --isolation-dir "$isolation" \
    build \
    "$target" \
    --show-full-output \
    --local-only \
    --no-remote-cache)"
  artifact="$(printf '%s\n' "$output" | "$awk_bin" '$1 == "root//buck2/evidence:package_evidence" { print $2 }')"
  [ -n "$artifact" ] && [ -f "$artifact" ] || {
    echo "buck2-invalidation-e2e: $phase did not report a materialized artifact" >&2
    return 1
  }
  what_ran="$($buck2_bin --isolation-dir "$isolation" log what-ran --format tabulated --skip-cache-hits)"
  action_count="$(printf '%s\n' "$what_ran" | "$awk_bin" -F '\t' 'NF { count += 1 } END { print count + 0 }')"
  action_set="$(printf '%s\n' "$what_ran" | "$awk_bin" -F '\t' 'NF {
    identity = $2
    sub(/ \([^)]*#[0-9a-f]+\)/, "", identity)
    print identity
  }')"
  artifact_digest="$($sha256_bin "$artifact" | "$awk_bin" '{ print $1 }')"
  printf '%s\t%s\t%s\n' "$artifact_digest" "$action_count" "$action_set"
}

assert_zero_actions() {
  phase="$1"
  count="$2"
  actions="$3"
  [ "$count" -eq 0 ] && [ -z "$actions" ] || {
    echo "buck2-invalidation-e2e: $phase ran $count actions, expected none: $actions" >&2
    exit 1
  }
}

assert_relevant_action() {
  phase="$1"
  count="$2"
  actions="$3"
  [ "$count" -eq 1 ] && [ "$actions" = "$expected_action" ] || {
    echo "buck2-invalidation-e2e: $phase action set mismatch" >&2
    echo "expected: $expected_action" >&2
    echo "actual:   $actions" >&2
    exit 1
  }
}

cd "$test_root"
IFS=$'\t' read -r baseline_digest baseline_actions baseline_action_set < <(build_and_observe baseline)
assert_relevant_action baseline "$baseline_actions" "$baseline_action_set"

IFS=$'\t' read -r warm_digest warm_actions warm_action_set < <(build_and_observe warm-noop)
assert_zero_actions warm-noop "$warm_actions" "$warm_action_set"
[ "$warm_digest" = "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: warm no-op changed artifact identity" >&2
  exit 1
}

touch -m -d '@1' "$source_path"
IFS=$'\t' read -r mtime_digest mtime_actions mtime_action_set < <(build_and_observe mtime-only)
assert_zero_actions mtime-only "$mtime_actions" "$mtime_action_set"
[ "$mtime_digest" = "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: mtime-only change changed artifact identity" >&2
  exit 1
}

printf '%s\n' "irrelevant edit $isolation" >>"$irrelevant_path"
IFS=$'\t' read -r irrelevant_digest irrelevant_actions irrelevant_action_set < <(build_and_observe irrelevant-edit)
assert_zero_actions irrelevant-edit "$irrelevant_actions" "$irrelevant_action_set"
[ "$irrelevant_digest" = "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: irrelevant edit changed artifact identity" >&2
  exit 1
}

printf '\nbuck2 invalidation probe %s\n' "$isolation" >> "$source_path"
IFS=$'\t' read -r mutated_digest mutated_actions mutated_action_set < <(build_and_observe relevant-edit)
assert_relevant_action relevant-edit "$mutated_actions" "$mutated_action_set"
[ "$mutated_digest" != "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: mutation did not change the artifact digest" >&2
  exit 1
}

cp -p "$baseline_source" "$source_path"
IFS=$'\t' read -r restored_digest restored_actions restored_action_set < <(build_and_observe restore)
assert_relevant_action restore "$restored_actions" "$restored_action_set"
[ "$restored_digest" = "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: restored artifact digest differs from baseline" >&2
  exit 1
}

echo "buck2-invalidation-e2e: PASS warm=0 mtime=0 irrelevant=0 relevant=1 restore=1 digest_restored=true"
