#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
publisher="$repo_root/nix/buck2-products/publish.sh"
targets="$repo_root/nix/buck2-products/cache-targets.json"
workflow="$repo_root/.github/workflows/ci.yml"

expected_names='["@overeng/content-address","@overeng/effect-distributed-lock","@overeng/notion-core","@overeng/notion-effect-client","@overeng/notion-effect-schema","@overeng/notion-react","@overeng/otel-contract","@overeng/restate-effect","@overeng/tui-core","@overeng/tui-react","@overeng/utils","@overeng/utils-dev","ci-tools","genie","genie-bootstrap-closure-check","megarepo","notion-cli","notion-db-runtime","notion-md","npm-release","oxc-config","oxc-config-stylex-upstream-plugin","tui-stories"]'
plan="$(bash "$publisher" --dry-run)"
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck-cache-publication-plan/v1" and
  .cache == "overeng-effect-utils" and
  [.products[].name] == $expected and
  (.products | length == 23) and
  all(.products[];
    (.kind == "javascript" or .kind == "package") and
    (.target | startswith("effect_utils//")) and
    (.outputName | test("^[A-Za-z0-9][A-Za-z0-9._+-]*$"))
  )
' <<<"$plan" >/dev/null

single="$(bash "$publisher" --dry-run --product oxc-config)"
jq -e '.products | length == 1 and .[0].name == "oxc-config"' <<<"$single" >/dev/null
if bash "$publisher" --dry-run --product missing >"$tmp/missing.log" 2>&1; then
  echo "buck2-cache-products-test: accepted an unknown product" >&2
  exit 1
fi
grep -F 'unknown product: missing' "$tmp/missing.log" >/dev/null

if grep -E 'gh |github.com/.*/releases|buck2-product-v3|buck2-package-v1' "$publisher" >/dev/null; then
  echo "buck2-cache-products-test: publisher still contains the retired GitHub release path" >&2
  exit 1
fi
grep -F 'cachix push "$cache" "$store_path"' "$publisher" >/dev/null
grep -F 'cachix pin "$cache" "$pin_name" "$store_path" --artifact "$output_name" --keep-forever' "$publisher" >/dev/null
grep -F 'already points at a different store path' "$publisher" >/dev/null
grep -F 'env -u CACHIX_AUTH_TOKEN curl -fsS "$artifact_url"' "$publisher" >/dev/null
grep -F 'P1 cache publisher (decision 0037)' "$publisher" >/dev/null
grep -F 'publish-products:' "$workflow" >/dev/null
grep -F 'CACHIX_AUTH_TOKEN: ${{ secrets.CACHIX_AUTH_TOKEN }}' "$workflow" >/dev/null
grep -F 'pull-requests: write' "$workflow" >/dev/null
grep -F 'nix/buck2-products/publish.sh --proposal "$proposal" --product megarepo --product @overeng/restate-effect --product @overeng/notion-react --product genie' "$workflow" >/dev/null
if grep -F 'product_refs' "$workflow" >/dev/null; then
  echo "buck2-cache-products-test: publication workflow still prebuilds the complete inventory" >&2
  exit 1
fi
if grep -E '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "$publisher" >/dev/null; then
  echo "buck2-cache-products-test: publisher enables shell tracing around secrets" >&2
  exit 1
fi
mkdir -p "$tmp/collision-output" "$tmp/collision-repo/nix/buck2-products" "$tmp/fake-bin"
printf 'fixture\n' >"$tmp/collision-output/fixture.js"
collision_sha="$(sha256sum "$tmp/collision-output/fixture.js" | cut -d' ' -f1)"
collision_integrity="$(nix hash convert --hash-algo sha256 --to sri "$collision_sha")"
cat >"$tmp/collision-output/descriptor.json" <<EOF
{"integrity":"$collision_integrity","productName":"fixture","sizeBytes":8,"target":"effect_utils//packages/@overeng/fixture:fixture-candidate"}
EOF
cat >"$tmp/collision-output/provenance.json" <<EOF
{"producerCommit":"1111111111111111111111111111111111111111","productDigest":"$collision_sha","schema":"effect-utils/buck-product-provenance/v1","target":"effect_utils//packages/@overeng/fixture:fixture-candidate"}
EOF
collision_store="$(nix store add-path "$tmp/collision-output")"
cat >"$tmp/collision-repo/nix/buck2-products/cache-targets.json" <<'EOF'
{
  "products": [{
    "kind": "javascript",
    "name": "fixture",
    "outputName": "fixture.js",
    "packagePath": "packages/@overeng/fixture",
    "packageTreePath": "packages/@overeng/fixture",
    "target": "effect_utils//packages/@overeng/fixture:fixture-candidate",
    "version": "1.0.0"
  }],
  "schema": "effect-utils/buck-cache-targets/v1",
  "schemaVersion": 1
}
EOF
cat >"$tmp/fake-bin/git" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *rev-parse*) printf '%s\n' '1111111111111111111111111111111111111111' ;;
  *status*) ;;
  *) exit 2 ;;
esac
EOF
cat >"$tmp/fake-bin/nix" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  hash) printf '%s\n' "$FIXTURE_INTEGRITY" ;;
  *) printf '%s\n' "$FIXTURE_STORE_PATH" ;;
esac
EOF
cat >"$tmp/fake-bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$PIN_LIST"
EOF
cat >"$tmp/fake-bin/cachix" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CACHIX_LOG"
EOF
chmod +x "$tmp/fake-bin/"*
export FIXTURE_STORE_PATH="$collision_store"
export FIXTURE_INTEGRITY="$collision_integrity"
export PIN_LIST="[{\"name\":\"fixture-$collision_sha\",\"lastRevision\":{\"storePath\":\"/nix/store/11111111111111111111111111111111-other\",\"artifacts\":[\"fixture.js\"]}}]"
export CACHIX_LOG="$tmp/cachix.log"
# Pin the trusted-event environment: under a pull_request run GITHUB_REF is
# refs/pull/<n>/merge and the publisher would refuse before reaching the pin check.
if GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
  PATH="$tmp/fake-bin:$PATH" CACHIX_AUTH_TOKEN=fake BUCK2_CACHE_PRODUCTS_REPO="$tmp/collision-repo" \
  bash "$publisher" --product fixture >"$tmp/collision.stdout" 2>"$tmp/collision.stderr"; then
  echo "buck2-cache-products-test: publisher accepted a pin collision" >&2
  exit 1
fi
grep -F 'already points at a different store path' "$tmp/collision.stderr" >/dev/null || {
  echo "buck2-cache-products-test: publisher failed for an unexpected reason:" >&2
  cat "$tmp/collision.stderr" >&2
  exit 1
}
[[ ! -s "$CACHIX_LOG" ]] || {
  echo "buck2-cache-products-test: publisher mutated Cachix after detecting a collision" >&2
  exit 1
}

mkdir -p "$tmp/local-bin" "$tmp/local-cache"
cp "$tmp/fake-bin/git" "$tmp/local-bin/git"
cat >"$tmp/local-bin/nix" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  build) printf '%s\n' "$FIXTURE_STORE_PATH" ;;
  copy) printf '%s\n' "$*" >>"$NIX_COPY_LOG" ;;
  hash) printf '%s\n' "$FIXTURE_INTEGRITY" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$tmp/local-bin/"*
export NIX_COPY_LOG="$tmp/nix-copy.log"
local_cache_url="file://$tmp/local-cache"
for run in first second; do
  GITHUB_EVENT_NAME=push \
    GITHUB_REF=refs/heads/main \
    CACHIX_CACHE_URL="$local_cache_url" \
    BUCK2_CACHE_PRODUCTS_REPO="$tmp/collision-repo" \
    PATH="$tmp/local-bin:$PATH" \
    bash "$publisher" --product fixture --proposal "$tmp/$run-manifest.json"
done
cmp "$tmp/first-manifest.json" "$tmp/second-manifest.json"
[[ "$(wc -l <"$NIX_COPY_LOG")" == 1 ]] || {
  echo "buck2-cache-products-test: local cache publication was not idempotent" >&2
  exit 1
}
jq -e --arg storePath "$collision_store" --arg artifact "fixture.js" '
  length == 1 and
  .[0].lastRevision.storePath == $storePath and
  .[0].lastRevision.artifacts == [$artifact]
' "$tmp/local-cache/pins.json" >/dev/null
jq -e --arg prefix "$local_cache_url/serve/" '
  .schema == "effect-utils/buck-cache-products/v2" and
  (.products | length == 1) and
  (.products[0].artifactUrl | startswith($prefix))
' "$tmp/first-manifest.json" >/dev/null


mkdir -p "$tmp/scope-output" "$tmp/scope-repo/nix/buck2-products" "$tmp/scope-bin" "$tmp/scope-cache"
printf 'megarepo\n' >"$tmp/scope-output/mr.js"
scope_sha="$(sha256sum "$tmp/scope-output/mr.js" | cut -d' ' -f1)"
scope_integrity="$(nix hash convert --hash-algo sha256 --to sri "$scope_sha")"
scope_size="$(stat -c '%s' "$tmp/scope-output/mr.js")"
scope_target='effect_utils//packages/@overeng/megarepo:megarepo-candidate'
cat >"$tmp/scope-output/descriptor.json" <<EOF
{"integrity":"$scope_integrity","productName":"megarepo","sizeBytes":$scope_size,"target":"$scope_target"}
EOF
cat >"$tmp/scope-output/provenance.json" <<EOF
{"producerCommit":"1111111111111111111111111111111111111111","productDigest":"$scope_sha","schema":"effect-utils/buck-product-provenance/v1","target":"$scope_target"}
EOF
scope_store="$(nix store add-path "$tmp/scope-output")"
cat >"$tmp/scope-repo/nix/buck2-products/cache-targets.json" <<'EOF'
{
  "products": [
    {
      "kind": "javascript",
      "name": "megarepo",
      "outputName": "mr.js",
      "packagePath": "packages/@overeng/megarepo",
      "packageTreePath": "packages/@overeng/megarepo",
      "target": "effect_utils//packages/@overeng/megarepo:megarepo-candidate",
      "version": "0.0.0"
    },
    {
      "kind": "javascript",
      "name": "unrelated-broken",
      "outputName": "broken.js",
      "packagePath": "packages/@overeng/unrelated-broken",
      "packageTreePath": "packages/@overeng/unrelated-broken",
      "target": "effect_utils//packages/@overeng/unrelated-broken:unrelated-broken-candidate",
      "version": "0.0.0"
    }
  ],
  "schema": "effect-utils/buck-cache-targets/v1",
  "schemaVersion": 1
}
EOF
cp "$tmp/fake-bin/git" "$tmp/scope-bin/git"
cat >"$tmp/scope-bin/nix" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  build)
    printf '%s\n' "$*" >>"$SCOPE_BUILD_LOG"
    case "$*" in
      *'#buck-product-megarepo-from-source') printf '%s\n' "$SCOPE_STORE_PATH" ;;
      *) exit 97 ;;
    esac
    ;;
  copy) ;;
  hash) printf '%s\n' "$SCOPE_INTEGRITY" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$tmp/scope-bin/"*
scope_cache_url="file://$tmp/scope-cache"
SCOPE_BUILD_LOG="$tmp/scope-build.log" \
  SCOPE_STORE_PATH="$scope_store" \
  SCOPE_INTEGRITY="$scope_integrity" \
  GITHUB_EVENT_NAME=push \
  GITHUB_REF=refs/heads/main \
  CACHIX_CACHE_URL="$scope_cache_url" \
  BUCK2_CACHE_PRODUCTS_REPO="$tmp/scope-repo" \
  PATH="$tmp/scope-bin:$PATH" \
  bash "$publisher" --product megarepo --proposal "$tmp/scope-manifest.json"
[[ "$(wc -l <"$tmp/scope-build.log")" == 1 ]] &&
  grep -F '#buck-product-megarepo-from-source' "$tmp/scope-build.log" >/dev/null &&
  ! grep -F 'unrelated-broken' "$tmp/scope-build.log" >/dev/null || {
  echo "buck2-cache-products-test: scoped Megarepo publication evaluated an unrelated product" >&2
  exit 1
}
jq -e '
  .schema == "effect-utils/buck-cache-products/v2" and
  [.products[].name] == ["megarepo"]
' "$tmp/scope-manifest.json" >/dev/null

mkdir -p "$tmp/products"
cp "$repo_root/nix/buck2-products/default.nix" "$tmp/products/default.nix"
cp "$repo_root/nix/buck2-products/cache.nix" "$tmp/products/cache.nix"
store_path="$collision_store"
store_hash="$(basename "$store_path")"
store_hash="${store_hash%%-*}"
artifact_url="https://overeng-effect-utils.cachix.org/serve/$store_hash/fixture.js"
fixture_descriptor='{"integrity":"sha256-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=","productName":"fixture","sizeBytes":1,"target":"effect_utils//packages/@overeng/fixture:fixture-candidate"}'
fixture_descriptor_sha="$(printf '%s' "$fixture_descriptor" | sha256sum | cut -d' ' -f1)"
cat >"$tmp/products/cache-targets.json" <<'EOF'
{
  "products": [
    {
      "kind": "javascript",
      "name": "fixture",
      "outputName": "fixture.js",
      "packagePath": "packages/@overeng/fixture",
      "packageTreePath": "packages/@overeng/fixture",
      "target": "effect_utils//packages/@overeng/fixture:fixture-candidate",
      "version": "1.0.0"
    }
  ],
  "schema": "effect-utils/buck-cache-targets/v1",
  "schemaVersion": 1
}
EOF
cat >"$tmp/products/manifest.json" <<EOF
{
  "products": [
    {
      "artifactUrl": "$artifact_url",
      "descriptor": $fixture_descriptor,
      "descriptorSha256": "$fixture_descriptor_sha",
      "name": "fixture",
      "provenance": {
        "producerCommit": "0000000000000000000000000000000000000000",
        "productDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "schema": "effect-utils/buck-product-provenance/v1",
        "target": "effect_utils//packages/@overeng/fixture:fixture-candidate"
      },
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size": 1,
      "storePath": "$store_path",
      "version": "1.0.0"
    }
  ],
  "schema": "effect-utils/buck-cache-products/v2"
}
EOF

loader_expr="let
  mkPath = path: attrs: attrs // { outPath = path; __toString = self: self.outPath; };
  recipe = mkPath \"$store_path\" {
    artifactName = \"fixture.js\";
    target = \"effect_utils//packages/@overeng/fixture:fixture-candidate\";
  };
  pkgs = {
    coreutils = mkPath \"/nix/store/coreutils\" {};
    jq = mkPath \"/nix/store/jq\" {};
    lib = {
      assertMsg = condition: message: if condition then true else throw message;
      escapeShellArg = value: \"'\" + value + \"'\";
      replaceStrings = builtins.replaceStrings;
      splitString = separator: value: let
        split = builtins.split separator value;
      in builtins.filter builtins.isString split;
      unique = builtins.foldl' (seen: value: if builtins.elem value seen then seen else seen ++ [ value ]) [];
    };
    runCommand = name: attrs: script: mkPath \"/nix/store/validated-fixture\" (attrs // { inherit name script; });
    writeText = name: text: mkPath \"/nix/store/text-fixture\" { inherit name text; };
  };
  loaded = import $tmp/products { inherit pkgs; fromSourceProducts.fixture = recipe; };
in {
  inherit (loaded) declaredProductNames publishedProductNames fullyPublished;
  artifactUrl = loaded.products.fixture.artifactUrl;
  sourcePath = builtins.toString loaded.products.fixture.sourceRecipe;
}"
summary="$(nix eval --impure --json --expr "$loader_expr")"
jq -e --arg storePath "$store_path" --arg artifactUrl "$artifact_url" '
  .fullyPublished == true and
  .declaredProductNames == ["fixture"] and
  .publishedProductNames == ["fixture"] and
  .sourcePath == $storePath and
  .artifactUrl == $artifactUrl
' <<<"$summary" >/dev/null

jq '.products[0].artifactUrl = "https://overeng-effect-utils.cachix.org/serve/11111111111111111111111111111111/fixture.js"' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.mutated.json"
mv "$tmp/products/manifest.mutated.json" "$tmp/products/manifest.json"
if nix eval --impure --json --expr "$loader_expr" >"$tmp/mismatch.log" 2>&1; then
  echo "buck2-cache-products-test: loader accepted a mismatched artifact URL" >&2
  exit 1
fi
grep -F 'artifact URL does not match its store path and artifact' "$tmp/mismatch.log" >/dev/null

jq -e '.schema == "effect-utils/buck-cache-targets/v1" and (.products | length == 23)' "$targets" >/dev/null
echo "buck2-cache-products-test: OK"
