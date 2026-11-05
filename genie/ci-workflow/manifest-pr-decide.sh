#!/usr/bin/env bash
# Sourced by the trusted publisher. Pins come from cache.nix, not a second list.
bootstrap_pins() {
  nix eval --impure --json --expr 'builtins.attrNames ((import ./nix/buck2-products/cache.nix {
    pkgs.lib = (builtins.getFlake ("git+file:" + toString ./.)).inputs.nixpkgs.lib;
    fromSourceProducts = {};
  }).bootstrapPins)'
}

bootstrap_rows() {
  jq -cS --argjson pins "$2" '[.products[] | select(.name as $name | $pins | index($name))] | sort_by(.name)' "$1"
}

manifest_pr_decide() {
  local main="$1" proposal="$2" pins="$3" repository="$4" now="$5"
  local old new commits timestamp epoch
  old="$(jq -cS '.products | sort_by(.name)' "$main")" || return
  new="$(jq -cS '.products | sort_by(.name)' "$proposal")" || return
  if [ "$old" = "$new" ]; then
    echo skip-no-diff
  elif [ "$(bootstrap_rows "$main" "$pins")" != "$(bootstrap_rows "$proposal" "$pins")" ]; then
    echo open
  else
    # Use the job's read-only token, never the publisher App token.
    if ! commits="$(GH_TOKEN="${GITHUB_TOKEN:?}" gh api "repos/$repository/commits?path=nix/buck2-products/manifest.json&sha=main&per_page=1")" ||
      ! timestamp="$(jq -er '.[0].commit.committer.date' <<<"$commits")" ||
      ! epoch="$(date -u -d "$timestamp" +%s)"; then
      echo '::warning::Manifest history unavailable; leaving the publisher PR unchanged' >&2
      echo skip-unchanged-genie
    elif [ "$((now - epoch))" -ge 86400 ]; then
      echo open
    else
      echo skip-recent-safety-net
    fi
  fi
}
