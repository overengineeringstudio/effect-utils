#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-capability-project.test.sh REPO_ROOT}"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/buck2-capability-project.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
true_bin="$(readlink -f "$(command -v sha256sum)")"
false_bin="$(readlink -f "$(command -v jq)")"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=x86_64-linux ;;
  Linux:aarch64) platform=aarch64-linux ;;
  Darwin:arm64) platform=aarch64-macos ;;
  *) echo "buck2-capability-project-test: unsupported host" >&2; exit 64 ;;
esac

project() {
  bash "$repo_root/scripts/buck2-capability-project.sh" "$fixture" "$platform" \
    fixture fixture/v1 "$1"
}

assert_no_candidates() {
  if find "$fixture/.buck2" -maxdepth 1 -name 'capabilities.candidate.*' -print -quit | grep -q .; then
    echo "buck2-capability-project-test: candidate directory leaked" >&2
    exit 1
  fi
}

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

project "$true_bin"
assert_no_candidates
bash "$repo_root/scripts/buck2-capability-project.sh" --check "$fixture"
first="$(readlink "$fixture/.buck2/capabilities")"
manifest="$fixture/.buck2/capabilities/$platform/fixture/manifest.json"
jq -e --arg executable "$true_bin" '
  .schema == "effect-utils/buck2-support-tools/v1" and
  .executableStorePath == $executable and
  (.contentDigest | length) == 64
' "$manifest" >/dev/null
[ "$(readlink -f "$fixture/.buck2/capabilities/$platform/fixture/executable")" = "$true_bin" ]

project "$true_bin"
assert_no_candidates
[ "$(readlink "$fixture/.buck2/capabilities")" = "$first" ] || {
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
[ "$(find "$fixture/.buck2/capability-generations" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ] || {
  echo "buck2-capability-project-test: concurrent identical projection created extra generations" >&2
  exit 1
}

project "$false_bin"
assert_no_candidates
[ "$(readlink "$fixture/.buck2/capabilities")" != "$first" ] || {
  echo "buck2-capability-project-test: changed Nix target did not invalidate the generation" >&2
  exit 1
}

echo "buck2-capability-project-test: PASS"
