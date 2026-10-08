#!/usr/bin/env bash
# Consumer fixture for private product tarballs (decision 0037 clause 4):
# a producer store path recorded in a manifest is substituted (here: added
# locally), staged as a digest-named pnpm `file:` tarball, locked with its
# integrity, projected into the Buck sidecar, and served to the sandboxed
# archive tree without any network fetch.
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
bun="${BUCK2_PRODUCTS_BUN:-bun}"
# The devenv `pnpm` guard admits direct invocations only under task passthrough.
pnpm() { DEVENV_TASK_PASSTHROUGH=1 command pnpm "$@"; }
work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() {
  printf 'private-product-tarballs: %s\n' "$*" >&2
  exit 1
}

# Producer output: `<safe-name>.tgz` plus provenance, as mkBuckProductFromSource emits.
mkdir -p "$work/package-src/package" "$work/producer"
cat >"$work/package-src/package/package.json" <<'JSON'
{"name":"@fixture/private-lib","version":"1.2.3","main":"index.js"}
JSON
printf 'module.exports = "private product bytes"\n' >"$work/package-src/package/index.js"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$work/package-src" -czf "$work/producer/fixture-private-lib.tgz" package
sha256="$(sha256sum "$work/producer/fixture-private-lib.tgz" | cut -d' ' -f1)"
size="$(stat -c '%s' "$work/producer/fixture-private-lib.tgz")"
jq -nS \
  --arg productDigest "$sha256" \
  '{schema:"effect-utils/buck-product-provenance/v1",producerCommit:"0123456789abcdef0123456789abcdef01234567",target:"fixture//packages/@fixture/private-lib:dist-package",productDigest:$productDigest}' \
  >"$work/producer/provenance.json"
store_path="$(nix store add-path --name fixture-private-lib-buck2-from-source-1.2.3 "$work/producer")"

write_manifest() {
  jq -n \
    --arg sha256 "$1" \
    --arg storePath "$2" \
    --argjson size "$size" \
    --slurpfile provenance "$work/producer/provenance.json" \
    '{cache:"fixture-private-cache",schema:"fixture/buck-cache-products/v1",products:[{name:"@fixture/private-lib",version:"1.2.3",sha256:$sha256,size:$size,storePath:$storePath,provenance:($provenance[0] + {productDigest:$sha256})}]}'
}
write_manifest "$sha256" "$store_path" >"$work/manifest.json"

export PRIVATE_PRODUCTS_REPO="$repo_root" PRIVATE_PRODUCTS_WORK="$work"
loader_expr='
  let
    flake = builtins.getFlake ("git+file://" + builtins.getEnv "PRIVATE_PRODUCTS_REPO");
    work = builtins.getEnv "PRIVATE_PRODUCTS_WORK";
    pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
    tarballs = flake.lib.mkPrivateProductTarballs {
      inherit pkgs;
      manifest = builtins.fromJSON (builtins.readFile (work + "/manifest.json"));
      schema = "fixture/buck-cache-products/v1";
    };
  in'
stage="$(nix build --impure --no-link --print-out-paths --expr "$loader_expr tarballs.stage")"
archive_root="$(nix build --impure --no-link --print-out-paths --expr "$loader_expr tarballs.archiveRoot")"
# The consumer's generated manifest names the same file through the Genie helper.
file_name="$("$bun" -e "
  import { projectPrivateProductTarballs } from '$repo_root/packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts'
  const { overrides } = projectPrivateProductTarballs({
    products: [{ name: '@fixture/private-lib', version: '1.2.3', sha256: '$sha256' }],
  })
  console.log(overrides['@fixture/private-lib'].split('/').at(-1))
")"
[[ "$file_name" == "fixture-private-lib-1.2.3-$sha256.tgz" ]] ||
  fail "Genie names $file_name, not the digest-named staged file"
cmp "$stage/$file_name" "$work/producer/fixture-private-lib.tgz" ||
  fail 'staged tarball does not carry the producer bytes'
cmp "$archive_root/$sha256.tgz" "$work/producer/fixture-private-lib.tgz" ||
  fail 'archive root does not carry the producer bytes'

# Consumer: the checked-in manifest names a root-relative staged path, never a store path.
consumer="$work/consumer"
mkdir -p "$consumer/.devenv"
ln -s "$stage" "$consumer/.devenv/pnpm-product-tarballs"
jq -n --arg spec "file:.devenv/pnpm-product-tarballs/$file_name" \
  '{name:"fixture-consumer",version:"0.0.0",private:true,dependencies:{"@fixture/private-lib":$spec}}' \
  >"$consumer/package.json"
printf 'allowBuilds: {}\nignoreScripts: true\n' >"$consumer/pnpm-workspace.yaml"
export npm_config_store_dir="$work/pnpm-store"
(cd "$consumer" && pnpm install --lockfile-only --offline >/dev/null)
grep -q "tarball: file:.devenv/pnpm-product-tarballs/$file_name" "$consumer/pnpm-lock.yaml" ||
  fail 'consumer lock does not record the digest-named file: identity'
if grep -q '/nix/store/' "$consumer/package.json" "$consumer/pnpm-lock.yaml"; then
  fail 'consumer manifest or lock leaked an absolute store path'
fi
(cd "$consumer" && pnpm install --frozen-lockfile --offline >/dev/null)
[[ "$(cd "$consumer" && "$bun" -e 'console.log(require("@fixture/private-lib"))')" == "private product bytes" ]] ||
  fail 'frozen offline install did not resolve the staged product'

# Buck sidecar: product row pinned by digest, bytes read from the staging path only.
cat >"$work/sidecar.ts" <<TS
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePnpmSha256Sidecar, translatePnpmLock } from '$repo_root/buck2/dependencies/pnpm-lock.ts'

const consumer = '$consumer'
const metadata = translatePnpmLock({
  lockfileText: readFileSync(join(consumer, 'pnpm-lock.yaml'), 'utf8'),
  workspaceText: readFileSync(join(consumer, 'pnpm-workspace.yaml'), 'utf8'),
})
const sidecar = await generatePnpmSha256Sidecar({
  metadata,
  fetchArchive: async (url) => {
    throw new Error(\`unexpected network fetch \${url}\`)
  },
  readProductTarball: async (relativePath) => readFileSync(join(consumer, relativePath)),
})
writeFileSync('$work/pnpm-lock.sha256.json', JSON.stringify(sidecar))
TS
"$bun" "$work/sidecar.ts"
jq -e --arg sha256 "$sha256" --arg tarball "file:.devenv/pnpm-product-tarballs/$file_name" \
  '.packages | to_entries | length == 1 and (.[0].value | .classification == "private" and .productTarball == $tarball and .sha256 == $sha256)' \
  "$work/pnpm-lock.sha256.json" >/dev/null || fail 'sidecar does not bind the product tarball digest'

archives_expr="$loader_expr
  import (builtins.getEnv \"PRIVATE_PRODUCTS_REPO\" + \"/nix/buck2-products/pnpm-archives.nix\") {
    inherit pkgs;
    sidecarPath = work + \"/pnpm-lock.sha256.json\";
    productArchives = tarballs.archivesByDigest;
  }"
pnpm_archives="$(nix build --impure --no-link --print-out-paths --expr "$archives_expr")"
cmp "$pnpm_archives/$sha256.tgz" "$work/producer/fixture-private-lib.tgz" ||
  fail 'sandbox archive tree does not serve the product bytes'

# Fail closed: no Nix-realized archive, a manifest digest the substituted bytes do not
# carry, an unsubstitutable path.
expect_failure() {
  local label="$1" pattern="$2"
  shift 2
  local output
  if output="$("$@" 2>&1)"; then fail "$label unexpectedly succeeded"; fi
  grep -Eq -- "$pattern" <<<"$output" || fail "$label failed without '$pattern': $output"
}
missing_expr="$loader_expr
  import (builtins.getEnv \"PRIVATE_PRODUCTS_REPO\" + \"/nix/buck2-products/pnpm-archives.nix\") {
    inherit pkgs;
    sidecarPath = work + \"/pnpm-lock.sha256.json\";
  }"
expect_failure 'archives without a product source' 'has no Nix-realized archive' \
  nix build --impure --no-link --expr "$missing_expr"
write_manifest "$(printf '0%.0s' {1..64})" "$store_path" >"$work/manifest.json"
expect_failure 'wrong manifest digest' 'builder failed|failed with exit code|hash mismatch' \
  nix build --impure --no-link --expr "$loader_expr tarballs.stage"
write_manifest "$sha256" "/nix/store/00000000000000000000000000000000-fixture-private-lib-missing" \
  >"$work/manifest.json"
expect_failure 'unsubstitutable store path' 'private product @fixture/private-lib 1.2.3 .* is not substitutable from cache fixture-private-cache' \
  nix build --impure --no-link --expr "$loader_expr tarballs.stage"

printf 'private product tarball consumer fixture passed (%s)\n' "$sha256"
