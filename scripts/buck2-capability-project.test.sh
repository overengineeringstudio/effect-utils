#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-capability-project.test.sh REPO_ROOT BUCK2_BIN}"
buck2_bin="${2:?usage: buck2-capability-project.test.sh REPO_ROOT BUCK2_BIN}"
mktemp_bin="${MKTEMP_BIN:-mktemp}"
uname_bin="${UNAME_BIN:-uname}"
bash_bin="${BASH_BIN:-bash}"
readlink_bin="${READLINK_BIN:-readlink}"
find_bin="${FIND_BIN:-find}"
grep_bin="${GREP_BIN:-grep}"
mkdir_bin="${MKDIR_BIN:-mkdir}"
ln_bin="${LN_BIN:-ln}"
cp_bin="${CP_BIN:-cp}"
mv_bin="${MV_BIN:-mv}"
rm_bin="${RM_BIN:-rm}"
cat_bin="${CAT_BIN:-cat}"
sed_bin="${SED_BIN:-sed}"
awk_bin="${AWK_BIN:-awk}"
sha256sum_bin="${SHA256_BIN:-sha256sum}"
cmp_bin="${CMP_BIN:-cmp}"
jq_bin="${JQ_BIN:-jq}"
fixture="$("$mktemp_bin" -d "${TMPDIR:-/tmp}/buck2-capability-project.XXXXXX")"
cleanup() {
  if [ -f "$fixture/.buckconfig" ]; then
    (cd "$fixture" && "$buck2_bin" kill >/dev/null 2>&1) || true
  fi
  "$rm_bin" -rf "$fixture"
}
trap cleanup EXIT
true_bin="$("$readlink_bin" -f "$(command -v bash)")"
false_bin="$("$readlink_bin" -f "$buck2_bin")"
case "$("$uname_bin" -s):$("$uname_bin" -m)" in
  Linux:x86_64) platform=x86_64-linux ;;
  Linux:aarch64) platform=aarch64-linux ;;
  Darwin:arm64) platform=aarch64-macos ;;
  *) echo "buck2-capability-project-test: unsupported host" >&2; exit 64 ;;
esac

project() {
  BUCK2_BIN="$buck2_bin" "$bash_bin" "$repo_root/scripts/buck2-capability-project.sh" "$fixture" "$platform" \
    fixture fixture/v1 "$1"
}

assert_no_candidates() {
  if "$find_bin" "$fixture/.buck2" -maxdepth 1 -name 'capabilities.candidate.*' -print -quit | "$grep_bin" -q .; then
    echo "buck2-capability-project-test: candidate directory leaked" >&2
    exit 1
  fi
}

"$cat_bin" >"$fixture/.buckconfig" <<'EOF'
[cells]
  root = .
  prelude = prelude
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbcode = root
  fbsource = root
  fbcode_macros = root
  buck = root
  toolchains = root
[external_cells]
  prelude = bundled
[buck2]
  file_watcher = fs_hash_crawler
[project]
  ignore = buck-out
EOF

if "$bash_bin" "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture" >"$fixture/absent.log" 2>&1; then
  echo "buck2-capability-project-test: absent projection unexpectedly passed its preflight" >&2
  exit 1
fi
"$grep_bin" -F "run 'devenv tasks run buck2:capabilities:project'" "$fixture/absent.log" >/dev/null

if project "$fixture/missing" >"$fixture/missing.log" 2>&1; then
  echo "buck2-capability-project-test: missing exact tool unexpectedly succeeded" >&2
  exit 1
fi
"$grep_bin" -F 'executable is not an exact Nix store target' "$fixture/missing.log" >/dev/null

"$mkdir_bin" -p "$fixture/.buck2/capability-generations/legacy"
"$ln_bin" -s capability-generations/legacy "$fixture/.buck2/capabilities"
: >"$fixture/BUCK"
(cd "$fixture" && "$buck2_bin" targets //... >/dev/null)
(cd "$fixture" && "$buck2_bin" --isolation-dir legacy-migration targets //... >/dev/null)
[ "$("$buck2_bin" status --all | "$jq_bin" --arg root "$("$readlink_bin" -f "$fixture")" '[.[] | select(.project_root == $root)] | length')" -eq 2 ]
project "$true_bin"
[ ! -L "$fixture/.buck2/capabilities" ]
[ -d "$fixture/.buck2/capability-generations/legacy" ]
[ "$("$buck2_bin" status --all | "$jq_bin" --arg root "$("$readlink_bin" -f "$fixture")" '[.[] | select(.project_root == $root)] | length')" -eq 0 ]
assert_no_candidates
"$bash_bin" "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture"
first="$("$sed_bin" -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")"
manifest="$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
"$jq_bin" -e --arg executable "$true_bin" '
  .schema == "effect-utils/buck2-support-tools/v1" and
  .executableStorePath == $executable and
  (.contentDigest | length) == 64
' "$manifest" >/dev/null
[ "$("$readlink_bin" -f "$fixture/.buck2/capabilities/generations/$first/$platform/fixture/executable")" = "$true_bin" ]

"$cp_bin" "$fixture/.buck2/capabilities/defs.bzl" "$fixture/defs.valid.bzl"
printf '%s\n' 'GENERATION = "not-a-digest"' >"$fixture/.buck2/capabilities/defs.bzl"
if "$bash_bin" "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture" >/dev/null 2>&1; then
  echo "buck2-capability-project-test: invalid generation unexpectedly passed its preflight" >&2
  exit 1
fi
"$mv_bin" "$fixture/defs.valid.bzl" "$fixture/.buck2/capabilities/defs.bzl"

project "$true_bin"
assert_no_candidates
[ "$("$sed_bin" -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")" = "$first" ] || {
  echo "buck2-capability-project-test: identical inputs changed the generation" >&2
  exit 1
}

pids=()
for _ in 1 2 3 4; do
  project "$true_bin" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
assert_no_candidates

"$mv_bin" "$fixture/.buck2/capabilities/generations/$first" "$fixture/.buck2/capabilities/generations/$first.real"
"$ln_bin" -s "$first.real" "$fixture/.buck2/capabilities/generations/$first"
if project "$true_bin" >"$fixture/symlink-generation.log" 2>&1; then
  echo "buck2-capability-project-test: symlink generation unexpectedly passed reuse validation" >&2
  exit 1
fi
"$grep_bin" -F 'existing generation must be a real directory' "$fixture/symlink-generation.log" >/dev/null
"$rm_bin" "$fixture/.buck2/capabilities/generations/$first"
"$mv_bin" "$fixture/.buck2/capabilities/generations/$first.real" "$fixture/.buck2/capabilities/generations/$first"

printf '%s\n' corrupted >>"$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
if project "$true_bin" >"$fixture/corrupt-generation.log" 2>&1; then
  echo "buck2-capability-project-test: corrupt real generation unexpectedly passed reuse validation" >&2
  exit 1
fi
"$grep_bin" -F 'existing generation content does not match its identity' "$fixture/corrupt-generation.log" >/dev/null
"$sed_bin" -i '$d' "$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
project "$true_bin"

"$cat_bin" >"$fixture/defs.bzl" <<EOF
load("@root//.buck2/capabilities:defs.bzl", "CAPABILITIES")
CapabilityFixtureInfo = provider(fields = {"digest": str})
def _impl(ctx):
    output = ctx.actions.declare_output("copied.txt")
    ctx.actions.run(
        cmd_args(["/bin/sh", "-c", '"\$1" --version > "\$2"', "capability-fixture", ctx.attrs.executable, output.as_output()]),
        category = "capability_fixture",
    )
    return [DefaultInfo(default_output = output), CapabilityFixtureInfo(digest = ctx.attrs.digest)]
_capability_fixture = rule(impl = _impl, attrs = {
    "digest": attrs.string(),
    "executable": attrs.source(),
})
def capability_fixture(name):
    metadata = CAPABILITIES["$platform"]["fixture"]
    base = "root//.buck2/capabilities/generations/{}/$platform/fixture".format(metadata["generation"])
    _capability_fixture(
        name = name,
        digest = metadata["contentDigest"],
        executable = base + ":executable",
    )
EOF
"$cat_bin" >"$fixture/BUCK" <<'EOF'
load(":defs.bzl", "capability_fixture")
capability_fixture(name = "capability")
EOF
first_audit="$(cd "$fixture" && "$buck2_bin" audit providers --target-platforms prelude//platforms:default //:capability --print-debug)"
first_digest="$("$sha256sum_bin" "$true_bin" | "$awk_bin" '{print $1}')"
printf '%s\n' "$first_audit" | "$grep_bin" -F "$first_digest" >/dev/null
first_output="$(cd "$fixture" && "$buck2_bin" build --show-output --target-platforms prelude//platforms:default //:capability | "$awk_bin" 'END {print $2}')"
"$grep_bin" -Fi bash "$fixture/$first_output" >/dev/null
"$cp_bin" "$fixture/$first_output" "$fixture/action-a.txt"
daemon_id="$(cd "$fixture" && "$buck2_bin" status | "$jq_bin" -r .daemon_constraints.daemon_id)"

project "$false_bin"
assert_no_candidates
second="$("$sed_bin" -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")"
[ "$second" != "$first" ] || {
  echo "buck2-capability-project-test: changed Nix target did not invalidate the generation" >&2
  exit 1
}
second_audit="$(cd "$fixture" && "$buck2_bin" audit providers --target-platforms prelude//platforms:default //:capability --print-debug)"
second_digest="$("$sha256sum_bin" "$false_bin" | "$awk_bin" '{print $1}')"
printf '%s\n' "$second_audit" | "$grep_bin" -F "$second_digest" >/dev/null
if printf '%s\n' "$second_audit" | "$grep_bin" -F "$first_digest" >/dev/null; then
  echo "buck2-capability-project-test: same daemon retained the old capability generation" >&2
  exit 1
fi
second_output="$(cd "$fixture" && "$buck2_bin" build --show-output --target-platforms prelude//platforms:default //:capability | "$awk_bin" 'END {print $2}')"
"$grep_bin" -Fi buck2 "$fixture/$second_output" >/dev/null
"$cp_bin" "$fixture/$second_output" "$fixture/action-b.txt"
"$cmp_bin" -s "$fixture/action-a.txt" "$fixture/action-b.txt" && {
  echo "buck2-capability-project-test: changed capability did not change the action result" >&2
  exit 1
}
"$grep_bin" -Fi bash "$fixture/action-a.txt" >/dev/null
"$grep_bin" -Fi buck2 "$fixture/action-b.txt" >/dev/null
[ "$(cd "$fixture" && "$buck2_bin" status | "$jq_bin" -r .daemon_constraints.daemon_id)" = "$daemon_id" ] || {
  echo "buck2-capability-project-test: daemon restarted between capability generations" >&2
  exit 1
}
[ -d "$fixture/.buck2/capabilities/generations/$first" ]
[ -d "$fixture/.buck2/capabilities/generations/$second" ]

echo "buck2-capability-project-test: PASS"
