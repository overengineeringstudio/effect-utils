#!/usr/bin/env bash
# Downstream flake-input regression for retained effect-utils public outputs.
#
# `nix flake check` never applies `lib.*` functions, and nothing in this repo
# consumes effect-utils through `--override-input`. This applies
# `lib.mkOxlintNpm` (#1384: pnpm archive forwarding) and builds
# `packages.genie` and `packages.oxlint-npm` from a separate downstream flake,
# through both a standalone checkout and the composed megarepo
# `repos/effect-utils` path.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
fixture="$repo_root/nix/workspace-tools/lib/tests/downstream-flake-input"
system="${NIX_SYSTEM:-$(nix eval --impure --raw --expr builtins.currentSystem)}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/effect-utils-downstream.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

copy_repo() {
  mkdir -p "$1"
  (cd "$repo_root" && tar \
    --exclude=.git --exclude=.devenv --exclude=.direnv --exclude=.cache \
    --exclude=node_modules --exclude=buck-out --exclude=result --exclude=tmp \
    --exclude=.editor-view \
    -cf - .) | (cd "$1" && tar -xf -)
}

check_completions() {
  local out="$1" bin="$2" file
  for file in \
    "$out/share/fish/vendor_completions.d/$bin.fish" \
    "$out/share/bash-completion/completions/$bin" \
    "$out/share/zsh/site-functions/_$bin"; do
    if [ ! -s "$file" ]; then
      echo "error: missing or empty completion file: $file" >&2
      exit 1
    fi
  done
}

downstream="$tmp/downstream"
cp -R "$fixture" "$downstream"
copy_repo "$tmp/effect-utils"
copy_repo "$tmp/repos/effect-utils"

for layout in effect-utils repos/effect-utils; do
  override=(--no-write-lock-file --override-input effect-utils "path:$tmp/$layout")

  echo "Eval: downstream lib.mkOxlintNpm ($layout)"
  nix eval --raw "${override[@]}" --apply 'drv: drv.drvPath' \
    "path:$downstream#packages.$system.oxlint-npm-from-lib"
  echo

  echo "Build: downstream genie ($layout)"
  out="$(nix build --no-link --print-out-paths "${override[@]}" "path:$downstream#packages.$system.genie")"
  check_completions "$out" genie

  echo "Build: downstream oxlint-npm ($layout)"
  nix build --no-link "${override[@]}" "path:$downstream#packages.$system.oxlint-npm"
done

echo "downstream flake-input regression passed"
