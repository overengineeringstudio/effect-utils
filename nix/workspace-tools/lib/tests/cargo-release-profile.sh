#!/usr/bin/env bash
# The native-product release profile must follow Cargo's resolved release
# profile, including Cargo's implicit debuginfo strip when debug is off.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export CARGO_RELEASE_PROFILE_REPO="$repo_root"
python="$(nix build --impure --no-link --print-out-paths --expr '
  let
    flake = builtins.getFlake ("git+file://" + builtins.getEnv "CARGO_RELEASE_PROFILE_REPO");
  in (import flake.inputs.nixpkgs { system = builtins.currentSystem; }).python3
')/bin/python3"
script="$repo_root/nix/workspace-tools/lib/cargo-release-profile.py"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

# Prints the rust_profile.strip and rust_profile.debug values for a manifest body.
resolved() {
  printf '%s\n' "$1" > "$fixture/Cargo.toml"
  "$python" "$script" "$fixture/Cargo.toml" | grep -E '^rust_profile\.(strip|debug)=' | sort | tr '\n' ' '
}

expect() {
  local name="$1" manifest="$2" want="$3" got
  got="$(resolved "$manifest")"
  if [[ "$got" != "$want" ]]; then
    printf 'cargo-release-profile %s: expected "%s", got "%s"\n' "$name" "$want" "$got" >&2
    exit 1
  fi
}

expect 'absent profile' '[workspace]' 'rust_profile.debug=0 rust_profile.strip=debuginfo '
expect 'debug off' $'[profile.release]\ndebug = false' 'rust_profile.debug=0 rust_profile.strip=debuginfo '
expect 'debug "none"' $'[profile.release]\ndebug = "none"' 'rust_profile.debug=none rust_profile.strip=debuginfo '
expect 'debug on' $'[profile.release]\ndebug = true' 'rust_profile.debug=2 rust_profile.strip=none '
expect 'line tables' $'[profile.release]\ndebug = "line-tables-only"' 'rust_profile.debug=line-tables-only rust_profile.strip=none '
expect 'strip false' $'[profile.release]\nstrip = false' 'rust_profile.debug=0 rust_profile.strip=none '
expect 'strip true' $'[profile.release]\nstrip = true' 'rust_profile.debug=0 rust_profile.strip=symbols '
expect 'strip named' $'[profile.release]\ndebug = 1\nstrip = "debuginfo"' 'rust_profile.debug=1 rust_profile.strip=debuginfo '

printf 'cargo release profile bridge passed\n'
