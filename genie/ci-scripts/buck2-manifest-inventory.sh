#!/usr/bin/env bash
set -euo pipefail

# Change-relative CI control-plane selection belongs to the existing quality job,
# not a new developer task. All inventory assertions remain owned by cache.nix.
select_mode() {
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request|merge_group)
      # Missing history is never evidence that the manifest was untouched.
      local base_sha="${MANIFEST_BASE_SHA:-}" merge_base changed
      if [ -z "$base_sha" ]; then
        echo '::warning::Manifest base SHA missing; requiring full publication' >&2
        echo full
        return
      fi
      if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
        if ! git fetch --no-tags --unshallow origin >&2; then
          echo '::warning::Manifest base history unavailable; requiring full publication' >&2
          echo full
          return
        fi
      fi
      if ! git fetch --no-tags origin "$base_sha" >&2 ||
        ! merge_base="$(git merge-base "$base_sha" HEAD)" ||
        ! changed="$(git diff --name-only "$merge_base"...HEAD)"; then
        echo '::warning::Manifest base comparison unavailable; requiring full publication' >&2
        echo full
        return
      fi
      while IFS= read -r path; do
        if [ "$path" = nix/buck2-products/manifest.json ]; then
          echo full
          return
        fi
      done <<<"$changed"
      echo subset
      ;;
    *)
      # Push/main freshness is covered by buck2-products/manifest-current, set
      # by publish-products; source commits may legitimately await publication.
      echo subset
      ;;
  esac
}

mode="$(select_mode)"
if [ "${1:-}" = --select-mode ]; then
  echo "$mode"
  exit 0
fi
if [ "$mode" = full ]; then
  export MANIFEST_CHANGED=true
else
  export MANIFEST_CHANGED=false
fi
missing="$(nix eval --impure --json --expr 'let flake = builtins.getFlake ("git+file://" + toString ./.); loaded = import ./nix/buck2-products/cache.nix { pkgs.lib = flake.inputs.nixpkgs.lib; fromSourceProducts = {}; }; in assert loaded.assertDeclaredProducts; assert (builtins.getEnv "MANIFEST_CHANGED" != "true" || loaded.assertFullyPublished); loaded.missingProductNames')"
if [ "$missing" != '[]' ]; then
  echo "::notice::Missing products: $missing; expected on source PRs; publish-products completes them after merge"
fi
