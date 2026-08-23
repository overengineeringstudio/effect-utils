#!/usr/bin/env bash
set -euo pipefail

gawk_bin="${GAWK_BIN:-gawk}"
awk_bin="${AWK_BIN:-awk}"
grep_bin="${GREP_BIN:-grep}"
jq_bin="${JQ_BIN:-jq}"
mkdir_bin="${MKDIR_BIN:-mkdir}"
rm_bin="${RM_BIN:-rm}"
mv_bin="${MV_BIN:-mv}"
ln_bin="${LN_BIN:-ln}"
readlink_bin="${READLINK_BIN:-readlink}"
dirname_bin="${DIRNAME_BIN:-dirname}"
basename_bin="${BASENAME_BIN:-basename}"
sha256sum_bin="${SHA256_BIN:-sha256sum}"
sort_bin="${SORT_BIN:-sort}"
xargs_bin="${XARGS_BIN:-xargs}"
find_bin="${FIND_BIN:-find}"
flock_bin="${FLOCK_BIN:-flock}"
diff_bin="${DIFF_BIN:-diff}"

if [ "${1-}" = --check ]; then
  root="${2:?usage: buck2-capability-project.sh --check ROOT}"
  [ -d "$root/.buck2/capabilities" ] &&
    [ ! -L "$root/.buck2/capabilities" ] &&
    [ -f "$root/.buck2/capabilities/defs.bzl" ] || {
    echo "buck2-capability-project: projection is absent; run 'devenv tasks run buck2:capabilities:project' before direct Buck invocation" >&2
    exit 66
  }
  generation="$("$gawk_bin" 'match($0, /^GENERATION = "([^"]*)"$/, m) { print m[1] }' "$root/.buck2/capabilities/defs.bzl")"
  printf '%s\n' "$generation" | "$grep_bin" -Eq '^[0-9a-f]{64}$' || {
    echo "buck2-capability-project: active projection generation is invalid" >&2
    exit 66
  }
  [ -d "$root/.buck2/capabilities/generations/$generation" ] &&
    [ ! -L "$root/.buck2/capabilities/generations/$generation" ] || {
    echo "buck2-capability-project: active projection generation is absent" >&2
    exit 66
  }
  exit 0
fi

root="${1:?usage: buck2-capability-project.sh ROOT PLATFORM TOOL_ID PROTOCOL EXECUTABLE [...] }"
platform="${2:?usage: buck2-capability-project.sh ROOT PLATFORM TOOL_ID PROTOCOL EXECUTABLE [...] }"
shift 2
[ $(( $# % 3 )) -eq 0 ] || { echo "buck2-capability-project: tool arguments must be triples" >&2; exit 64; }
case "$platform" in x86_64-linux|aarch64-linux|aarch64-macos) ;; *) echo "buck2-capability-project: unsupported platform: $platform" >&2; exit 64 ;; esac

candidate="$root/.buck2/capabilities.candidate.$$"
projection="$root/.buck2/capabilities"
lock="$root/.buck2/capabilities.lock"
cleanup() { "$rm_bin" -rf "$candidate"; }
trap cleanup EXIT
"$mkdir_bin" -p "$candidate/payload/$platform"
printf '%s\n' '# Generated from exact Nix realizations.' >"$candidate/BUCK"

while [ "$#" -gt 0 ]; do
  tool_id="$1" protocol="$2" executable="$("$readlink_bin" -f "$3")"
  shift 3
  case "$executable" in /nix/store/*/bin/*) ;; *) echo "buck2-capability-project: executable is not an exact Nix store target: $executable" >&2; exit 64 ;; esac
  [ -x "$executable" ] || { echo "buck2-capability-project: executable is unavailable: $executable" >&2; exit 64; }
  closure_identity="$("$dirname_bin" "$("$dirname_bin" "$executable")")"
  digest="$("$sha256sum_bin" "$executable" | "$awk_bin" '{print $1}')"
  directory="$candidate/payload/$platform/$tool_id"
  "$mkdir_bin" -p "$directory"
  "$ln_bin" -s "$executable" "$directory/executable"
  "$jq_bin" -cnS --arg schema effect-utils/buck2-support-tools/v1 \
    --arg toolId "$tool_id" --arg protocol "$protocol" \
    --arg contentDigest "$digest" --arg closureIdentity "$closure_identity" \
    --arg executableStorePath "$executable" --arg executionPlatform "$platform" \
    --arg runtimeContract native-executable/v1 \
    '{schema:$schema,toolId:$toolId,protocol:$protocol,contentDigest:$contentDigest,closureIdentity:$closureIdentity,executableStorePath:$executableStorePath,executionPlatform:$executionPlatform,runtimeContract:$runtimeContract}' \
    >"$directory/manifest.json"
  printf '%s\n' 'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])' 'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])' >"$directory/BUCK"
done

generation="$(cd "$candidate/payload" && "$find_bin" . -type f -print0 | "$sort_bin" -z | "$xargs_bin" -0 "$sha256sum_bin" | "$sha256sum_bin" | "$awk_bin" '{print $1}')"
printf '%s\n' "$generation" | "$grep_bin" -Eq '^[0-9a-f]{64}$' || {
  echo "buck2-capability-project: computed generation is not 64 lowercase hexadecimal characters" >&2
  exit 65
}
"$mkdir_bin" -p "$candidate/generations"
"$mv_bin" "$candidate/payload" "$candidate/generations/$generation"
printf '%s\n' "GENERATION = \"$generation\"" 'CAPABILITIES = {' "  \"$platform\": {" >"$candidate/defs.bzl"
for source_dir in "$candidate/generations/$generation/$platform"/*; do
  [ -d "$source_dir" ] || continue
  tool_id="$("$basename_bin" "$source_dir")"
  manifest="$source_dir/manifest.json"
  printf '    "%s": {"generation": "%s", "contentDigest": "%s", "closureIdentity": "%s", "executableStorePath": "%s"},\n' \
    "$tool_id" "$generation" \
    "$("$jq_bin" -r .contentDigest "$manifest")" \
    "$("$jq_bin" -r .closureIdentity "$manifest")" \
    "$("$jq_bin" -r .executableStorePath "$manifest")" >>"$candidate/defs.bzl"
done
printf '%s\n' '  },' '}' >>"$candidate/defs.bzl"
"$mkdir_bin" -p "$root/.buck2"
exec 9>"$lock"
"$flock_bin" 9

if [ -L "$projection" ]; then
  [ -n "${BUCK2_BIN-}" ] || {
    echo "buck2-capability-project: legacy symlink projection requires BUCK2_BIN for one-time daemon migration" >&2
    exit 65
  }
  canonical_root="$("$readlink_bin" -f "$root")"
  daemon_status="$candidate/daemon-status.json"
  "$BUCK2_BIN" status --all >"$daemon_status"
  "$jq_bin" -e 'type == "array"' "$daemon_status" >/dev/null
  while IFS= read -r isolation; do
    [ -n "$isolation" ] || continue
    (cd "$root" && "$BUCK2_BIN" --isolation-dir "$isolation" kill >/dev/null)
  done < <(
    "$jq_bin" -r --arg root "$canonical_root" '.[] | select(.project_root == $root) | .isolation_dir' "$daemon_status"
  )
  "$rm_bin" "$projection"
fi

# Keep the capability cell at one stable path for the lifetime of the Buck
# daemon. A complete immutable generation is present before defs.bzl switches
# authority, so concurrent analyses resolve either the complete old generation
# or the complete new generation.
"$mkdir_bin" -p "$projection/generations"
if [ -d "$projection/generations/$generation" ]; then
  [ ! -L "$projection/generations/$generation" ] || {
    echo "buck2-capability-project: existing generation must be a real directory" >&2
    exit 65
  }
  "$diff_bin" --no-dereference --recursive --brief \
    "$candidate/generations/$generation" \
    "$projection/generations/$generation" >/dev/null || {
    echo "buck2-capability-project: existing generation content does not match its identity" >&2
    exit 65
  }
  "$rm_bin" -rf "$candidate/generations/$generation"
else
  "$mv_bin" "$candidate/generations/$generation" "$projection/generations/$generation"
fi
"$mv_bin" -Tf "$candidate/BUCK" "$projection/BUCK"
"$mv_bin" -Tf "$candidate/defs.bzl" "$projection/defs.bzl"
cleanup
trap - EXIT
