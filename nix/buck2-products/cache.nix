# Pure loader for Buck products distributed through Nix substitution.
{
  pkgs,
  fromSourceProducts,
}:

let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile ./manifest.json);
  targetInventory = builtins.fromJSON (builtins.readFile ./cache-targets.json);
  declaredProductNames = builtins.sort builtins.lessThan (
    map (product: product.name) targetInventory.products
  );
  targetByName = builtins.listToAttrs (
    map (product: {
      inherit (product) name;
      value = product;
    }) targetInventory.products
  );
  cacheBase = "https://overeng-effect-utils.cachix.org/serve";
  validName =
    value: builtins.isString value && builtins.match "[A-Za-z0-9@][A-Za-z0-9@._+/-]*" value != null;
  checkedProduct =
    entry:
    let
      name = entry.name;
      recipe = fromSourceProducts.${name} or (throw "buck2-products: no source recipe for ${name}");
      declared =
        targetByName.${name} or (throw "buck2-products: manifest contains undeclared product ${name}");
      hasDescriptor = declared.kind == "javascript";
      descriptorContent = if hasDescriptor then builtins.toJSON entry.descriptor else null;
      expectedIntegrity = builtins.convertHash {
        hash = entry.sha256;
        hashAlgo = "sha256";
        toHashFormat = "sri";
      };
      artifactName = recipe.artifactName;
      publishedStore = builtins.fetchClosure {
        fromStore = "https://overeng-effect-utils.cachix.org";
        fromPath = entry.storePath;
        inputAddressed = true;
      };
      storeBaseName = builtins.baseNameOf entry.storePath;
      storeHash = builtins.head (lib.splitString "-" storeBaseName);
      expectedUrl = "${cacheBase}/${storeHash}/${artifactName}";
      provenance = entry.provenance;
      checkedArtifact =
        pkgs.runCommand "${lib.replaceStrings [ "@" "/" ] [ "" "-" ] name}-validated"
          {
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.jq
            ];
            passthru = {
              inherit (entry)
                artifactUrl
                provenance
                sha256
                size
                storePath
                version
                ;
              sourceRecipe = recipe;
            };
          }
          ''
            set -euo pipefail
            artifact=${lib.escapeShellArg "${publishedStore}/${artifactName}"}
            test -f "$artifact"
            test "$(sha256sum "$artifact" | cut -d' ' -f1)" = ${lib.escapeShellArg entry.sha256}
            test "$(stat -c '%s' "$artifact")" = ${toString entry.size}
            jq -e \
              --arg producerCommit ${lib.escapeShellArg provenance.producerCommit} \
              --arg target ${lib.escapeShellArg provenance.target} \
              --arg productDigest ${lib.escapeShellArg provenance.productDigest} \
              '(keys | sort) == ["producerCommit","productDigest","schema","target"] and
               .schema == "effect-utils/buck-product-provenance/v1" and
               .producerCommit == $producerCommit and .target == $target and
               .productDigest == $productDigest' \
              ${publishedStore}/provenance.json >/dev/null
            mkdir -p "$out"
            cp "$artifact" "$out/${artifactName}"
            cp ${publishedStore}/provenance.json "$out/provenance.json"
          '';
    in
    assert lib.assertMsg (
      builtins.attrNames entry == [
        "artifactUrl"
      ]
      ++ (
        if hasDescriptor then
          [
            "descriptor"
            "descriptorSha256"
          ]
        else
          [ ]
      )
      ++ [
        "name"
        "provenance"
        "sha256"
        "size"
        "storePath"
        "version"
      ]
    ) "buck2-products: ${name} manifest fields are not exact";
    assert lib.assertMsg (validName name) "buck2-products: product has an unsafe name";
    assert lib.assertMsg (
      builtins.isString entry.version && entry.version != ""
    ) "buck2-products: ${name} has an invalid version";
    assert lib.assertMsg (
      entry.version == declared.version
    ) "buck2-products: ${name} version does not match the generated inventory";
    assert lib.assertMsg (
      builtins.match "[0-9a-f]{64}" entry.sha256 != null
    ) "buck2-products: ${name} sha256 must be lowercase hexadecimal";
    assert lib.assertMsg (
      builtins.isInt entry.size && entry.size > 0
    ) "buck2-products: ${name} size must be a positive integer";
    assert lib.assertMsg (
      builtins.match "/nix/store/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+" entry.storePath != null
    ) "buck2-products: ${name} has an invalid store path";
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
      && provenance.target == declared.target
      && recipe.target == declared.target
      && provenance.productDigest == entry.sha256
    ) "buck2-products: ${name} has invalid provenance";
    assert lib.assertMsg (
      entry.artifactUrl == expectedUrl
    ) "buck2-products: ${name} artifact URL does not match its store path and artifact";
    assert lib.assertMsg (
      !hasDescriptor
      || (
        builtins.hashString "sha256" descriptorContent == entry.descriptorSha256
        && entry.descriptor.productName == name
        && entry.descriptor.target == declared.target
        && entry.descriptor.integrity == expectedIntegrity
        && entry.descriptor.sizeBytes == entry.size
      )
    ) "buck2-products: ${name} descriptor does not bind the cached artifact";
    {
      inherit name;
      value = {
        artifact = "${checkedArtifact}/${artifactName}";
        expectedModuleSha256 = entry.sha256;
        inherit (entry)
          artifactUrl
          provenance
          storePath
          version
          ;
        sourceRecipe = recipe;
        validated = checkedArtifact;
      }
      // (
        if hasDescriptor then
          {
            descriptor = pkgs.writeText "${lib.replaceStrings [ "@" "/" ] [ "" "-" ] name}-product.json" descriptorContent;
            inherit descriptorContent;
            expectedDescriptorSha256 = entry.descriptorSha256;
          }
        else
          { }
      );
    };
  checkedProducts = map checkedProduct manifest.products;
  productNames = map (entry: entry.name) checkedProducts;
  uniqueProductNames = lib.unique productNames;
in
assert lib.assertMsg (
  builtins.attrNames targetInventory == [
    "products"
    "schema"
    "schemaVersion"
  ]
  && targetInventory.schema == "effect-utils/buck-cache-targets/v1"
  && targetInventory.schemaVersion == 1
) "buck2-products: generated target inventory is invalid";
assert lib.assertMsg (
  builtins.length declaredProductNames == builtins.length (lib.unique declaredProductNames)
) "buck2-products: generated target names must be unique";
assert lib.assertMsg (
  builtins.attrNames manifest == [
    "products"
    "schema"
  ]
) "buck2-products: manifest fields are not exact";
assert lib.assertMsg (
  manifest.schema == "effect-utils/buck-cache-products/v2"
) "buck2-products: unsupported manifest schema";
assert lib.assertMsg (
  builtins.isList manifest.products && manifest.products != [ ]
) "buck2-products: manifest products must be a non-empty list";
assert lib.assertMsg (
  builtins.length uniqueProductNames == builtins.length productNames
) "buck2-products: product names must be unique";
{
  inherit manifest declaredProductNames;
  publishedProductNames = builtins.sort builtins.lessThan productNames;
  products = builtins.listToAttrs checkedProducts;
  fullyPublished = declaredProductNames == builtins.sort builtins.lessThan productNames;
}
