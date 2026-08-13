#!/usr/bin/env bash
set -euo pipefail

if [ "${1-}" = --check ]; then
  root="${2:?usage: buck2-capability-project.sh --check ROOT}"
  [ -f "$root/.buck2/capabilities/defs.bzl" ] || {
    echo "buck2-capability-project: projection is absent; run 'devenv tasks run buck2:capabilities:project' before direct Buck invocation" >&2
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
generations="$root/.buck2/capability-generations"
projection="$root/.buck2/capabilities"
cleanup() { rm -rf "$candidate" "$root/.buck2/capabilities.link.$$"; }
trap cleanup EXIT
mkdir -p "$candidate/$platform"
printf '%s\n' '# Generated from exact Nix realizations.' >"$candidate/BUCK"
printf '%s\n' 'CAPABILITIES = {' "  \"$platform\": {" >"$candidate/defs.bzl"

while [ "$#" -gt 0 ]; do
  tool_id="$1" protocol="$2" executable="$(readlink -f "$3")"
  shift 3
  case "$executable" in /nix/store/*/bin/*) ;; *) echo "buck2-capability-project: executable is not an exact Nix store target: $executable" >&2; exit 64 ;; esac
  [ -x "$executable" ] || { echo "buck2-capability-project: executable is unavailable: $executable" >&2; exit 64; }
  closure_identity="$(dirname "$(dirname "$executable")")"
  digest="$(sha256sum "$executable" | awk '{print $1}')"
  directory="$candidate/$platform/$tool_id"
  mkdir -p "$directory"
  ln -s "$executable" "$directory/executable"
  jq -cnS --arg schema effect-utils/buck2-support-tools/v1 \
    --arg toolId "$tool_id" --arg protocol "$protocol" \
    --arg contentDigest "$digest" --arg closureIdentity "$closure_identity" \
    --arg executableStorePath "$executable" --arg executionPlatform "$platform" \
    --arg runtimeContract native-executable/v1 \
    '{schema:$schema,toolId:$toolId,protocol:$protocol,contentDigest:$contentDigest,closureIdentity:$closureIdentity,executableStorePath:$executableStorePath,executionPlatform:$executionPlatform,runtimeContract:$runtimeContract}' \
    >"$directory/manifest.json"
  printf '%s\n' 'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])' 'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])' >"$directory/BUCK"
  printf '    "%s": {"contentDigest": "%s", "closureIdentity": "%s", "executableStorePath": "%s"},\n' "$tool_id" "$digest" "$closure_identity" "$executable" >>"$candidate/defs.bzl"
done
printf '%s\n' '  },' '}' >>"$candidate/defs.bzl"

generation="$(cd "$candidate" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
mkdir -p "$generations"
exec 9>"$generations/.projection.lock"
flock 9
if [ -d "$generations/$generation" ]; then
  rm -rf "$candidate"
else
  mv "$candidate" "$generations/$generation"
fi
ln -s "capability-generations/$generation" "$root/.buck2/capabilities.link.$$"
mv -Tf "$root/.buck2/capabilities.link.$$" "$projection"
cleanup
trap - EXIT
