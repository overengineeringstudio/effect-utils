#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"
tmpdir="$(realpath "$(mktemp -d)")"
trap 'rm -rf "$tmpdir"' EXIT
export HOME="$tmpdir/home"
export PNPM_SHARED_STORE_DIR="$tmpdir/store"
export PNPM_MIN_FREE_KIB=0
unset CI GITHUB_ACTIONS PNPM_JOB_LOCAL_STORE PNPM_HOME

# A real package tarball makes the test offline, while exercising pnpm's actual
# graph-hashed projection rather than a command-recording stub.
mkdir -p "$tmpdir/package" "$HOME" "$tmpdir/bin"
printf '{"name":"gvs-fixture","version":"1.0.0","main":"index.cjs","files":["index.cjs"]}\n' > "$tmpdir/package/package.json"
printf 'module.exports = 42\n' > "$tmpdir/package/index.cjs"
tar -czf "$tmpdir/fixture.tgz" -C "$tmpdir" package

pnpm_bin="${REAL_PNPM_BIN:-$(nix build --impure --no-link --print-out-paths --expr "let flake = builtins.getFlake \"$NIX_FLAKE_REF\"; pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in import $ROOT/nix/pnpm.nix { inherit pkgs; }")/bin/pnpm}"
ln -s "$pnpm_bin" "$tmpdir/bin/pnpm"
export PATH="$tmpdir/bin:$PATH"

# Shell entry runs without task guard passthrough. Keep a real guard first on
# PATH there to prove policy reads bypass it via the supplied native pin.
guard_bin="$(nix build --impure --no-link --print-out-paths --expr "
  let flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in (import $ROOT/nix/devenv-modules/tasks/lib/cli-guard.nix { inherit pkgs; }).mkCliGuard {
    cli = \"pnpm\"; realBin = \"$pnpm_bin\";
    tasks = [ { task = \"pnpm:install\"; } ];
  }
")/bin"

extract_script() {
  local root="$1" mode="$2" attr="$3" task="${4:-pnpm:install}"
  local install_flags="${5:-[ ]}"
  nix-instantiate --eval --read-write-mode --strict --json --expr "
    let flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ \".\" ]; globalVirtualStore = $mode;
        pnpmPkg = \"$pnpm_bin\";
        installFlags = $install_flags;
      }) {
        pkgs = pkgs // { writeText = name: text: builtins.toFile name text; };
        lib = pkgs.lib; config.devenv.root = \"$root\";
      };
    in if \"$attr\" == \"enterShell\" then module.enterShell.content else module.tasks.\"$task\".$attr
  " | jq -r . > "$tmpdir/$mode-$attr-${task##*:}.sh"
}

check_guarded_shell_policy() (
  local root="$1" expected_gvs="$2"
  extract_script "$root" true enterShell
  export PATH="$guard_bin:$PATH"
  unset DEVENV_TASK_PASSTHROUGH
  cd "$root"
  if pnpm config get frozen-store >/dev/null 2>&1; then
    echo 'Expected the ambient task guard to reject direct shell invocation'
    exit 1
  fi
  source "$tmpdir/true-enterShell-install.sh"
  test "$PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE" = "$expected_gvs"
  test "$PNPM_STORE_DIR" = "$PNPM_SHARED_STORE_DIR"
  echo "guarded enterShell: GVS=$expected_gvs; native policy probe bypassed guard without passthrough"
)

for name in first second ci local; do
  root="$tmpdir/$name"
  mkdir -p "$root"
  printf '{"name":"%s","private":true,"dependencies":{"gvs-fixture":"file:%s/fixture.tgz"}}\n' "$name" "$tmpdir" > "$root/package.json"
  # The CI/default cases must override even an authored YAML opt-in.
  printf 'packages: []\nnodeLinker: isolated\nenableGlobalVirtualStore: true\n' > "$root/pnpm-workspace.yaml"
  printf '{}\n' > "$root/pnpm-install-contract.json"
  (cd "$root"; PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false "$pnpm_bin" install --lockfile-only --ignore-scripts --store-dir "$tmpdir/lock-store")
  mode=true
  [ "$name" != local ] || mode=false
  extract_script "$root" "$mode" exec
  extract_script "$root" "$mode" status
  extract_script "$root" "$mode" exec pnpm:doctor
  if [ "$name" = ci ]; then export CI=1 GITHUB_ACTIONS=true; else unset CI GITHUB_ACTIONS; fi
  # Ambient configuration must not defeat the selected policy.
  export PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=true
  bash "$tmpdir/$mode-exec-install.sh"
  bash "$tmpdir/$mode-status-install.sh"
  if [ "$name" = first ]; then check_guarded_shell_policy "$root" true; fi
  DEVENV_SETUP_OUTER_CACHE_HIT=1 bash "$tmpdir/$mode-status-install.sh"
  if [ "$name" = first ]; then
    extract_script "$root" false status
    if DEVENV_SETUP_OUTER_CACHE_HIT=1 bash "$tmpdir/false-status-install.sh"; then
      echo 'Changed GVS policy incorrectly reused an existing health receipt'
      exit 1
    fi
  fi
  decision="$(bash "$tmpdir/$mode-exec-doctor.sh" | jq -r .decision)"
  test "$decision" = healthy
  (cd "$root"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
  target="$(realpath "$root/node_modules/gvs-fixture")"
  metadata_store="$(realpath -m "$root/node_modules/$(jq -r .virtualStoreDir "$root/node_modules/.modules.yaml")")"
  cache_store="$(jq -r .storeDir "$root/node_modules/.modules.yaml")"
  actual_store="$(cd "$root"; PNPM_CONFIG_STORE_DIR="${cache_store%/v11}" "$pnpm_bin" store path)"
  test "$actual_store" = "$cache_store"
  if [ "$name" = ci ]; then
    test "$actual_store" = "$root/.devenv/pnpm-store-pure-v1/v11"
  else
    test "$actual_store" = "$PNPM_SHARED_STORE_DIR/v11"
  fi
  if [ "$name" = ci ] || [ "$name" = local ]; then
    case "$target" in "$root/node_modules/.pnpm/"*) ;; *) echo "Expected root-local projection: $target"; exit 1 ;; esac
    test "$metadata_store" = "$root/node_modules/.pnpm"
  else
    case "$target" in "$PNPM_SHARED_STORE_DIR/v11/links/"*) ;; *) echo "Expected GVS projection: $target"; exit 1 ;; esac
    test "$metadata_store" = "$PNPM_SHARED_STORE_DIR/v11/links"
    if [ "$name" = first ]; then first_target="$target"; else test "$target" = "$first_target"; fi
  fi
  echo "$name: effective projection and runtime import passed"
done

# Reproduce an offline reader switching an existing GVS projection to a local
# one. This also exercises stale-projection repair: --force is incompatible
# with frozenStore even after the old node_modules has been purged.
export XDG_CONFIG_HOME="$tmpdir/frozen-xdg"
mkdir -p "$XDG_CONFIG_HOME/pnpm"
printf 'offline: true\nfrozenLockfile: true\nfrozenStore: true\n' > "$XDG_CONFIG_HOME/pnpm/config.yaml"
check_guarded_shell_policy "$tmpdir/first" false
extract_script "$tmpdir/first" true exec
extract_script "$tmpdir/first" true status
bash "$tmpdir/true-exec-install.sh"
bash "$tmpdir/true-status-install.sh"
target="$(realpath "$tmpdir/first/node_modules/gvs-fixture")"
case "$target" in "$tmpdir/first/node_modules/.pnpm/"*) ;; *) echo "Expected frozen root-local projection: $target"; exit 1 ;; esac
test "$(jq -r .storeDir "$tmpdir/first/node_modules/.modules.yaml")" = "$PNPM_SHARED_STORE_DIR/v11"
test -d "$first_target"
(cd "$tmpdir/first"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
(cd "$tmpdir/second"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
echo 'frozen-store: existing GVS root rematerialized locally from the shared CAS'

# The same root must return to GVS when per-install policy explicitly allows
# writes, even while its global configuration remains frozen.
extract_script "$tmpdir/first" true exec pnpm:install '[ "--frozen-store=false" ]'
extract_script "$tmpdir/first" true status pnpm:install '[ "--frozen-store=false" ]'
if DEVENV_SETUP_OUTER_CACHE_HIT=1 bash "$tmpdir/true-status-install.sh"; then
  echo 'Writable override incorrectly reused the frozen local projection receipt'
  exit 1
fi
bash "$tmpdir/true-exec-install.sh"
bash "$tmpdir/true-status-install.sh"
test "$(realpath "$tmpdir/first/node_modules/gvs-fixture")" = "$first_target"
(cd "$tmpdir/first"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
(cd "$tmpdir/second"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
echo 'writable override: frozen local root returned to the shared GVS graph'

# Native install accepts double negation even where config get cannot parse it.
# The probe must conservatively select frozen policy, not silently drop the flag.
printf 'offline: true\nfrozenLockfile: true\nfrozenStore: false\n' > "$XDG_CONFIG_HOME/pnpm/config.yaml"
extract_script "$tmpdir/first" true exec pnpm:install '[ "--no-frozen-store=false" ]'
extract_script "$tmpdir/first" true status pnpm:install '[ "--no-frozen-store=false" ]'
bash "$tmpdir/true-exec-install.sh"
bash "$tmpdir/true-status-install.sh"
target="$(realpath "$tmpdir/first/node_modules/gvs-fixture")"
case "$target" in "$tmpdir/first/node_modules/.pnpm/"*) ;; *) echo "Expected double-negative frozen projection: $target"; exit 1 ;; esac
(cd "$tmpdir/second"; node -e 'if (require("gvs-fixture") !== 42) process.exit(1)')
echo 'double-negative frozen policy: root-local projection and sibling runtime passed'

echo 'All real pnpm GVS integration tests passed'
