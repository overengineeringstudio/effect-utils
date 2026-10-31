#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
source "$ROOT/nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/pnpm-historical-store-safety.XXXXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
# Deliberately retain every fixture: this regression does not remove stores,
# worktrees, imported files, or source archives, even on failure.
if [ -n "${PNPM_BIN:-}" ]; then
  PNPM="$PNPM_BIN"
else
  pnpm_expr="$(cat <<EOF
  let flake = builtins.getFlake "$NIX_FLAKE_REF";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in flake.lib.mkPnpm { inherit pkgs; }
EOF
)"
  nix build --no-link --impure --expr "$pnpm_expr"
  PNPM_OUT="$(nix eval --raw --impure --expr "($pnpm_expr).outPath")"
  PNPM="$PNPM_OUT/bin/pnpm"
fi
test "$("$PNPM" --version)" = "$(node -p 'require(process.argv[1]).packageManager.split("@").pop()' "$ROOT/package.json")"
flags_json="$(nix eval --json --impure --expr "
  (import $ROOT/nix/workspace-tools/lib/pnpm-install-policy.nix { lib = {}; }).liveInstallPolicyFlags
")"
mapfile -t policy_flags < <(node -e 'for (const flag of JSON.parse(process.argv[1])) console.log(flag)' "$flags_json")
roots="$fixture/home/.megarepo/github.com/fixture/pnpm-store-proof/refs/heads"
mkdir -p "$fixture/package/package" "$roots/seed" "$fixture/shared-store"
printf '%s\n' '{"name":"store-purity-proof","version":"1.0.0","scripts":{"install":"node install.cjs"}}' > "$fixture/package/package/package.json"
printf '%s\n' 'module.exports = "immutable"' > "$fixture/package/package/index.js"
printf '%s\n' 'require("node:fs").writeFileSync("install-ran", "unsafe")' > "$fixture/package/package/install.cjs"
tar -czf "$roots/store-purity-proof.tgz" -C "$fixture/package" package
printf '%s\n' '{"name":"store-proof-root","private":true,"dependencies":{"store-purity-proof":"file:../store-purity-proof.tgz"}}' > "$roots/seed/package.json"
printf 'packages:\n  - .\n' > "$roots/seed/pnpm-workspace.yaml"
export PNPM_SHARED_STORE_DIR="$fixture/shared-store"
export HOME="$fixture/home"
export CI=1
unset GITHUB_ACTIONS PNPM_JOB_LOCAL_STORE PNPM_HOME
host_is_linux=false
if [ "$(uname -s)" = Linux ]; then host_is_linux=true; fi
(
  cd "$roots/seed"
  configure_pnpm_storage "$(command -v node)" "$PWD" "$PWD/.devenv/pnpm-store-pure-v1" "$host_is_linux" false "$PNPM"
  "$PNPM" install --lockfile-only "${policy_flags[@]}" --reporter=append-only
)
git -C "$roots/seed" init -q
git -C "$roots/seed" add package.json pnpm-workspace.yaml pnpm-lock.yaml
git -C "$roots/seed" -c user.name=schickling-assistant -c user.email=261620128+schickling-assistant@users.noreply.github.com commit -qm 'dependency fixture'
git -C "$roots/seed" worktree add -q -b proof-a "$roots/root-a"
git -C "$roots/seed" worktree add -q -b proof-b "$roots/root-b"
for name in root-a root-b; do
  (
    cd "$roots/$name"
    ensure_local_pnpm_home_default "$PWD"
    configure_pnpm_storage "$(command -v node)" "$PWD" "$PWD/.devenv/pnpm-store-pure-v1" "$host_is_linux" false "$PNPM"
    test "$PNPM_STORE_DIR" = "$fixture/shared-store"
    test "$PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE" = false
    acquire_pnpm_store_cache_lease "$(command -v flock)" shared "$PNPM_STORE_DIR" 10
    extra_flags=()
    if [ "$name" = root-b ]; then extra_flags=(--offline); fi
    "$PNPM" install --frozen-lockfile "${extra_flags[@]}" "${policy_flags[@]}" --reporter=append-only
    test ! -e .devenv/pnpm-store-pure-v1
    test ! -e node_modules/store-purity-proof/install-ran
    test "$(node -p 'require("./node_modules/store-purity-proof")')" = immutable
    node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("node_modules/.modules.yaml","utf8")); if(m.storeDir!==process.env.PNPM_STORE_DIR+"/v11" || m.virtualStoreDir!==".pnpm") throw Error(JSON.stringify(m))'
    git diff --exit-code -- pnpm-lock.yaml
  )
done
test "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$roots/root-a/node_modules/.pnpm")" != "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$roots/root-b/node_modules/.pnpm")"
printf 'PASS: two Git worktrees share one store under CI=1; second install offline; frozen locks unchanged; lifecycle scripts disabled; root-local virtual stores distinct. Fixtures: %s\n' "$fixture"
