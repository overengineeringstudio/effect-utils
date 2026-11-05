#!/usr/bin/env bash
bootstrap_pins() {
  nix eval --impure --json --expr 'builtins.attrNames ((import ./nix/buck2-products/cache.nix {
    pkgs.lib = (builtins.getFlake ("git+file:" + toString ./.)).inputs.nixpkgs.lib;
    fromSourceProducts = {};
  }).bootstrapPins)'
}
bootstrap_rows() {
  jq -ecS --argjson pins "$2" '[.products[] | select(.name as $name | $pins | index($name))] | sort_by(.name)' "$1"
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
    if ! commits="$(GH_TOKEN="${GITHUB_TOKEN:?}" gh api "repos/$repository/commits?path=nix/buck2-products/manifest.json&sha=main&per_page=1")" ||
      ! timestamp="$(jq -er '.[0].commit.committer.date' <<<"$commits")" ||
      ! epoch="$(date -u -d "$timestamp" +%s)"; then
      echo '::warning::Manifest history unavailable; skipping the daily safety net' >&2
      echo skip-unchanged-genie
    elif [ "$((now - epoch))" -ge 86400 ]; then
      echo open
    else
      echo skip-recent-safety-net
    fi
  fi
}
# Recheck immediately before the remote write, not just before building a proposal.
manifest_pr_writer_decide() {
  local source="$1" remote tip
  if ! remote="$(git ls-remote origin refs/heads/main)"; then
    echo '::warning::Main tip unavailable; leaving the publisher PR unchanged' >&2
    echo skip-superseded
    return
  fi
  tip="${remote%%$'\t'*}"
  if [ -n "$tip" ] && [ "$source" = "$tip" ]; then
    echo open
  else
    echo '::notice::superseded: a newer main run owns the proposal' >&2
    echo skip-superseded
  fi
}
# A skipped run must not leave a different bootstrap proposal available to merge.
manifest_pr_heal_decide() {
  local decision="$1" proposal="$2" pr_manifest="$3" pins="$4" rows
  if [ "$decision" = open ] || [ -z "$pr_manifest" ]; then echo "$decision"; return; fi
  if rows="$(bootstrap_rows "$pr_manifest" "$pins")"; then
    if [ "$rows" = "$(bootstrap_rows "$proposal" "$pins")" ]; then echo "$decision"; return; fi
  else
    echo '::warning::Open PR bootstrap rows unavailable; healing the publisher PR' >&2
  fi
  if [ "$decision" = skip-no-diff ]; then echo close; else echo open; fi
}
