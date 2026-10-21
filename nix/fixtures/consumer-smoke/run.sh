#!/usr/bin/env bash
set -euo pipefail

# Usage: bash run.sh /absolute/candidate/checkout [/absolute/pinned/devenv]
# Fixture assets always come from this harness, including for historical candidates.
fixture=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
candidate=${1:?usage: run.sh /absolute/candidate/checkout [/absolute/pinned/devenv]}
case "$candidate" in
  /*) candidate=$(realpath "$candidate") ;;
  *) echo 'consumer-smoke: candidate checkout must be absolute' >&2; exit 2 ;;
esac
lock="$candidate/devenv.lock"
test -f "$lock"
test -f "$candidate/nix/devenv-modules/tasks/shared/pnpm.nix"

task_tmp=$(realpath -m "$fixture/../../../tmp/consumer-smoke")
mkdir -p "$task_tmp"
scratch=$(realpath "$(mktemp -d "$task_tmp/run.XXXXXXXX")")
cleanup() {
  local result=$?
  chmod -R u+w "$scratch"
  rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
workspace="$scratch/consumer"
mkdir -p "$workspace" "$scratch/home" "$scratch/cache" "$scratch/config" "$scratch/data" "$scratch/tmp"
cp -R "$fixture/." "$workspace/"
# Lockfile authoring may have materialized the source fixture. Never copy that
# state into the proof: installation and staging must happen in the new root.
rm -rf -- "$workspace/.git" "$workspace/.devenv" "$workspace/node_modules"
# Generated repo artifacts must be present before invoking the independent consumer.
for file in package.json pnpm-workspace.yaml pnpm-install-contract.json pnpm-lock.yaml repos/source/packages/shared/package.json; do
  if [ ! -f "$workspace/$file" ]; then
    echo "consumer-smoke: missing fixture artifact $file; run Genie and author the fixture lockfile first" >&2
    exit 1
  fi
done

# A path input must not copy ignored Buck/editor/devenv state into the Nix store.
# Preserve tracked working-tree bytes, including local edits, rather than HEAD alone.
candidate_source="$scratch/candidate"
mkdir -p "$candidate_source"
git -C "$candidate" ls-files -z \
  | tar -C "$candidate" --null -T - -cf - \
  | tar -C "$candidate_source" -xf -

# This temporary harness override deliberately targets the candidate source snapshot.
# Neither the published effect-utils input nor an ambient nixpkgs/devenv pin is used.
# Keep the candidate's complete dependency graph and add the consumer input.
jq --arg candidate "$candidate_source" '
  .root as $root
  | .nodes[$root].inputs as $inputs
  | .nodes[$root].inputs = ($inputs + {"effect-utils": "consumer-effect-utils"})
  | reduce ["devenv", "nixpkgs"][] as $input (. ;
      .nodes[$inputs[$input]].original = (.nodes[$inputs[$input]].locked | del(.narHash, .lastModified)))
  | .nodes["consumer-effect-utils"] = {
      flake: false,
      locked: {type: "path", path: $candidate},
      original: {type: "path", path: $candidate}
    }
' "$lock" > "$workspace/devenv.lock"
jq --arg candidate "$candidate_source" '
  def pinned($name):
    .nodes[.nodes[.root].inputs[$name]].locked
    | if .type == "github" then "github:\(.owner)/\(.repo)/\(.rev)"
      else error("consumer-smoke requires a locked GitHub " + $name + " input") end;
  {inputs: {
    devenv: {url: pinned("devenv")},
    nixpkgs: {url: pinned("nixpkgs")},
    "effect-utils": {url: ("path:" + $candidate), flake: false}
  }}
' "$lock" > "$workspace/devenv.local.yaml"

devenv=${2:-${CONSUMER_SMOKE_DEVENV:-}}
if [ -z "$devenv" ]; then
  devenv_url=$(jq -er '.nodes[.nodes[.root].inputs.devenv].locked | select(.type == "github") | "github:\(.owner)/\(.repo)/\(.rev)#devenv"' "$lock")
  devenv="$(nix build --no-link --print-out-paths "$devenv_url")/bin/devenv"
fi
devenv=$(realpath "$devenv")
test -x "$devenv"
git -C "$workspace" init --quiet
# devenv's Git source must include the fixture and its generated local override.
git -C "$workspace" add --all

cd "$workspace"
# Start with an empty environment rather than inheriting the root's DEVENV_ROOT,
# PNPM_HOME, NPM_CONFIG_*, store paths, task state, or shell activation state.
# Preserve Nix daemon configuration only; all consumer-owned state is disposable.
consumer_env=(env -i
  "PATH=$PATH" "HOME=$scratch/home" "USER=${USER:-consumer}" "LOGNAME=${LOGNAME:-consumer}"
  "TMPDIR=$scratch/tmp" "XDG_CACHE_HOME=$scratch/cache" "XDG_CONFIG_HOME=$scratch/config"
  "XDG_DATA_HOME=$scratch/data" "CI=true" "DEVENV_TUI=false"
)
for name in NIX_REMOTE NIX_CONFIG SSL_CERT_FILE NIX_SSL_CERT_FILE; do
  if [ -n "${!name:-}" ]; then consumer_env+=("$name=${!name}"); fi
done
"${consumer_env[@]}" "$devenv" tasks run pnpm:install
"${consumer_env[@]}" "$devenv" tasks run consumer:assert
