# Private package products staged for pnpm consumers (decision 0037 clause 4).
#
# The producer manifest's `storePath` is the substitution identity. The loader
# never re-evaluates the producer recipe: that input-addressed path depends on
# the producer's own tree and locked inputs at its producer commit, so any
# consumer evaluation at a later commit or with `follows` overrides names a
# different path. String context on the recorded path makes Nix substitute it
# from the configured binary caches (the daemon holds the private cache
# credential); nothing is built during evaluation. A fixed-output copy then pins
# the tarball bytes to the manifest digest.
{
  pkgs,
  # Parsed producer manifest (`<producer>/buck-cache-products/v1` shape).
  manifest,
  # Exact manifest schema the caller expects from its producer.
  schema,
}:

let
  lib = pkgs.lib;
  safeName = name: lib.replaceStrings [ "@" "/" ] [ "" "-" ] name;
  checkedProduct =
    entry:
    let
      name = entry.name;
      provenance = entry.provenance;
      artifactName = "${safeName name}.tgz";
      # Digest-bearing name: the staged `file:` identity, and therefore the
      # consumer lock entry, changes whenever the product bytes change.
      fileName = "${safeName name}-${entry.version}-${entry.sha256}.tgz";
      # A miss fails evaluation closed (decision 0037 amendment 3): the consumer cannot
      # reproduce the producer's input-addressed path, so recovery is a producer rebuild
      # and push at its producer commit.
      published =
        builtins.addErrorContext
          "private product ${name} ${entry.version} (${entry.storePath}) is not substitutable from cache ${manifest.cache}; rebuild it at producer commit ${provenance.producerCommit} with the producer's own lock and push that store path to ${manifest.cache}"
          (
            builtins.appendContext entry.storePath {
              ${entry.storePath} = {
                path = true;
              };
            }
          );
      tarball =
        pkgs.runCommand "${entry.sha256}.tgz"
          {
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.jq
            ];
            outputHashMode = "flat";
            outputHashAlgo = "sha256";
            outputHash = entry.sha256;
            passthru = {
              inherit (entry)
                sha256
                size
                storePath
                version
                ;
              inherit fileName name provenance;
            };
          }
          ''
            set -euo pipefail
            artifact=${lib.escapeShellArg "${published}/${artifactName}"}
            test -f "$artifact"
            test "$(stat -c '%s' "$artifact")" = ${toString entry.size}
            jq -e \
              --arg producerCommit ${lib.escapeShellArg provenance.producerCommit} \
              --arg target ${lib.escapeShellArg provenance.target} \
              --arg productDigest ${lib.escapeShellArg provenance.productDigest} \
              '(keys | sort) == ["producerCommit","productDigest","schema","target"] and
               .schema == "effect-utils/buck-product-provenance/v1" and
               .producerCommit == $producerCommit and .target == $target and
               .productDigest == $productDigest' \
              ${lib.escapeShellArg "${published}/provenance.json"} >/dev/null
            cp "$artifact" "$out"
          '';
    in
    assert lib.assertMsg (
      builtins.attrNames entry == [
        "name"
        "provenance"
        "sha256"
        "size"
        "storePath"
        "version"
      ]
    ) "private-product-tarballs: ${toString (entry.name or "<unnamed>")} fields are not exact";
    assert lib.assertMsg (
      builtins.isString name && builtins.match "@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*" name != null
    ) "private-product-tarballs: product name must be a scoped npm package name";
    assert lib.assertMsg (
      builtins.isString entry.version && builtins.match "[0-9A-Za-z.+-]+" entry.version != null
    ) "private-product-tarballs: ${name} has an invalid version";
    assert lib.assertMsg (
      builtins.match "[0-9a-f]{64}" entry.sha256 != null
    ) "private-product-tarballs: ${name} sha256 must be lowercase hexadecimal";
    assert lib.assertMsg (
      builtins.isInt entry.size && entry.size > 0
    ) "private-product-tarballs: ${name} size must be a positive integer";
    assert lib.assertMsg (
      builtins.match "/nix/store/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+" entry.storePath != null
    ) "private-product-tarballs: ${name} has an invalid store path";
    assert lib.assertMsg (
      builtins.attrNames provenance == [
        "producerCommit"
        "productDigest"
        "schema"
        "target"
      ]
      && provenance.schema == "effect-utils/buck-product-provenance/v1"
      && builtins.match "[0-9a-f]{40}" provenance.producerCommit != null
      && builtins.isString provenance.target
      && provenance.productDigest == entry.sha256
    ) "private-product-tarballs: ${name} has invalid provenance";
    {
      inherit name;
      value = tarball;
    };
  products = builtins.listToAttrs (map checkedProduct manifest.products);
  productNames = map (entry: entry.name) manifest.products;
  digests = lib.mapAttrsToList (_: tarball: tarball.sha256) products;
in
assert lib.assertMsg (
  builtins.attrNames manifest == [
    "cache"
    "products"
    "schema"
  ]
) "private-product-tarballs: manifest fields are not exact";
assert lib.assertMsg (
  manifest.schema == schema
) "private-product-tarballs: unsupported manifest schema ${toString manifest.schema}";
assert lib.assertMsg (
  builtins.isString manifest.cache && manifest.cache != ""
) "private-product-tarballs: manifest cache must be named";
assert lib.assertMsg (
  builtins.isList manifest.products && manifest.products != [ ]
) "private-product-tarballs: manifest products must be a non-empty list";
assert lib.assertMsg (
  builtins.length productNames == builtins.length (lib.unique productNames)
) "private-product-tarballs: product names must be unique";
assert lib.assertMsg (
  builtins.length digests == builtins.length (lib.unique digests)
) "private-product-tarballs: product digests must be unique";
{
  inherit products;
  # Per-digest archives for `pnpm-archives.nix` `productArchives`.
  archivesByDigest = lib.mapAttrs' (_: tarball: lib.nameValuePair tarball.sha256 tarball) products;
  # `<sha256>.tgz` tree for Buck `nix_store.product_root` (live consumer builds).
  archiveRoot = pkgs.linkFarm "private-product-archives" (
    lib.mapAttrsToList (_: tarball: {
      name = "${tarball.sha256}.tgz";
      path = tarball;
    }) products
  );
  # The consumer staging directory: one digest-named tarball per product.
  stage = pkgs.linkFarm "private-product-tarballs" (
    lib.mapAttrsToList (_: tarball: {
      name = tarball.fileName;
      path = tarball;
    }) products
  );
}
