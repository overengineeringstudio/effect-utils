#!/usr/bin/env bash
set -euo pipefail

repo_root="${BUCK2_CACHE_PRODUCTS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
targets="$repo_root/nix/buck2-products/cache-targets.json"
manifest="$repo_root/nix/buck2-products/manifest.json"
cache="overeng-effect-utils"
dry_run=false
proposal=""
declare -a selected_products=()

fail() {
  printf 'buck2-cache-products-publish: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: nix/buck2-products/publish.sh [--dry-run] [--product NAME] [--proposal PATH]

--dry-run       Validate and print the complete publication plan without building or mutating.
--product NAME  Publish only NAME. May be repeated. The default is the complete generated inventory.
--proposal PATH Write the v2 manifest outside the Git worktree. The default writes it to stdout.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --product) (($# >= 2)) || fail "--product requires a name"; selected_products+=("$2"); shift 2 ;;
    --proposal) (($# >= 2)) || fail "--proposal requires a path"; proposal="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -f "$targets" && ! -L "$targets" ]] || fail "generated target inventory is missing: $targets"
command -v jq >/dev/null || fail "jq is required"
jq -e '
  (keys | sort) == ["products", "schema", "schemaVersion"] and
  .schema == "effect-utils/buck-cache-targets/v1" and .schemaVersion == 1 and
  (.products | type == "array" and length > 0) and
  (all(.products[];
    (keys | sort) == ["kind","name","outputName","packagePath","packageTreePath","target","version"] and
    (.kind == "javascript" or .kind == "package") and
    (.name | type == "string" and length > 0) and
    (.outputName | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
    (.target | type == "string" and test("^effect_utils//[^[:space:]]+:[^[:space:]]+$")) and
    (.version | type == "string" and length > 0)
  )) and
  ([.products[].name] | length == (unique | length)) and
  ([.products[].target] | length == (unique | length))
' "$targets" >/dev/null || fail "target inventory violates effect-utils/buck-cache-targets/v1"

selection='.'
if ((${#selected_products[@]})); then
  selection='select(.name == $selected)'
  for selected in "${selected_products[@]}"; do
    jq -e --arg selected "$selected" '.products[] | select(.name == $selected)' "$targets" >/dev/null ||
      fail "unknown product: $selected"
  done
fi
declared_fingerprint="$(jq -r '.provenance.fingerprint' "$targets")"
computed_fingerprint="$(jq -cS '{
  generator: .provenance.generator,
  schemaVersion: .schemaVersion,
  semanticData: .products
}' "$targets" | tr -d '\n' | sha256sum)"
computed_fingerprint="sha256:${computed_fingerprint%% *}"
[[ "$declared_fingerprint" == "$computed_fingerprint" ]] ||
  fail "target inventory fingerprint does not match its declared products"

rows="$({
  if ((${#selected_products[@]})); then
    for selected in "${selected_products[@]}"; do
      jq -cS --arg selected "$selected" ".products[] | $selection" "$targets"
    done
  else
    jq -cS '.products[]' "$targets"
  fi
} | jq -csS 'sort_by(.name)')"

plan="$(jq -cnS --arg cache "$cache" --argjson products "$rows" '{schema:"effect-utils/buck-cache-publication-plan/v1",cache:$cache,products:$products}')"
if $dry_run; then
  [[ -z "$proposal" ]] || fail "--proposal is unavailable in dry-run mode"
  printf '%s\n' "$plan"
  exit 0
fi

for tool in cachix curl git nix realpath sha256sum stat; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done
[[ -z "${GITHUB_EVENT_NAME:-}" || "${GITHUB_EVENT_NAME}" == workflow_dispatch ]] ||
  fail "refusing untrusted GitHub event: ${GITHUB_EVENT_NAME}"
head_commit="$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] ||
  fail "refusing to publish from a dirty Git worktree"

if [[ -z "${CACHIX_AUTH_TOKEN:-}" ]]; then
  command -v op-proxy >/dev/null || fail "op-proxy is required when CACHIX_AUTH_TOKEN is unset"
fi

if [[ -z "${CACHIX_AUTH_TOKEN:-}" ]]; then
  [[ -n "${CACHIX_AUTH_TOKEN_REF:-}" ]] || fail "CACHIX_AUTH_TOKEN_REF is required when CACHIX_AUTH_TOKEN is unset"
  CACHIX_AUTH_TOKEN="$(op-proxy read "$CACHIX_AUTH_TOKEN_REF" --reason "P1 cache publisher (decision 0037)" --cache 1d)"
  export CACHIX_AUTH_TOKEN
fi

if [[ -n "$proposal" ]]; then
  proposal="$(realpath -m "$proposal")"
  canonical_repo="$(realpath "$repo_root")"
  case "$proposal" in
    "$canonical_repo"|"$canonical_repo"/*) fail "proposal output must be outside the Git worktree" ;;
  esac
  [[ ! -e "$proposal" ]] || fail "refusing to overwrite proposal output: $proposal"
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
entries="$stage/entries.jsonl"
: >"$entries"
pins="$(curl -fsS "https://app.cachix.org/api/v1/cache/$cache/pin")" || fail "could not list existing Cachix pins"
jq -e 'type == "array"' <<<"$pins" >/dev/null || fail "Cachix pin listing is not an array"

while IFS= read -r row; do
  name="$(jq -r '.name' <<<"$row")"
  version="$(jq -r '.version' <<<"$row")"
  target="$(jq -r '.target' <<<"$row")"
  output_name="$(jq -r '.outputName' <<<"$row")"
  safe_name="$(sed 's|^@||; s|/|-|g' <<<"$name")"
  attr="buck-product-$safe_name-from-source"
  store_path="$(nix build --no-link --print-out-paths "$repo_root#$attr")"
  [[ "$store_path" == /nix/store/* && -d "$store_path" ]] || fail "$name did not build one store directory"
  artifact="$store_path/$output_name"
  provenance_file="$store_path/provenance.json"
  [[ -f "$artifact" && ! -L "$artifact" ]] || fail "$name artifact is missing: $artifact"
  [[ -f "$provenance_file" && ! -L "$provenance_file" ]] || fail "$name provenance is missing"
  sha256="$(sha256sum "$artifact" | cut -d' ' -f1)"
  size="$(stat -c '%s' "$artifact")"
  jq -e --arg commit "$head_commit" --arg target "$target" --arg digest "$sha256" '
    (keys | sort) == ["producerCommit","productDigest","schema","target"] and
    .schema == "effect-utils/buck-product-provenance/v1" and
    .producerCommit == $commit and .target == $target and .productDigest == $digest
  ' "$provenance_file" >/dev/null || fail "$name provenance does not bind the built artifact"
  pin_name="$safe_name-$sha256"
  existing="$(jq -c --arg name "$pin_name" '[.[] | select(.name == $name)]' <<<"$pins")"
  existing_count="$(jq 'length' <<<"$existing")"
  ((existing_count <= 1)) || fail "$pin_name is held by multiple Cachix pins"
  if ((existing_count == 1)); then
    existing_path="$(jq -r '.[0].lastRevision.storePath' <<<"$existing")"
    [[ "$existing_path" == "$store_path" ]] || fail "$pin_name already points at a different store path"
    jq -e --arg artifact "$output_name" '.[0].lastRevision.artifacts | index($artifact) != null' <<<"$existing" >/dev/null ||
      fail "$pin_name exists without the required artifact"
  fi
  store_hash="$(basename "$store_path")"
  store_hash="${store_hash%%-*}"
  artifact_url="https://$cache.cachix.org/serve/$store_hash/$output_name"
  jq -cnS \
    --arg name "$name" --arg version "$version" --arg sha256 "$sha256" \
    --argjson size "$size" --arg storePath "$store_path" --arg artifactUrl "$artifact_url" \
    --argjson provenance "$(jq -cS . "$provenance_file")" \
    '{name:$name,version:$version,sha256:$sha256,size:$size,storePath:$storePath,artifactUrl:$artifactUrl,provenance:$provenance}' \
    >>"$entries"
done < <(jq -c '.[]' <<<"$rows")

while IFS= read -r entry; do
  name="$(jq -r '.name' <<<"$entry")"
  sha256="$(jq -r '.sha256' <<<"$entry")"
  store_path="$(jq -r '.storePath' <<<"$entry")"
  artifact_url="$(jq -r '.artifactUrl' <<<"$entry")"
  output_name="${artifact_url##*/}"
  safe_name="$(sed 's|^@||; s|/|-|g' <<<"$name")"
  pin_name="$safe_name-$sha256"
  existing_count="$(jq --arg name "$pin_name" '[.[] | select(.name == $name)] | length' <<<"$pins")"
  cachix push "$cache" "$store_path"
  if ((existing_count == 0)); then
    cachix pin "$cache" "$pin_name" "$store_path" --artifact "$output_name" --keep-forever
  fi
  downloaded="$stage/$safe_name.download"
  env -u CACHIX_AUTH_TOKEN curl -fsS "$artifact_url" -o "$downloaded"
  [[ "$(sha256sum "$downloaded" | cut -d' ' -f1)" == "$sha256" ]] || fail "$name anonymous artifact digest mismatch"
  [[ "$(stat -c '%s' "$downloaded")" == "$(jq -r '.size' <<<"$entry")" ]] || fail "$name anonymous artifact size mismatch"
done <"$entries"

proposal_stage="$stage/manifest.json"
jq -sS '{schema:"effect-utils/buck-cache-products/v2",products:sort_by(.name)}' "$entries" >"$proposal_stage"
if [[ -n "$proposal" ]]; then
  cp "$proposal_stage" "$proposal"
  printf 'buck2-cache-products-publish: proposed manifest: %s\n' "$proposal" >&2
else
  cat "$proposal_stage"
fi
