#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"
fixture="$(mktemp -d)"
trap 'find "$fixture" -depth -delete' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

install_script() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ ];
        installFlags = [ \"--offline\" ];
        $1
      }) {
        inherit pkgs;
        lib = pkgs.lib;
        config.devenv.root = \"$fixture\";
      };
    in module.tasks.\"pnpm:install\".exec
  "
}

record_pnpm() { printf '%s\n' "$@" > "$fixture/argv"; }
PNPM_NATIVE_BIN=record_pnpm
PNPM_PACKAGE_IMPORT_METHOD=auto
npm_config_store_dir=fixture-store
pnpm_policy_flags=(--ignore-scripts)
export CI_DIAGNOSTICS_DIR="$fixture/diagnostics"

for mode in frozen frozen-in-ci unfrozen legacy-true legacy-false default; do
  case "$mode" in
    legacy-true) options='frozenInCi = true;' ;;
    legacy-false) options='frozenInCi = false;' ;;
    default) options='' ;;
    *) options="lockfileMode = \"$mode\";" ;;
  esac
  script="$(install_script "$options")"
  # Select the unescaped fallback body after trace.exec's shell-quoted copy.
  functions="reject_impure_pnpm_install_args() ${script##*reject_impure_pnpm_install_args() }"
  functions="${functions%%# The Materialization Root must be its own pnpm workspace boundary.*}"
  [[ "$functions" == *'run_pnpm_install()'* ]] || fail 'install function not found'
  eval "$functions"
  for ci in unset empty 1 0; do
    if [[ "$ci" == unset ]]; then unset CI; else export CI="${ci/empty/}"; fi
    expected=--frozen-lockfile
    if [[ "$mode" == unfrozen || "$mode" == legacy-false ]] ||
      [[ "$mode" == frozen-in-ci && ( "$ci" == unset || "$ci" == empty ) ]]; then
      expected=--no-frozen-lockfile
    fi
    run_pnpm_install --reporter=append-only
    argv="$(cat "$fixture/argv")"
    [[ "$argv" == *$'\n'"$expected"$'\n'* ]] || fail "$mode CI=$ci missing $expected: $argv"
    if [[ "$expected" == --frozen-lockfile ]]; then opposite=--no-frozen-lockfile; else opposite=--frozen-lockfile; fi
    [[ "$argv" != *$'\n'"$opposite"$'\n'* ]] || fail "$mode CI=$ci has conflicting flags"
    [[ "$argv" == $'install\n--reporter=append-only\n--offline\n'"$expected"$'\n--ignore-scripts\n--config.package-import-method=auto\n--config.store-dir=fixture-store' ]] || fail 'install argv changed'
    printf 'PASS: %s CI=%s argv: %s\n' "$mode" "$ci" "${argv//$'\n'/ }"
  done
  case "$mode" in
    frozen) frozen_functions="$functions" ;;
    unfrozen) unfrozen_functions="$functions" ;;
    legacy-true|default) [[ "$functions" == "$frozen_functions" ]] || fail 'legacy frozen shell changed' ;;
    legacy-false) [[ "$functions" == "$unfrozen_functions" ]] || fail 'legacy unfrozen shell changed' ;;
  esac
done

for options in 'lockfileMode = "invalid";' 'lockfileMode = "frozen-in-ci"; frozenInCi = true;' 'lockfileMode = "unfrozen"; frozenInCi = false;'; do
  if install_script "$options" > "$fixture/invalid" 2>&1; then
    fail "invalid options accepted: $options"
  fi
done
printf 'PASS: legacy/default install shell is byte-identical to explicit frozen/unfrozen; invalid/conflicting options rejected\n'
