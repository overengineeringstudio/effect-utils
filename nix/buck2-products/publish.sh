#!/usr/bin/env bash
set -euo pipefail

repo_root="${BUCK2_CACHE_PRODUCTS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
targets="$repo_root/nix/buck2-products/cache-targets.json"
manifest="$repo_root/nix/buck2-products/manifest.json"
cache="overeng-effect-utils"
cache_url="${CACHIX_CACHE_URL:-https://$cache.cachix.org}"
cache_url="${cache_url%/}"
local_cache=false
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
--proposal PATH Write the merged manifest outside the Git worktree. The default writes it to stdout.
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
[[ -f "$manifest" && ! -L "$manifest" ]] || fail "current product manifest is missing: $manifest"
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
jq -e '
  def legacy:
    (keys | sort) == ["descriptor", "descriptorSha256", "release"] and
    (.descriptor.productName | type == "string" and length > 0);
  def cached:
    (
      (has("descriptor") and
       (keys | sort) == ["artifactUrl", "descriptor", "descriptorSha256", "name", "provenance", "sha256", "size", "storePath", "version"])
      or
      (has("descriptor") | not) and
      (keys | sort) == ["artifactUrl", "name", "provenance", "sha256", "size", "storePath", "version"]
    ) and
    (.name | type == "string" and length > 0) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.provenance |
      (keys | sort) == ["producerCommit", "productDigest", "schema", "target"] and
      .schema == "effect-utils/buck-product-provenance/v1" and
      (.producerCommit | test("^[0-9a-f]{40}$")) and
      (.target | type == "string" and length > 0)) and
    .provenance.productDigest == .sha256;
  def identity: .name // .descriptor.productName;
  (keys | sort) == ["products", "schema"] and
  (.products | type == "array" and length > 0) and
  (
    if .schema == "effect-utils/buck2-release-products/v1" then
      all(.products[]; legacy)
    elif .schema == "effect-utils/buck-cache-products/v2" then
      all(.products[]; cached)
    elif .schema == "effect-utils/buck-cache-products/v3" then
      all(.products[]; legacy or cached)
    else
      false
    end
  ) and
  ([.products[] | identity] | length == (unique | length))
' "$manifest" >/dev/null || fail "current product manifest has an unsupported or invalid schema"

selection='.'
if ((${#selected_products[@]})); then
  selection='select(.name == $selected)'
  for selected in "${selected_products[@]}"; do
    jq -e --arg selected "$selected" '.products[] | select(.name == $selected)' "$targets" >/dev/null ||
      fail "unknown product: $selected"
  done
fi

rows="$({
  if ((${#selected_products[@]})); then
    for selected in "${selected_products[@]}"; do
      jq -cS --arg selected "$selected" ".products[] | $selection" "$targets"
    done
  else
    jq -cS '.products[]' "$targets"
  fi
} | jq -csS 'sort_by(.name)')"

while IFS= read -r row; do
  [[ "$(jq -r '.kind' <<<"$row")" == package ]] || continue
  name="$(jq -r '.name' <<<"$row")"
  package_path="$(jq -r '.packagePath' <<<"$row")"
  package_manifest="$repo_root/$package_path/package.json"
  [[ -f "$package_manifest" && ! -L "$package_manifest" ]] ||
    fail "package product manifest is missing: $package_manifest"
  jq -e --arg name "$name" '.name == $name and (.private != true)' "$package_manifest" >/dev/null ||
    fail "refusing public cache publication for private or misclassified package: $name"
done < <(jq -c '.[]' <<<"$rows")

plan="$(jq -cnS --arg cache "$cache" --argjson products "$rows" '{schema:"effect-utils/buck-cache-publication-plan/v1",cache:$cache,products:$products}')"
if $dry_run; then
  [[ -z "$proposal" ]] || fail "--proposal is unavailable in dry-run mode"
  printf '%s\n' "$plan"
  exit 0
fi

for tool in curl git jq nix realpath sha256sum stat; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done
case "${GITHUB_EVENT_NAME:-}" in
  ""|push|workflow_dispatch) ;;
  *) fail "refusing untrusted GitHub event: ${GITHUB_EVENT_NAME}" ;;
esac
[[ -z "${GITHUB_REF:-}" || "${GITHUB_REF}" == refs/heads/main ]] ||
  fail "refusing publication from non-main ref: ${GITHUB_REF}"
head_commit="$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] ||
  fail "refusing to publish from a dirty Git worktree"

case "$cache_url" in
  file:///*)
    local_cache=true
    cache_root="$(realpath -m "${cache_url#file://}")"
    cache_url="file://$cache_root"
    ;;
  https://*) command -v cachix >/dev/null || fail "cachix is required" ;;
  *) fail "CACHIX_CACHE_URL must use https:// or file:///" ;;
esac

if ! $local_cache && [[ -z "${CACHIX_AUTH_TOKEN:-}" ]]; then
  command -v op-proxy >/dev/null || fail "op-proxy is required when CACHIX_AUTH_TOKEN is unset"
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
if $local_cache; then
  mkdir -p "$cache_root"
  pins_file="$cache_root/pins.json"
  if [[ -f "$pins_file" ]]; then
    pins="$(cat "$pins_file")"
  else
    pins='[]'
  fi
else
  pins="$(curl -fsS "https://app.cachix.org/api/v1/cache/$cache/pin")" ||
    fail "could not list existing Cachix pins"
fi
jq -e 'type == "array"' <<<"$pins" >/dev/null || fail "Cachix pin listing is not an array"

while IFS= read -r row; do
  name="$(jq -r '.name' <<<"$row")"
  version="$(jq -r '.version' <<<"$row")"
  kind="$(jq -r '.kind' <<<"$row")"
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
  descriptor='null'
  descriptor_sha256='null'
  if [[ "$kind" == javascript ]]; then
    descriptor_file="$store_path/descriptor.json"
    [[ -f "$descriptor_file" && ! -L "$descriptor_file" ]] || fail "$name descriptor is missing"
    descriptor="$(jq -cS . "$descriptor_file")" || fail "$name descriptor is invalid"
    descriptor_sha256="$(printf '%s' "$descriptor" | sha256sum | cut -d' ' -f1)"
    integrity="$(nix hash convert --hash-algo sha256 --to sri "$sha256")"
    jq -e \
      --arg name "$name" --arg target "$target" --arg integrity "$integrity" --argjson size "$size" \
      '.productName == $name and .target == $target and .integrity == $integrity and .sizeBytes == $size' \
      <<<"$descriptor" >/dev/null || fail "$name descriptor does not bind the built artifact"
  fi
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
  artifact_url="$cache_url/serve/$store_hash/$output_name"
  jq -cnS \
    --arg name "$name" --arg version "$version" --arg sha256 "$sha256" \
    --argjson size "$size" --arg storePath "$store_path" --arg artifactUrl "$artifact_url" \
    --argjson provenance "$(jq -cS . "$provenance_file")" \
    --arg kind "$kind" --argjson descriptor "$descriptor" --arg descriptorSha256 "$descriptor_sha256" \
    '{name:$name,version:$version,sha256:$sha256,size:$size,storePath:$storePath,artifactUrl:$artifactUrl,provenance:$provenance}
     + (if $kind == "javascript" then {descriptor:$descriptor,descriptorSha256:$descriptorSha256} else {} end)' \
    >>"$entries"
done < <(jq -c '.[]' <<<"$rows")

while IFS= read -r entry; do
  name="$(jq -r '.name' <<<"$entry")"
  sha256="$(jq -r '.sha256' <<<"$entry")"
  store_path="$(jq -r '.storePath' <<<"$entry")"
  artifact_url="$(jq -r '.artifactUrl' <<<"$entry")"
  store_hash="$(basename "$store_path")"
  store_hash="${store_hash%%-*}"
  output_name="${artifact_url##*/}"
  safe_name="$(sed 's|^@||; s|/|-|g' <<<"$name")"
  pin_name="$safe_name-$sha256"
  existing_count="$(jq --arg name "$pin_name" '[.[] | select(.name == $name)] | length' <<<"$pins")"
  if ((existing_count == 0)); then
    if $local_cache; then
      nix copy --to "$cache_url" "$store_path"
      local_artifact="$cache_root/serve/$store_hash/$output_name"
      mkdir -p "$(dirname "$local_artifact")"
      cp "$store_path/$output_name" "$local_artifact"
      pins="$(jq -cS \
        --arg name "$pin_name" --arg storePath "$store_path" --arg artifact "$output_name" \
        '. + [{name:$name,lastRevision:{storePath:$storePath,artifacts:[$artifact]}}] | sort_by(.name)' \
        <<<"$pins")"
      pins_stage="$stage/pins.json"
      printf '%s\n' "$pins" >"$pins_stage"
      mv "$pins_stage" "$pins_file"
    else
      cachix push "$cache" "$store_path"
      cachix pin "$cache" "$pin_name" "$store_path" --artifact "$output_name" --keep-forever
    fi
  fi
  downloaded="$stage/$safe_name.download"
  env -u CACHIX_AUTH_TOKEN curl -fsS "$artifact_url" -o "$downloaded"
  [[ "$(sha256sum "$downloaded" | cut -d' ' -f1)" == "$sha256" ]] || fail "$name anonymous artifact digest mismatch"
  [[ "$(stat -c '%s' "$downloaded")" == "$(jq -r '.size' <<<"$entry")" ]] || fail "$name anonymous artifact size mismatch"
done <"$entries"

proposal_stage="$stage/manifest.json"
replacements="$(jq -csS '.' "$entries")"
jq -S --argjson replacements "$replacements" '
  def identity: .name // .descriptor.productName;
  ($replacements | map({key: identity, value: .}) | from_entries) as $replacementByName |
  ([.products[] | . as $product | select($replacementByName[$product | identity] == null)] + $replacements | sort_by(identity)) as $products |
  {
    schema:
      (if all($products[]; has("name"))
       then "effect-utils/buck-cache-products/v2"
       else "effect-utils/buck-cache-products/v3"
       end),
    products: $products
  }
' "$manifest" >"$proposal_stage"
if [[ -n "$proposal" ]]; then
  cp "$proposal_stage" "$proposal"
  printf 'buck2-cache-products-publish: proposed manifest: %s\n' "$proposal" >&2
else
  cat "$proposal_stage"
fi
