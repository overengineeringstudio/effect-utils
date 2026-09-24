#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
publisher="$repo_root/nix/buck2-products/publish.sh"
targets="$repo_root/nix/buck2-products/cache-targets.json"
workflow="$repo_root/.github/workflows/ci.yml"

expected_names='["@overeng/agent-session-ingest","@overeng/content-address","@overeng/effect-ai-claude-cli","@overeng/effect-distributed-lock","@overeng/effect-react","@overeng/genie","@overeng/notion-core","@overeng/notion-effect-client","@overeng/notion-effect-schema","@overeng/notion-md","@overeng/notion-property-write","@overeng/notion-react","@overeng/otel-contract","@overeng/restate-effect","@overeng/tui-core","@overeng/tui-react","@overeng/utils","@overeng/utils-dev","ci-tools","genie","genie-bootstrap-closure-check","gh-ci-utils","megarepo","notion-cli","notion-db-runtime","notion-md","npm-release","oxc-config","oxc-config-stylex-upstream-plugin","tui-stories"]'
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck-cache-targets/v1" and
  [.products[].name] == $expected and
  (.products | length == 30) and
  all(.products[];
    (.kind == "javascript" or .kind == "package") and
    (.target | startswith("effect_utils//")) and
    (.outputName | test("^[A-Za-z0-9][A-Za-z0-9._+-]*$"))
  )
' "$targets" >/dev/null

plan="$(bash "$publisher" --dry-run)"
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck-cache-publication-plan/v1" and
  .cache == "overeng-effect-utils" and
  [.products[].name] == $expected
' <<<"$plan" >/dev/null
for public_package in '@overeng/notion-react' '@overeng/restate-effect'; do
  bash "$publisher" --dry-run --product "$public_package" |
    jq -e --arg name "$public_package" '.products | length == 1 and .[0].name == $name' >/dev/null
done

# A repository-external symlink and a private dependency archive must both
# fail before the publisher can obtain credentials or build a product.
mkdir -p "$tmp/unsafe-repo/nix/buck2-products" "$tmp/unsafe-repo/buck2/dependencies"
cp "$targets" "$tmp/unsafe-repo/nix/buck2-products/cache-targets.json"
cp "$repo_root/nix/buck2-products/manifest.json" "$tmp/unsafe-repo/nix/buck2-products/manifest.json"
cp "$repo_root/buck2/dependencies/pnpm-lock.sha256.json" "$tmp/unsafe-repo/buck2/dependencies/pnpm-lock.sha256.json"
mkdir -p "$tmp/unsafe-repo/packages/@overeng"
ln -s "$repo_root/packages/@overeng/utils" "$tmp/unsafe-repo/packages/@overeng/utils"
if BUCK2_CACHE_PRODUCTS_REPO="$tmp/unsafe-repo" bash "$publisher" --dry-run --product '@overeng/utils' >"$tmp/unsafe.log" 2>&1; then
  echo "buck2-cache-products-test: accepted an external source tree" >&2
  exit 1
fi
grep -F 'refusing source outside public repository:' "$tmp/unsafe.log" >/dev/null
cp -R "$repo_root/packages/@overeng/utils" "$tmp/unsafe-repo/packages/@overeng/utils-local"
rm "$tmp/unsafe-repo/packages/@overeng/utils"
mv "$tmp/unsafe-repo/packages/@overeng/utils-local" "$tmp/unsafe-repo/packages/@overeng/utils"
jq '.packages |= (to_entries | .[0].value.classification = "private" | from_entries)' \
  "$repo_root/buck2/dependencies/pnpm-lock.sha256.json" >"$tmp/private-archives.json"
mv "$tmp/private-archives.json" "$tmp/unsafe-repo/buck2/dependencies/pnpm-lock.sha256.json"
if BUCK2_CACHE_PRODUCTS_REPO="$tmp/unsafe-repo" bash "$publisher" --dry-run --product '@overeng/utils' >"$tmp/unsafe.log" 2>&1; then
  echo "buck2-cache-products-test: accepted a private dependency archive" >&2
  exit 1
fi
grep -F 'refusing private-repository or non-public dependency input' "$tmp/unsafe.log" >/dev/null

single="$(bash "$publisher" --dry-run --product oxc-config)"
jq -e '(.products | length) == 1 and .products[0].name == "oxc-config"' <<<"$single" >/dev/null
if bash "$publisher" --dry-run --product missing >"$tmp/missing.log" 2>&1; then
  echo "buck2-cache-products-test: accepted an unknown product" >&2
  exit 1
fi
grep -F 'unknown product: missing' "$tmp/missing.log" >/dev/null


grep -F 'cachix push "$cache" "$store_path"' "$publisher" >/dev/null
grep -F 'cachix pin "$cache" "$pin_name" "$store_path" --artifact "$output_name" --keep-forever' "$publisher" >/dev/null
grep -F 'already points at a different store path' "$publisher" >/dev/null
grep -F 'env -u CACHIX_AUTH_TOKEN curl -fsS "$artifact_url"' "$publisher" >/dev/null
grep -F 'P1 cache publisher (decision 0037)' "$publisher" >/dev/null
grep -F 'publish-products:' "$workflow" >/dev/null
grep -F 'CACHIX_AUTH_TOKEN: ${{ secrets.CACHIX_AUTH_TOKEN }}' "$workflow" >/dev/null
grep -F 'pull-requests: write' "$workflow" >/dev/null
grep -F 'nix/buck2-products/publish.sh --proposal "$proposal"' "$workflow" >/dev/null
if grep -F 'nix/buck2-products/publish.sh --proposal "$proposal" --product' "$workflow" >/dev/null; then
  echo "buck2-cache-products-test: publication workflow still selects a hand-maintained product subset" >&2
  exit 1
fi
if grep -F 'product_refs' "$workflow" >/dev/null; then
  echo "buck2-cache-products-test: publication workflow still prebuilds the complete inventory" >&2
  exit 1
fi
if grep -E '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "$publisher" >/dev/null; then
  echo "buck2-cache-products-test: publisher enables shell tracing around secrets" >&2
  exit 1
fi
mkdir -p "$tmp/collision-output" "$tmp/collision-repo/nix/buck2-products" "$tmp/fake-bin"
mkdir -p "$tmp/collision-repo/packages/@overeng/fixture" "$tmp/collision-repo/buck2/dependencies"
printf '{"packages":{}}\n' >"$tmp/collision-repo/buck2/dependencies/pnpm-lock.sha256.json"
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
cat >"$tmp/collision-repo/nix/buck2-products/manifest.json" <<EOF
{
  "products": [{
    "artifactUrl": "https://cache.invalid/fixture.js",
    "descriptor": {"integrity":"$collision_integrity","productName":"fixture","sizeBytes":8,"target":"effect_utils//packages/@overeng/fixture:fixture-candidate"},
    "descriptorSha256": "1111111111111111111111111111111111111111111111111111111111111111",
    "name": "fixture",
    "provenance": {
      "producerCommit": "1111111111111111111111111111111111111111",
      "productDigest": "$collision_sha",
      "schema": "effect-utils/buck-product-provenance/v1",
      "target": "effect_utils//packages/@overeng/fixture:fixture-candidate"
    },
    "sha256": "$collision_sha",
    "size": 8,
    "storePath": "$collision_store",
    "version": "1.0.0"
  }],
  "schema": "effect-utils/buck-cache-products/v2"
}
EOF
cat >"$tmp/fake-bin/git" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *rev-parse*) printf '%s\n' '1111111111111111111111111111111111111111' ;;
  *"remote get-url origin"*) printf '%s\n' 'https://github.com/overengineeringstudio/effect-utils.git' ;;
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
url=""
out=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
emit() { if [[ -n "$out" ]]; then cat >"$out"; else cat; fi; }
case "$url" in
  */provenance.json) [[ -n "${PUBLISHED_STORE:-}" ]] && emit <"$PUBLISHED_STORE/provenance.json" && exit 0 ;;
  */fixture.js) [[ -n "${PUBLISHED_STORE:-}" ]] && emit <"$PUBLISHED_STORE/fixture.js" && exit 0 ;;
esac
printf '%s\n' "$PIN_LIST" | emit
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

# The same artifact bytes rebuilt at a later main commit produce a different store path
# (provenance.json binds the producing commit). The publisher must reuse the immutable
# pin and its provenance instead of failing or repinning.
mkdir -p "$tmp/published-output"
cp "$tmp/collision-output/fixture.js" "$tmp/collision-output/descriptor.json" "$tmp/published-output/"
cat >"$tmp/published-output/provenance.json" <<EOF
{"producerCommit":"2222222222222222222222222222222222222222","productDigest":"$collision_sha","schema":"effect-utils/buck-product-provenance/v1","target":"effect_utils//packages/@overeng/fixture:fixture-candidate"}
EOF
published_store="$(nix store add-path "$tmp/published-output")"
[[ "$published_store" != "$collision_store" ]] || {
  echo "buck2-cache-products-test: reuse fixture did not produce a distinct store path" >&2
  exit 1
}
: >"$CACHIX_LOG"
PUBLISHED_STORE="$published_store" \
  PIN_LIST="[{\"name\":\"fixture-$collision_sha\",\"lastRevision\":{\"storePath\":\"$published_store\",\"artifacts\":[\"fixture.js\"]}}]" \
  GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
  PATH="$tmp/fake-bin:$PATH" CACHIX_AUTH_TOKEN=fake BUCK2_CACHE_PRODUCTS_REPO="$tmp/collision-repo" \
  bash "$publisher" --product fixture --proposal "$tmp/reuse-manifest.json" 2>"$tmp/reuse.stderr" || {
  echo "buck2-cache-products-test: publisher rejected an identical republication:" >&2
  cat "$tmp/reuse.stderr" >&2
  exit 1
}
jq -e --arg storePath "$published_store" --arg digest "$collision_sha" '
  (.products | length == 1) and
  .products[0].storePath == $storePath and
  .products[0].sha256 == $digest and
  .products[0].provenance.producerCommit == "2222222222222222222222222222222222222222" and
  (.products[0].artifactUrl | endswith(($storePath | ltrimstr("/nix/store/") | split("-")[0]) + "/fixture.js"))
' "$tmp/reuse-manifest.json" >/dev/null || {
  echo "buck2-cache-products-test: reuse did not bind the published store path and provenance" >&2
  cat "$tmp/reuse-manifest.json" >&2
  exit 1
}
[[ ! -s "$CACHIX_LOG" ]] || {
  echo "buck2-cache-products-test: publisher repinned an already published artifact" >&2
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
mkdir -p "$tmp/scope-repo/packages/@overeng/megarepo" "$tmp/scope-repo/buck2/dependencies"
printf '{"packages":{}}\n' >"$tmp/scope-repo/buck2/dependencies/pnpm-lock.sha256.json"
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
cat >"$tmp/scope-repo/nix/buck2-products/manifest.json" <<'EOF'
{
  "products": [
    {
      "descriptor": {
        "productName": "megarepo",
        "sentinel": "stale-megarepo"
      },
      "descriptorSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "release": {
        "hash": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "name": "stale-mr.js",
        "tag": "stale-megarepo",
        "url": "https://example.invalid/stale-mr.js"
      }
    },
    {
      "descriptor": {
        "productName": "unrelated-broken",
        "sentinel": "must-remain-byte-identical"
      },
      "descriptorSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "release": {
        "hash": "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        "name": "unrelated.js",
        "tag": "unrelated",
        "url": "https://example.invalid/unrelated.js"
      }
    }
  ],
  "schema": "effect-utils/buck2-release-products/v1"
}
EOF
unrelated_before="$(
  jq -cS '.products[] | select(.descriptor.productName == "unrelated-broken")' \
    "$tmp/scope-repo/nix/buck2-products/manifest.json"
)"
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
unrelated_after="$(
  jq -cS '.products[] | select(.descriptor.productName == "unrelated-broken")' \
    "$tmp/scope-manifest.json"
)"
[[ "$unrelated_after" == "$unrelated_before" ]] || {
  echo "buck2-cache-products-test: scoped publication changed an unrelated legacy product" >&2
  exit 1
}
jq -e --arg digest "$scope_sha" '
  .schema == "effect-utils/buck-cache-products/v3" and
  (.products | length == 2) and
  ([.products[] | select((has("name") | not) and .descriptor.productName == "megarepo")] | length == 0) and
  ([.products[] | select(.name? == "megarepo")] | length == 1) and
  (.products[] | select(.name? == "megarepo") |
    .sha256 == $digest and
    .provenance.schema == "effect-utils/buck-product-provenance/v1" and
    .provenance.productDigest == $digest)
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
  productNames = builtins.attrNames loaded.products;
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
cat >"$tmp/products/targets.json" <<'EOF'
{
  "products": [
    {
      "name": "legacy",
      "target": "effect_utils//packages/@overeng/legacy:legacy-candidate"
    }
  ]
}
EOF
legacy_descriptor='{"externalCapabilities":[],"externalModules":[],"integrity":"sha256-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=","modulePath":"legacy.js","platform":{"abi":"any","architecture":"any","os":"any"},"productKind":"cli","productName":"legacy","provenance":{"configuredTarget":"legacy","dependencyClosureIdentity":"legacy","module":"legacy"},"runtimeContract":"javascript-esm","runtimeContractVersion":"v1","runtimeKind":"node","schema":"effect-utils/javascript-product/v2","sizeBytes":1,"target":"effect_utils//packages/@overeng/legacy:legacy-candidate"}'
legacy_descriptor_sha="$(printf '%s' "$legacy_descriptor" | sha256sum | cut -d' ' -f1)"
cp "$tmp/products/manifest.json" "$tmp/products/manifest.v2.json"
jq -S \
  --argjson descriptor "$legacy_descriptor" \
  --arg descriptorSha256 "$legacy_descriptor_sha" \
  '.schema = "effect-utils/buck-cache-products/v3" |
   .products += [{
     descriptor: $descriptor,
     descriptorSha256: $descriptorSha256,
     release: {
       hash: "sha256-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=",
       name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-legacy.js",
       tag: "buck2-product-v3-legacy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       url: "https://github.com/overengineeringstudio/effect-utils/releases/download/buck2-product-v3-legacy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-legacy.js"
     }
   }]' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.v3.json"
mv "$tmp/products/manifest.v3.json" "$tmp/products/manifest.json"
v3_summary="$(nix eval --impure --json --expr "$loader_expr")"
jq -e '
  .fullyPublished == true and
  .productNames == ["fixture", "legacy"] and
  .publishedProductNames == ["fixture", "legacy"]
' <<<"$v3_summary" >/dev/null
mv "$tmp/products/manifest.v2.json" "$tmp/products/manifest.json"

jq '.products[0].artifactUrl = "https://overeng-effect-utils.cachix.org/serve/11111111111111111111111111111111/fixture.js"' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.mutated.json"
mv "$tmp/products/manifest.mutated.json" "$tmp/products/manifest.json"
if nix eval --impure --json --expr "$loader_expr" >"$tmp/mismatch.log" 2>&1; then
  echo "buck2-cache-products-test: loader accepted a mismatched artifact URL" >&2
  exit 1
fi
grep -F 'artifact URL does not match its store path and artifact' "$tmp/mismatch.log" >/dev/null

jq -e '.schema == "effect-utils/buck-cache-targets/v1" and (.products | length == 30)' "$targets" >/dev/null
echo "buck2-cache-products-test: OK"
