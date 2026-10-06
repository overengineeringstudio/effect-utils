#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
export HOME="$tmpdir/home"
export PNPM_SHARED_STORE_DIR="$tmpdir/store"
export PNPM_MIN_FREE_KIB=0
unset CI PNPM_HOME

# A real package tarball makes the test offline, while exercising pnpm's actual
# graph-hashed projection rather than a command-recording stub.
mkdir -p "$tmpdir/package" "$HOME" "$tmpdir/bin"
printf '{"name":"gvs-fixture","version":"1.0.0","main":"index.cjs","files":["index.cjs"]}\n' > "$tmpdir/package/package.json"
printf 'module.exports = 42\n' > "$tmpdir/package/index.cjs"
tar -czf "$tmpdir/fixture.tgz" -C "$tmpdir" package

pnpm_bin="${REAL_PNPM_BIN:-$(nix build --impure --no-link --print-out-paths --expr "let flake = builtins.getFlake \"$NIX_FLAKE_REF\"; pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; }; in import $ROOT/nix/pnpm.nix { inherit pkgs; }")/bin/pnpm}"
ln -s "$pnpm_bin" "$tmpdir/bin/pnpm"
export PATH="$tmpdir/bin:$PATH"

extract_script() {
  local root="$1" mode="$2" attr="$3" task="${4:-pnpm:install}"
  nix-instantiate --eval --read-write-mode --strict --json --expr "
    let flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix {
        packages = [ \".\" ]; globalVirtualStore = $mode;
      }) {
        pkgs = pkgs // { writeText = name: text: builtins.toFile name text; };
        lib = pkgs.lib; config.devenv.root = \"$root\";
      };
    in module.tasks.\"$task\".$attr
  " | jq -r . > "$tmpdir/$mode-$attr-${task##*:}.sh"
}

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
  if [ "$name" = ci ]; then export CI=1; else unset CI; fi
  # Ambient configuration must not defeat the selected policy.
  export PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=true
  bash "$tmpdir/$mode-exec-install.sh"
  bash "$tmpdir/$mode-status-install.sh"
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

echo 'All real pnpm GVS integration tests passed'
