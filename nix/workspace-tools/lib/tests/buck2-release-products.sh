#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
publisher="$repo_root/nix/buck2-products/publish.sh"
targets="$repo_root/nix/buck2-products/cache-targets.json"

expected_names='["@overeng/content-address","@overeng/effect-distributed-lock","@overeng/notion-core","@overeng/notion-effect-client","@overeng/notion-effect-schema","@overeng/otel-contract","@overeng/tui-core","@overeng/tui-react","@overeng/utils","@overeng/utils-dev","ci-tools","genie","genie-bootstrap-closure-check","megarepo","notion-cli","notion-db-runtime","notion-md","npm-release","oxc-config","tui-stories"]'
plan="$(bash "$publisher" --dry-run)"
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck-cache-publication-plan/v1" and
  .cache == "overeng-effect-utils" and
  [.products[].name] == $expected and
  (.products | length == 20) and
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
if grep -E '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "$publisher" >/dev/null; then
  echo "buck2-cache-products-test: publisher enables shell tracing around secrets" >&2
  exit 1
fi
mkdir -p "$tmp/collision-output" "$tmp/collision-repo/nix/buck2-products" "$tmp/fake-bin"
printf 'fixture\n' >"$tmp/collision-output/fixture.js"
collision_sha="$(sha256sum "$tmp/collision-output/fixture.js" | cut -d' ' -f1)"
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
printf '%s\n' "$FIXTURE_STORE_PATH"
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
export PIN_LIST="[{\"name\":\"fixture-$collision_sha\",\"lastRevision\":{\"storePath\":\"/nix/store/11111111111111111111111111111111-other\",\"artifacts\":[\"fixture.js\"]}}]"
export CACHIX_LOG="$tmp/cachix.log"
if PATH="$tmp/fake-bin:$PATH" CACHIX_AUTH_TOKEN=fake BUCK2_CACHE_PRODUCTS_REPO="$tmp/collision-repo" \
  bash "$publisher" --product fixture >"$tmp/collision.stdout" 2>"$tmp/collision.stderr"; then
  echo "buck2-cache-products-test: publisher accepted a pin collision" >&2
  exit 1
fi
grep -F 'already points at a different store path' "$tmp/collision.stderr" >/dev/null
[[ ! -s "$CACHIX_LOG" ]] || {
  echo "buck2-cache-products-test: publisher mutated Cachix after detecting a collision" >&2
  exit 1
}


mkdir -p "$tmp/products"
cp "$repo_root/nix/buck2-products/default.nix" "$tmp/products/default.nix"
store_path="$collision_store"
store_hash="$(basename "$store_path")"
store_hash="${store_hash%%-*}"
artifact_url="https://overeng-effect-utils.cachix.org/serve/$store_hash/fixture.js"
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

jq -e '.schema == "effect-utils/buck-cache-targets/v1" and (.products | length == 20)' "$targets" >/dev/null
echo "buck2-cache-products-test: OK"
