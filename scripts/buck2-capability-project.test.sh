#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-capability-project.test.sh REPO_ROOT BUCK2_BIN}"
buck2_bin="${2:?usage: buck2-capability-project.test.sh REPO_ROOT BUCK2_BIN}"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/buck2-capability-project.XXXXXX")"
cleanup() {
  if [ -f "$fixture/.buckconfig" ]; then
    (cd "$fixture" && "$buck2_bin" kill >/dev/null 2>&1) || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
true_bin="$(readlink -f "$(command -v bash)")"
false_bin="$(readlink -f "$buck2_bin")"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=x86_64-linux ;;
  Linux:aarch64) platform=aarch64-linux ;;
  Darwin:arm64) platform=aarch64-macos ;;
  *) echo "buck2-capability-project-test: unsupported host" >&2; exit 64 ;;
esac

project() {
  BUCK2_BIN="$buck2_bin" bash "$repo_root/scripts/buck2-capability-project.sh" "$fixture" "$platform" \
    fixture fixture/v1 "$1"
}

assert_no_candidates() {
  if find "$fixture/.buck2" -maxdepth 1 -name 'capabilities.candidate.*' -print -quit | grep -q .; then
    echo "buck2-capability-project-test: candidate directory leaked" >&2
    exit 1
  fi
}

cat >"$fixture/.buckconfig" <<'EOF'
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

if bash "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture" >"$fixture/absent.log" 2>&1; then
  echo "buck2-capability-project-test: absent projection unexpectedly passed its preflight" >&2
  exit 1
fi
grep -F "run 'devenv tasks run buck2:capabilities:project'" "$fixture/absent.log" >/dev/null

if project "$fixture/missing" >"$fixture/missing.log" 2>&1; then
  echo "buck2-capability-project-test: missing exact tool unexpectedly succeeded" >&2
  exit 1
fi
grep -F 'executable is not an exact Nix store target' "$fixture/missing.log" >/dev/null

mkdir -p "$fixture/.buck2/capability-generations/legacy"
ln -s capability-generations/legacy "$fixture/.buck2/capabilities"
: >"$fixture/BUCK"
(cd "$fixture" && "$buck2_bin" targets //... >/dev/null)
(cd "$fixture" && "$buck2_bin" --isolation-dir legacy-migration targets //... >/dev/null)
[ "$("$buck2_bin" status --all | jq --arg root "$(readlink -f "$fixture")" '[.[] | select(.project_root == $root)] | length')" -eq 2 ]
project "$true_bin"
[ ! -L "$fixture/.buck2/capabilities" ]
[ -d "$fixture/.buck2/capability-generations/legacy" ]
[ "$("$buck2_bin" status --all | jq --arg root "$(readlink -f "$fixture")" '[.[] | select(.project_root == $root)] | length')" -eq 0 ]
assert_no_candidates
bash "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture"
first="$(sed -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")"
manifest="$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
jq -e --arg executable "$true_bin" '
  .schema == "effect-utils/buck2-support-tools/v1" and
  .executableStorePath == $executable and
  (.contentDigest | length) == 64
' "$manifest" >/dev/null
[ "$(readlink -f "$fixture/.buck2/capabilities/generations/$first/$platform/fixture/executable")" = "$true_bin" ]

cp "$fixture/.buck2/capabilities/defs.bzl" "$fixture/defs.valid.bzl"
printf '%s\n' 'GENERATION = "not-a-digest"' >"$fixture/.buck2/capabilities/defs.bzl"
if bash "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture" >/dev/null 2>&1; then
  echo "buck2-capability-project-test: invalid generation unexpectedly passed its preflight" >&2
  exit 1
fi
mv "$fixture/defs.valid.bzl" "$fixture/.buck2/capabilities/defs.bzl"

project "$true_bin"
assert_no_candidates
[ "$(sed -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")" = "$first" ] || {
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

mv "$fixture/.buck2/capabilities/generations/$first" "$fixture/.buck2/capabilities/generations/$first.real"
ln -s "$first.real" "$fixture/.buck2/capabilities/generations/$first"
if project "$true_bin" >"$fixture/symlink-generation.log" 2>&1; then
  echo "buck2-capability-project-test: symlink generation unexpectedly passed reuse validation" >&2
  exit 1
fi
grep -F 'existing generation must be a real directory' "$fixture/symlink-generation.log" >/dev/null
rm "$fixture/.buck2/capabilities/generations/$first"
mv "$fixture/.buck2/capabilities/generations/$first.real" "$fixture/.buck2/capabilities/generations/$first"

printf '%s\n' corrupted >>"$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
if project "$true_bin" >"$fixture/corrupt-generation.log" 2>&1; then
  echo "buck2-capability-project-test: corrupt real generation unexpectedly passed reuse validation" >&2
  exit 1
fi
grep -F 'existing generation content does not match its identity' "$fixture/corrupt-generation.log" >/dev/null
sed -i '$d' "$fixture/.buck2/capabilities/generations/$first/$platform/fixture/manifest.json"
project "$true_bin"

cat >"$fixture/defs.bzl" <<EOF
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
cat >"$fixture/BUCK" <<'EOF'
load(":defs.bzl", "capability_fixture")
capability_fixture(name = "capability")
EOF
first_audit="$(cd "$fixture" && "$buck2_bin" audit providers --target-platforms prelude//platforms:default //:capability --print-debug)"
first_digest="$(sha256sum "$true_bin" | awk '{print $1}')"
printf '%s\n' "$first_audit" | grep -F "$first_digest" >/dev/null
first_output="$(cd "$fixture" && "$buck2_bin" build --show-output --target-platforms prelude//platforms:default //:capability | awk 'END {print $2}')"
grep -Fi bash "$fixture/$first_output" >/dev/null
cp "$fixture/$first_output" "$fixture/action-a.txt"
daemon_id="$(cd "$fixture" && "$buck2_bin" status | jq -r .daemon_constraints.daemon_id)"

project "$false_bin"
assert_no_candidates
second="$(sed -n 's/^GENERATION = "\([^"]*\)"$/\1/p' "$fixture/.buck2/capabilities/defs.bzl")"
[ "$second" != "$first" ] || {
  echo "buck2-capability-project-test: changed Nix target did not invalidate the generation" >&2
  exit 1
}
second_audit="$(cd "$fixture" && "$buck2_bin" audit providers --target-platforms prelude//platforms:default //:capability --print-debug)"
second_digest="$(sha256sum "$false_bin" | awk '{print $1}')"
printf '%s\n' "$second_audit" | grep -F "$second_digest" >/dev/null
if printf '%s\n' "$second_audit" | grep -F "$first_digest" >/dev/null; then
  echo "buck2-capability-project-test: same daemon retained the old capability generation" >&2
  exit 1
fi
second_output="$(cd "$fixture" && "$buck2_bin" build --show-output --target-platforms prelude//platforms:default //:capability | awk 'END {print $2}')"
grep -Fi buck2 "$fixture/$second_output" >/dev/null
cp "$fixture/$second_output" "$fixture/action-b.txt"
cmp -s "$fixture/action-a.txt" "$fixture/action-b.txt" && {
  echo "buck2-capability-project-test: changed capability did not change the action result" >&2
  exit 1
}
grep -Fi bash "$fixture/action-a.txt" >/dev/null
grep -Fi buck2 "$fixture/action-b.txt" >/dev/null
[ "$(cd "$fixture" && "$buck2_bin" status | jq -r .daemon_constraints.daemon_id)" = "$daemon_id" ] || {
  echo "buck2-capability-project-test: daemon restarted between capability generations" >&2
  exit 1
}
[ -d "$fixture/.buck2/capabilities/generations/$first" ]
[ -d "$fixture/.buck2/capabilities/generations/$second" ]

echo "buck2-capability-project-test: PASS"
