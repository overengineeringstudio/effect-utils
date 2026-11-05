#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
publisher="$repo_root/nix/buck2-products/publish.sh"
targets="$repo_root/nix/buck2-products/cache-targets.json"
workflow="$repo_root/.github/workflows/ci.yml"

bash "$repo_root/genie/ci-scripts/buck2-manifest-inventory.test.sh" "$repo_root"

jq -e '
  .schema == "effect-utils/buck-cache-targets/v1" and
  (.products | length > 0) and
  ([.products[].name] == ([.products[].name] | sort)) and
  (([.products[].name] | unique | length) == (.products | length)) and
  all(.products[];
    (.kind == "javascript" or .kind == "package") and
    (.target | startswith("effect_utils//")) and
    (.outputName | test("^[A-Za-z0-9][A-Za-z0-9._+-]*$"))
  )
' "$targets" >/dev/null
expected_names="$(jq -c '[.products[].name]' "$targets")"

# Product dependency declarations are part of the exact publication inventory
# contract. Reject malformed, missing and overlapping IDs before source access,
# credentials or any build; the repository inventory is the positive control.
mkdir -p "$tmp/invalid-targets/nix/buck2-products"
cp "$repo_root/nix/buck2-products/manifest.json" "$tmp/invalid-targets/nix/buck2-products/manifest.json"
for mutation in \
  'del(.products[0].buildCapabilities)' \
  '.products[0].buildCapabilities = []' \
  '.products[0].buildCapabilities = ["bun", "bun"]' \
  '.products[0].buildCapabilities = ["Not-a-capability"]' \
  '.products[0].linuxBuildCapabilities = "bubblewrap"' \
  '.products[0].linuxBuildCapabilities = ["bun"]' \
  '.products[0].unexpected = true'; do
  jq "$mutation" "$targets" >"$tmp/invalid-targets/nix/buck2-products/cache-targets.json"
  if BUCK2_CACHE_PRODUCTS_REPO="$tmp/invalid-targets" bash "$publisher" --dry-run >"$tmp/invalid-targets.log" 2>&1; then
    echo "buck2-cache-products-test: accepted invalid capability inventory: $mutation" >&2
    exit 1
  fi
  grep -F 'target inventory violates effect-utils/buck-cache-targets/v1' "$tmp/invalid-targets.log" >/dev/null
done

plan="$(bash "$publisher" --dry-run)"
jq -e --argjson expected "$expected_names" '
  .schema == "effect-utils/buck-cache-publication-plan/v1" and
  .cache == "overeng-effect-utils" and
  [.products[].name] == $expected
' <<<"$plan" >/dev/null
for public_package in '@overeng/devbar' '@overeng/meters' '@overeng/effect-rpc-explorer' '@overeng/effect-rpc-explorer-react' '@overeng/effect-rpc-observer' '@overeng/rpc-devtools' '@overeng/stylex-tokens'; do
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
# The manifest PR and published ref use the publisher GitHub App token. Only
# GITHUB_TOKEN contents/pull-requests grants are forbidden; statuses and OIDC
# permissions remain available for publication evidence.
publish_job="$(sed -n '/^  publish-products:/,/^  [a-z][a-z0-9-]*:$/p' "$workflow")"
promotion_job="$(sed -n '/^  promote-published:/,/^  [a-z][a-z0-9-]*:$/p' "$workflow")"
grep -F 'uses: actions/create-github-app-token@' <<<"$publish_job" >/dev/null
grep -F 'private-key: ${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}' <<<"$publish_job" >/dev/null
grep -F 'uses: actions/create-github-app-token@' <<<"$promotion_job" >/dev/null
grep -F 'private-key: ${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}' <<<"$promotion_job" >/dev/null
# Parse the actual workflow/job permissions, independent of YAML formatting and
# separate from permission-contents inputs to actions/create-github-app-token.
if ! bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))' "$workflow" |
  jq -e '
    [.permissions, .jobs["publish-products"].permissions, .jobs["promote-published"].permissions] |
    all(
      if type == "object" then
        .contents != "write" and .["pull-requests"] != "write"
      else
        . == null or . == "read-all"
      end
    )
  ' >/dev/null; then
  echo "buck2-cache-products-test: publication jobs must not grant contents/pull-requests write scopes to GITHUB_TOKEN" >&2
  exit 1
fi
# Compile warming runs alongside smoke, never on the promotion dependency path.
bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))' "$workflow" |
  jq -e '
    .jobs as $jobs |
    $jobs["publish-compile-products"].needs == ["publish-products"] and
    $jobs["publish-compile-products"]["continue-on-error"] == true and
    $jobs["publish-compile-products"].permissions == {contents:"read"} and
    ($jobs["publish-compile-products"].if | contains("github.ref == \u0027refs/heads/main\u0027") and contains("github.event_name == \u0027push\u0027") and contains("github.event.pull_request.head.repo.full_name == github.repository")) and
    $jobs["publish-compile-products"]["runs-on"] == ["sh-linux-x64","nix"] and
    $jobs["publish-compile-products"]["timeout-minutes"] == 30 and
    $jobs["publish-compile-products"].concurrency == {group:"publish-compile-products-main","cancel-in-progress":true} and
    any($jobs["publish-compile-products"].steps[]; .name == "Disable Linux Nix sandbox fallback") and
    any($jobs["publish-compile-products"].steps[]; .id == "linux-sandbox-admission" and (.run | contains("unshare -Ur true"))) and
    any($jobs["publish-compile-products"].steps[];
      .name == "Publish unstamped compile outputs" and
      .env.CACHIX_AUTH_TOKEN == "${{ secrets.CACHIX_AUTH_TOKEN }}" and
      (.run | contains("bash genie/ci-scripts/publish-compile-products.sh"))) and
    all($jobs["publish-compile-products"].steps[];
      (.uses // "" | test("^(actions/(upload-artifact|download-artifact|cache)|actions/create-github-app-token)@") | not)) and
    all($jobs | to_entries[] | select(.key != "publish-compile-products");
      (.value.needs // [] | if type == "string" then [.] else . end | index("publish-compile-products")) == null)
  ' >/dev/null
# Publication mints the manifest PR token and checks secret presence; the
# independently gated promotion job now owns the second token-minting step.
if [ "$(grep -c 'NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY' <<<"$publish_job")" -ne 2 ] ||
  [ "$(grep -c 'NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY' <<<"$promotion_job")" -ne 1 ] ||
  [ "$(grep -c 'NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY' "$workflow")" -ne 3 ]; then
  echo "buck2-cache-products-test: the publisher App key must reach only each job's token-minting step and the publisher presence check" >&2
  exit 1
fi
grep -F 'nix/buck2-products/publish.sh --proposal "$proposal"' "$workflow" >/dev/null
if grep -F 'nix/buck2-products/publish.sh --proposal "$proposal" --product' "$workflow" >/dev/null; then
  echo "buck2-cache-products-test: publication workflow still selects a hand-maintained product subset" >&2
  exit 1
fi
if grep -F 'product_refs' <<<"$publish_job" >/dev/null; then
  echo "buck2-cache-products-test: publication workflow still prebuilds the complete inventory" >&2
  exit 1
fi
# The PR-time inventory build is the credential-free twin: it builds every product but
# must never see a publication secret or push to the cache.
build_job="$(sed -n '/^  build-products:/,/^  [a-z][a-z0-9-]*:$/p' "$workflow")"
grep -F 'product_refs+=(".#buck-product-$safe_name-from-source")' <<<"$build_job" >/dev/null
grep -F "BUCK2_PUBLIC_CACHE_READ_ONLY: '1'" <<<"$build_job" >/dev/null
if grep -E 'secrets\.|cachix push|authToken|contents: write' <<<"$build_job" >/dev/null; then
  echo "buck2-cache-products-test: build-products must stay credential-free and must not push" >&2
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
mkdir -p "$tmp/evidence-output"
jq -S --arg recipeIdentity "$(printf '%064d' 0)" '{schema:"effect-utils/buck-product-source-evidence/v1",recipeIdentity:$recipeIdentity,target,productDigest}' \
  "$tmp/collision-output/provenance.json" >"$tmp/evidence-output/source-evidence.json"
export FIXTURE_EVIDENCE_STORE_PATH="$(nix store add-path "$tmp/evidence-output")"
evidence_sha="$(sha256sum "$tmp/evidence-output/source-evidence.json" | cut -d' ' -f1)"
cat >"$tmp/collision-repo/nix/buck2-products/cache-targets.json" <<'EOF'
{
  "products": [{
    "buildCapabilities": ["action-env", "archive-tool", "bun", "rust-shell"],
    "kind": "javascript",
    "linuxBuildCapabilities": ["bubblewrap"],
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
  eval) printf '%064d\n' 0 ;;
  build)
    if [[ "$*" == *".compileProduct" ]]; then
      printf '%s\n' "$*" >>"$COMPILE_BUILD_LOG"
      [[ "${FAIL_COMPILE_BUILD:-}" != 1 ]] || exit 1
      printf '%s\n' "$FIXTURE_COMPILE_STORE_PATH"
    elif [[ "$*" == *".sourceEvidence" ]]; then
      printf '%s\n' "$FIXTURE_EVIDENCE_STORE_PATH"
    else
      printf '%s\n' "$FIXTURE_STORE_PATH"
    fi
    ;;
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
  */source-evidence.json) emit <"$FIXTURE_EVIDENCE_STORE_PATH/source-evidence.json"; exit 0 ;;
  */fixture.js) [[ -n "${PUBLISHED_STORE:-}" ]] && emit <"$PUBLISHED_STORE/fixture.js" && exit 0 ;;
esac
printf '%s\n' "$PIN_LIST" | emit
EOF
cat >"$tmp/fake-bin/cachix" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CACHIX_LOG"
[[ "${FAIL_COMPILE_PUSH:-}" != 1 || "$*" != *"$FIXTURE_COMPILE_STORE_PATH" ]] || exit 1
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
  PIN_LIST="[{\"name\":\"fixture-$collision_sha\",\"lastRevision\":{\"storePath\":\"$published_store\",\"artifacts\":[\"fixture.js\"]}},{\"name\":\"fixture-source-$evidence_sha\",\"lastRevision\":{\"storePath\":\"$FIXTURE_EVIDENCE_STORE_PATH\",\"artifacts\":[\"source-evidence.json\"]}}]" \
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
  .products[0].recipeIdentity == ("0" * 64) and
  .products[0].sourceEvidenceStorePath == env.FIXTURE_EVIDENCE_STORE_PATH and
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

# Even with both immutable artifact/evidence pins already present, the separate
# compile publisher realizes and pushes the unstamped output for every family.
mkdir -p "$tmp/compile-output"
cp "$tmp/collision-output/fixture.js" "$tmp/compile-output/fixture.js"
export FIXTURE_COMPILE_STORE_PATH="$(nix store add-path "$tmp/compile-output")"
export COMPILE_BUILD_LOG="$tmp/compile-build.log"
printf '{"products":[{"name":"fixture-native"}]}\n' >"$tmp/collision-repo/nix/buck2-products/native-targets.json"
printf '{"products":[{"name":"fixture-compiled"}]}\n' >"$tmp/collision-repo/nix/buck2-products/compiled-targets.json"
compile_publisher="$repo_root/genie/ci-scripts/publish-compile-products.sh"
for mode in success push-failure build-failure; do
  : >"$CACHIX_LOG"
  : >"$COMPILE_BUILD_LOG"
  fail_push=0; fail_build=0
  if [[ "$mode" == push-failure ]]; then fail_push=1; fi
  if [[ "$mode" == build-failure ]]; then fail_build=1; fi
  GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
    GITHUB_REPOSITORY=overengineeringstudio/effect-utils \
    PATH="$tmp/fake-bin:$PATH" FAIL_COMPILE_PUSH="$fail_push" FAIL_COMPILE_BUILD="$fail_build" \
    bash "$compile_publisher" "$tmp/collision-repo" 2>"$tmp/compile-$mode.stderr"
  [[ "$(wc -l <"$COMPILE_BUILD_LOG")" == 3 ]]
  for attr in buck-product-fixture-from-source.compileProduct \
    fixture-compiled-compiled.buck2Product.compileProduct fixture-native.buck2Product.compileProduct; do
    grep -F -- "$tmp/collision-repo#$attr" "$COMPILE_BUILD_LOG" >/dev/null
  done
  if [[ "$mode" == build-failure ]]; then
    [[ ! -s "$CACHIX_LOG" ]]
    [[ "$(grep -c '::warning title=Compile cache realization failed::' "$tmp/compile-$mode.stderr")" == 3 ]]
  else
    [[ "$(wc -l <"$CACHIX_LOG")" == 3 ]]
    [[ "$(grep -Fxc "push overeng-effect-utils $FIXTURE_COMPILE_STORE_PATH" "$CACHIX_LOG")" == 3 ]]
    if [[ "$mode" == push-failure ]]; then
      [[ "$(grep -c '::warning title=Compile cache push failed::' "$tmp/compile-$mode.stderr")" == 3 ]]
    fi
  fi
done

mkdir -p "$tmp/local-bin" "$tmp/local-cache"
cp "$tmp/fake-bin/git" "$tmp/local-bin/git"
cat >"$tmp/local-bin/nix" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  build) if [[ "$*" == *".sourceEvidence" ]]; then printf '%s\n' "$FIXTURE_EVIDENCE_STORE_PATH"; else printf '%s\n' "$FIXTURE_STORE_PATH"; fi ;;
  eval) printf '%064d\n' 0 ;;
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
[[ "$(wc -l <"$NIX_COPY_LOG")" == 2 ]] || {
  echo "buck2-cache-products-test: local cache publication was not idempotent" >&2
  exit 1
}
jq -e --arg storePath "$collision_store" --arg artifact "fixture.js" '
  length == 2 and
  any(.[]; .lastRevision.storePath == $storePath and .lastRevision.artifacts == [$artifact]) and
  any(.[]; .lastRevision.storePath == env.FIXTURE_EVIDENCE_STORE_PATH and .lastRevision.artifacts == ["source-evidence.json"])
' "$tmp/local-cache/pins.json" >/dev/null
jq -e --arg prefix "$local_cache_url/serve/" '
  .schema == "effect-utils/buck-cache-products/v2" and
  (.products | length == 1) and
  (.products[0].artifactUrl | startswith($prefix))
' "$tmp/first-manifest.json" >/dev/null

# A scoped publication must preserve unrelated cache rows and build only its
# selected product, even when the other target cannot be built.
jq '.products += [(.products[0] | .name = "unrelated" | .target = "effect_utils//packages/@overeng/unrelated:unrelated-candidate")]' \
  "$tmp/collision-repo/nix/buck2-products/cache-targets.json" >"$tmp/targets.scoped.json"
mv "$tmp/targets.scoped.json" "$tmp/collision-repo/nix/buck2-products/cache-targets.json"
jq '.products += [(.products[0] |
  .name = "unrelated" |
  .sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" |
  .provenance.productDigest = .sha256 |
  .provenance.target = "effect_utils//packages/@overeng/unrelated:unrelated-candidate")]' \
  "$tmp/collision-repo/nix/buck2-products/manifest.json" >"$tmp/manifest.scoped.json"
mv "$tmp/manifest.scoped.json" "$tmp/collision-repo/nix/buck2-products/manifest.json"
GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
  CACHIX_CACHE_URL="$local_cache_url" BUCK2_CACHE_PRODUCTS_REPO="$tmp/collision-repo" \
  PATH="$tmp/local-bin:$PATH" \
  bash "$publisher" --product fixture --proposal "$tmp/scoped-manifest.json"
jq -e --slurpfile previous "$tmp/collision-repo/nix/buck2-products/manifest.json" '
  .schema == "effect-utils/buck-cache-products/v2" and
  (.products | length == 2) and
  (.products[] | select(.name == "unrelated")) ==
    ($previous[0].products[] | select(.name == "unrelated"))
' "$tmp/scoped-manifest.json" >/dev/null
[[ "$(wc -l <"$NIX_COPY_LOG")" == 2 ]] || {
  echo "buck2-cache-products-test: scoped publication rebuilt an unrelated product" >&2
  exit 1
}

mkdir -p "$tmp/products"
cp "$repo_root/nix/buck2-products/default.nix" "$tmp/products/default.nix"
sed 's/builtins ? fetchClosure/false/' "$repo_root/nix/buck2-products/cache.nix" >"$tmp/products/cache.nix"
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
      "buildCapabilities": ["action-env", "archive-tool", "bun", "rust-shell"],
      "kind": "javascript",
      "linuxBuildCapabilities": ["bubblewrap"],
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

loader_bindings="let
  mkPath = path: attrs: attrs // { outPath = path; __toString = self: self.outPath; };
  recipe = mkPath \"$store_path\" {
    artifactName = \"fixture.js\";
    target = \"effect_utils//packages/@overeng/fixture:fixture-candidate\";
    recipeIdentity = builtins.concatStringsSep \"\" (builtins.genList (_:
      if builtins.getEnv \"RECIPE_CHANGED\" == \"1\" then \"b\" else \"a\") 64);
  };
  pkgs = {
    coreutils = mkPath \"/nix/store/coreutils\" {};
    jq = mkPath \"/nix/store/jq\" {};
    lib = {
      assertMsg = condition: message: if condition then true else throw message;
      escapeShellArg = value: \"'\" + value + \"'\";
      replaceStrings = builtins.replaceStrings;
      optionalString = condition: value: if condition then value else \"\";
      splitString = separator: value: let
        split = builtins.split separator value;
      in builtins.filter builtins.isString split;
      unique = builtins.foldl' (seen: value: if builtins.elem value seen then seen else seen ++ [ value ]) [];
    };
    runCommand = name: attrs: script: mkPath \"/nix/store/validated-fixture\" (attrs // { inherit name script; });
    writeText = name: text: mkPath (builtins.toFile name text) { inherit name text; };
    fetchurl = args:
      assert args.name != \"fixture-source-evidence.json\" ||
        builtins.hashString \"sha256\" (builtins.readFile \"$tmp/source-evidence.json\") ==
          builtins.convertHash { hash = args.hash; hashAlgo = \"sha256\"; toHashFormat = \"base16\"; };
      mkPath (if args.name == \"fixture-source-evidence.json\" then \"$tmp/source-evidence.json\" else \"$collision_store/fixture.js\") {};
  };
  loaded = import $tmp/products { inherit pkgs; fromSourceProducts.fixture = recipe; };"
inventory_expr="$loader_bindings
in assert loaded.assertDeclaredProducts;
assert (builtins.getEnv \"MANIFEST_CHANGED\" != \"true\" || loaded.assertFullyPublished);
loaded.missingProductNames"
loader_expr="$loader_bindings
in assert loaded.assertFullyPublished; {
  inherit (loaded) declaredProductNames publishedProductNames fullyPublished assertFullyPublished;
  bootstrapPins = loaded.bootstrapPins;
  artifact = loaded.products.fixture.artifact;
  artifactUrl = loaded.products.fixture.artifactUrl;
  productNames = builtins.attrNames loaded.products;
  sourcePath = builtins.toString loaded.products.fixture.sourceRecipe;
}"
summary="$(nix eval --impure --json --expr "$loader_expr")"
jq -e --arg storePath "$store_path" --arg artifactUrl "$artifact_url" '
  .fullyPublished == true and
  .assertFullyPublished == true and
  .declaredProductNames == ["fixture"] and
  .publishedProductNames == ["fixture"] and
  .sourcePath == $storePath and
  .artifactUrl == $artifactUrl
' <<<"$summary" >/dev/null

# Only an exact digest serves cached bytes; absent and stale rows use the recipe.
jq -e --arg artifact "$store_path/fixture.js" '
  .artifact == $artifact and (.bootstrapPins | keys) == ["genie"] and
  (.bootstrapPins.genie | length > 0)
' <<<"$summary" >/dev/null
cp "$tmp/products/manifest.json" "$tmp/products/manifest.digestless.json"
for digest in a b; do
  jq --arg digest "$digest" --arg evidence "$FIXTURE_EVIDENCE_STORE_PATH" --arg sha "$evidence_sha" \
    '.products[0] += {recipeIdentity:($digest * 64),sourceEvidenceStorePath:$evidence,sourceEvidenceSha256:$sha}' \
    "$tmp/products/manifest.digestless.json" >"$tmp/products/manifest.json"
  actual="$(nix eval --impure --json --expr "$loader_expr")"
  if [[ "$digest" == a ]]; then
    jq -e '.artifact == "/nix/store/validated-fixture/fixture.js"' <<<"$actual" >/dev/null
    RECIPE_CHANGED=1 nix eval --impure --json --expr "$loader_expr" |
      jq -e --arg artifact "$store_path/fixture.js" '.artifact == $artifact' >/dev/null
  else
    jq -e --arg artifact "$store_path/fixture.js" '.artifact == $artifact' <<<"$actual" >/dev/null
  fi
done
# Exercise the actual cached derivation's build script, without building a product.
jq --arg sha "$collision_sha" --arg integrity "$collision_integrity" '
  .products[0] |= (.recipeIdentity = ("a" * 64) | .sha256 = $sha | .size = 8 |
    .provenance.productDigest = $sha | .descriptor.integrity = $integrity | .descriptor.sizeBytes = 8)
' "$tmp/products/manifest.json" >"$tmp/products/manifest.build.json"
descriptor_sha="$(jq -cS '.products[0].descriptor' "$tmp/products/manifest.build.json" | tr -d '\n' | sha256sum | cut -d' ' -f1)"
jq --arg sha "$descriptor_sha" '.products[0].descriptorSha256 = $sha' \
  "$tmp/products/manifest.build.json" >"$tmp/products/manifest.json"
jq '.recipeIdentity = ("a" * 64)' "$tmp/evidence-output/source-evidence.json" >"$tmp/source-evidence.json"
matching_evidence_sha="$(sha256sum "$tmp/source-evidence.json" | cut -d' ' -f1)"
jq --arg sha "$matching_evidence_sha" '.products[0].sourceEvidenceSha256 = $sha' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.hash.json"
mv "$tmp/products/manifest.hash.json" "$tmp/products/manifest.json"
script="$(nix eval --impure --raw --expr "$loader_bindings in loaded.products.fixture.validated.script")"
out="$tmp/checked-positive" bash -c "$script"
cmp "$tmp/checked-positive/fixture.js" "$collision_store/fixture.js"
# A manifest-only digest edit cannot relabel evidence from another source.
cp "$tmp/evidence-output/source-evidence.json" "$tmp/source-evidence.json"
jq --arg sha "$evidence_sha" '.products[0].sourceEvidenceSha256 = $sha' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.hash.json"
mv "$tmp/products/manifest.hash.json" "$tmp/products/manifest.json"
script="$(nix eval --impure --raw --expr "$loader_bindings in loaded.products.fixture.validated.script")"
if out="$tmp/checked-negative" bash -c "$script" >"$tmp/evidence-mismatch.log" 2>&1; then
  echo "buck2-cache-products-test: cached build accepted stale source evidence" >&2
  exit 1
fi
[[ ! -e "$tmp/checked-negative/fixture.js" ]]
jq 'del(.products[0].sourceEvidenceStorePath,.products[0].sourceEvidenceSha256)' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.no-evidence.json"
mv "$tmp/products/manifest.no-evidence.json" "$tmp/products/manifest.json"
nix eval --impure --json --expr "$loader_expr" |
  jq -e --arg artifact "$store_path/fixture.js" '.artifact == $artifact' >/dev/null
# The declared bootstrap pin is honored even without a digest.
cp "$tmp/products/cache-targets.json" "$tmp/products/cache-targets.fixture.json"
jq '.products[0].name = "genie"' "$tmp/products/cache-targets.fixture.json" >"$tmp/products/cache-targets.json"
jq '.products[0].name = "genie" | .products[0].descriptor.productName = "genie"' \
  "$tmp/products/manifest.digestless.json" >"$tmp/products/manifest.json"
genie_descriptor_sha="$(jq -cS '.products[0].descriptor' "$tmp/products/manifest.json" | tr -d '\n' | sha256sum | cut -d' ' -f1)"
jq --arg sha "$genie_descriptor_sha" '.products[0].descriptorSha256 = $sha' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.genie.json"
mv "$tmp/products/manifest.genie.json" "$tmp/products/manifest.json"
nix eval --impure --json --expr "${loader_bindings/fromSourceProducts.fixture/fromSourceProducts.genie}
in loaded.products.genie.artifact" |
  jq -e '. == "/nix/store/validated-fixture/fixture.js"' >/dev/null
cp "$tmp/products/cache-targets.fixture.json" "$tmp/products/cache-targets.json"
cp "$tmp/products/manifest.digestless.json" "$tmp/products/manifest.json"

# GREEN: a source PR may declare a new product before post-merge publication.
cp "$tmp/products/cache-targets.json" "$tmp/products/cache-targets.exact.json"
jq '.products += [.products[0] | .name = "missing-fixture"]' \
  "$tmp/products/cache-targets.json" >"$tmp/products/cache-targets.missing.json"
mv "$tmp/products/cache-targets.missing.json" "$tmp/products/cache-targets.json"
MANIFEST_CHANGED=false nix eval --impure --json --expr "$inventory_expr" |
  jq -e '. == ["missing-fixture"]' >/dev/null

# RED: a PR editing the manifest must publish the entire declared inventory.
if MANIFEST_CHANGED=true nix eval --impure --json --expr "$inventory_expr" >"$tmp/missing.log" 2>&1; then
  echo "buck2-cache-products-test: manifest PR accepted a missing product" >&2
  exit 1
fi
grep -F 'missing products: ["missing-fixture"]; undeclared products: []' "$tmp/missing.log" >/dev/null
cp "$tmp/products/cache-targets.exact.json" "$tmp/products/cache-targets.json"

# RED: a manifest entry not declared by the inventory names the offending product.
cp "$tmp/products/manifest.json" "$tmp/products/manifest.exact.json"
jq '.products += [.products[0] | .name = "undeclared-fixture"]' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.undeclared.json"
mv "$tmp/products/manifest.undeclared.json" "$tmp/products/manifest.json"
if MANIFEST_CHANGED=false nix eval --impure --json --expr "$inventory_expr" >"$tmp/undeclared.log" 2>&1; then
  echo "buck2-cache-products-test: source PR accepted an undeclared manifest product" >&2
  exit 1
fi
grep -F 'manifest contains undeclared products: ["undeclared-fixture"]' "$tmp/undeclared.log" >/dev/null
cp "$tmp/products/manifest.exact.json" "$tmp/products/manifest.json"

# GREEN: restoring the exact inventory/manifest match satisfies the same guard.
nix eval --impure --json --expr "$loader_expr" | jq -e '.assertFullyPublished == true' >/dev/null
MANIFEST_CHANGED=true nix eval --impure --json --expr "$inventory_expr" |
  jq -e '. == []' >/dev/null

cp "$tmp/products/manifest.json" "$tmp/products/manifest.v2.json"
jq '.schema = "effect-utils/buck-cache-products/v3"' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.v3.json"
mv "$tmp/products/manifest.v3.json" "$tmp/products/manifest.json"
if nix eval --impure --json --expr "$loader_expr" >"$tmp/schema.log" 2>&1; then
  echo "buck2-cache-products-test: loader accepted an unsupported manifest schema" >&2
  exit 1
fi
grep -F 'unsupported manifest schema' "$tmp/schema.log" >/dev/null
mv "$tmp/products/manifest.v2.json" "$tmp/products/manifest.json"

jq '.products[0].artifactUrl = "https://overeng-effect-utils.cachix.org/serve/11111111111111111111111111111111/fixture.js"' \
  "$tmp/products/manifest.json" >"$tmp/products/manifest.mutated.json"
mv "$tmp/products/manifest.mutated.json" "$tmp/products/manifest.json"
if nix eval --impure --json --expr "$loader_expr" >"$tmp/mismatch.log" 2>&1; then
  echo "buck2-cache-products-test: loader accepted a mismatched artifact URL" >&2
  exit 1
fi
grep -F 'artifact URL does not match its store path and artifact' "$tmp/mismatch.log" >/dev/null

echo "buck2-cache-products-test: OK"
