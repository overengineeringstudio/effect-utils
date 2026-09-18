# Pure loader for immutable Buck-produced JavaScript and npm package assets.
#
# The generated target inventory is desired product authority; the publisher is
# the sole producer of the tracked manifest. Evaluation requires both sets to
# match exactly, validates every canonical descriptor/release binding, and
# realizes only the declared content-addressed module bytes.
{ pkgs }:

let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile ./manifest.json);
  targets = builtins.fromJSON (builtins.readFile ./targets.json);
  targetGenerator = "effect-utils/genie/buck2-javascript-release-targets";
  targetFingerprint = "sha256:${
    builtins.hashString "sha256" (
      builtins.toJSON {
        generator = targetGenerator;
        schemaVersion = targets.schemaVersion;
        semanticData = targets.products;
      }
    )
  }";
  repositoryReleaseBase = "https://github.com/overengineeringstudio/effect-utils/releases/download";
  expectedJavascriptDescriptorKeys = [
    "externalCapabilities"
    "externalModules"
    "integrity"
    "modulePath"
    "platform"
    "productKind"
    "productName"
    "provenance"
    "runtimeContract"
    "runtimeContractVersion"
    "runtimeKind"
    "schema"
    "sizeBytes"
    "target"
  ];
  expectedPackageDescriptorKeys = [
    "dependencies"
    "externalCapabilities"
    "externalModules"
    "integrity"
    "modulePath"
    "platform"
    "productKind"
    "productName"
    "provenance"
    "release"
    "runtimeContract"
    "runtimeContractVersion"
    "runtimeKind"
    "schema"
    "sha256"
    "sha512"
    "sizeBytes"
    "target"
    "transportSlug"
    "version"
  ];
  validModulePathSegment =
    path: builtins.isString path && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" path != null;
  validJavascriptProductName =
    name: builtins.isString name && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" name != null;
  validPackageName =
    name:
    builtins.isString name
    && builtins.match "@[a-z0-9~][a-z0-9._~-]*/[a-z0-9~][a-z0-9._~-]*" name != null;
  validSriSha256 =
    hash: builtins.isString hash && builtins.match "sha256-[A-Za-z0-9+/]{43}=" hash != null;
  validSriSha512 =
    hash: builtins.isString hash && builtins.match "sha512-[A-Za-z0-9+/]{86}==" hash != null;
  checkedProduct =
    entry:
    let
      descriptor = entry.descriptor;
      release = entry.release;
      productName = descriptor.productName;
      isJavascript = descriptor.schema == "effect-utils/javascript-product/v2";
      isPackage = descriptor.schema == "effect-utils/npm-package-product/v2";
      moduleSha256 =
        if isPackage then
          descriptor.sha256
        else
          builtins.convertHash {
            hash = descriptor.integrity;
            toHashFormat = "base16";
          };
      integritySha256 = builtins.convertHash {
        hash = descriptor.integrity;
        toHashFormat = "base16";
      };
      moduleSha512 =
        if isPackage then
          builtins.convertHash {
            hash = descriptor.sha512;
            toHashFormat = "base16";
          }
        else
          null;
      transportName = if isPackage then descriptor.transportSlug else productName;
      canonicalDescriptor = builtins.toJSON descriptor;
      derivedTag =
        if isPackage then
          "buck2-package-v1-${descriptor.transportSlug}-${moduleSha256}"
        else
          "buck2-product-v3-${productName}-${moduleSha256}";
      derivedName =
        if isPackage then
          "${moduleSha256}-${descriptor.transportSlug}.tgz"
        else
          "${moduleSha256}-${descriptor.modulePath}";
      derivedUrl = "${repositoryReleaseBase}/${derivedTag}/${derivedName}";
      descriptorFile = pkgs.writeText "${transportName}-product.json" canonicalDescriptor;
      downloadedArtifact = pkgs.fetchurl {
        name = release.name;
        inherit (release) url hash;
      };
      artifact =
        if isPackage then
          pkgs.runCommand release.name { } ''
            actual="$(${pkgs.coreutils}/bin/sha512sum ${downloadedArtifact})"
            test "''${actual%% *}" = "${moduleSha512}"
            cp ${downloadedArtifact} "$out"
          ''
        else
          downloadedArtifact;
      validPackageDependency =
        name: dependency:
        validPackageName name
        && builtins.isAttrs dependency
        && builtins.attrNames dependency == [
          "integrity"
          "url"
        ]
        && validSriSha512 dependency.integrity
        && builtins.isString dependency.url
        && builtins.match "https://github\\.com/overengineeringstudio/effect-utils/releases/download/[^[:space:]]+/[^[:space:]/]+"
          dependency.url != null;
    in
    assert lib.assertMsg (
      isJavascript || isPackage
    ) "buck2-products: ${productName} has an unsupported descriptor schema";
    assert lib.assertMsg (
      builtins.attrNames entry
      == (
        if isPackage then
          [
            "descriptor"
            "descriptorSha256"
            "producerCommit"
            "release"
          ]
        else
          [
            "descriptor"
            "descriptorSha256"
            "release"
          ]
      )
    ) "buck2-products: ${productName} manifest product fields are not exact";
    assert lib.assertMsg (
      builtins.attrNames descriptor
      == (if isPackage then expectedPackageDescriptorKeys else expectedJavascriptDescriptorKeys)
    ) "buck2-products: ${productName} descriptor fields are not exact";
    assert lib.assertMsg (
      if isPackage then validPackageName productName else validJavascriptProductName productName
    ) "buck2-products: descriptor has an unsafe product name";
    assert lib.assertMsg (
      if isPackage then
        descriptor.productKind == "package"
        && descriptor.runtimeKind == "node"
        && descriptor.runtimeContract == "npm-package"
        && descriptor.runtimeContractVersion == "v1"
      else
        builtins.elem descriptor.productKind [
          "cli"
          "module"
        ]
        && builtins.elem descriptor.runtimeKind [
          "bun"
          "node"
        ]
        && descriptor.runtimeContract == "javascript-esm"
        && descriptor.runtimeContractVersion == "v1"
    ) "buck2-products: ${productName} has an unsupported runtime contract";
    assert lib.assertMsg (
      descriptor.platform == {
        abi = "any";
        architecture = "any";
        os = "any";
      }
    ) "buck2-products: ${productName} is not platform-invariant";
    assert lib.assertMsg (validModulePathSegment descriptor.modulePath)
      "buck2-products: ${productName} module path is not one release-asset-safe path segment";
    assert lib.assertMsg (
      !isPackage
      || (
        builtins.isString descriptor.transportSlug
        && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" descriptor.transportSlug != null
        && descriptor.modulePath == "${descriptor.transportSlug}.tgz"
      )
    ) "buck2-products: ${productName} has an invalid transport slug or archive path";
    assert lib.assertMsg (
      !isPackage || (builtins.isString descriptor.version && descriptor.version != "")
    ) "buck2-products: ${productName} has an invalid package version";
    assert lib.assertMsg (
      builtins.isList descriptor.externalCapabilities
      && builtins.all builtins.isString descriptor.externalCapabilities
    ) "buck2-products: ${productName} has invalid external capabilities";
    assert lib.assertMsg (
      builtins.isList descriptor.externalModules
      && builtins.all builtins.isString descriptor.externalModules
    ) "buck2-products: ${productName} has invalid external modules";
    assert lib.assertMsg (
      builtins.attrNames descriptor.provenance == [
        "configuredTarget"
        "dependencyClosureIdentity"
        "module"
      ]
      && builtins.all builtins.isString (builtins.attrValues descriptor.provenance)
    ) "buck2-products: ${productName} has invalid provenance";
    assert lib.assertMsg (builtins.isString descriptor.target)
      "buck2-products: ${productName} has an invalid target";
    assert lib.assertMsg (
      builtins.isInt descriptor.sizeBytes && descriptor.sizeBytes > 0
    ) "buck2-products: ${productName} descriptor declares no payload size";
    assert lib.assertMsg (
      validSriSha256 descriptor.integrity
    ) "buck2-products: ${productName} integrity must be an SRI SHA-256 digest";
    assert lib.assertMsg (
      !isPackage
      || (
        builtins.isString descriptor.sha256
        && builtins.match "[0-9a-f]{64}" descriptor.sha256 != null
        && descriptor.sha256 == integritySha256
      )
    ) "buck2-products: ${productName} package sha256 does not match integrity";
    assert lib.assertMsg (
      !isPackage || validSriSha512 descriptor.sha512
    ) "buck2-products: ${productName} package sha512 must be an SRI SHA-512 digest";
    assert lib.assertMsg (
      !isPackage
      || (
        builtins.isAttrs descriptor.dependencies
        && builtins.all (
          name: validPackageDependency name descriptor.dependencies.${name}
        ) (builtins.attrNames descriptor.dependencies)
      )
    ) "buck2-products: ${productName} has an invalid package dependency release";
    assert lib.assertMsg (
      !isPackage
      || (
        builtins.attrNames descriptor.release == [
          "name"
          "tag"
          "url"
        ]
        && descriptor.release == {
          name = derivedName;
          tag = derivedTag;
          url = derivedUrl;
        }
      )
    ) "buck2-products: ${productName} package descriptor release does not match its payload";
    assert lib.assertMsg (
      !isPackage
      || (
        builtins.isString entry.producerCommit
        && builtins.match "[0-9a-f]{40}" entry.producerCommit != null
      )
    ) "buck2-products: ${productName} producerCommit must be lowercase commit hex";
    assert lib.assertMsg (
      builtins.isString entry.descriptorSha256
      && builtins.match "[0-9a-f]{64}" entry.descriptorSha256 != null
    ) "buck2-products: ${productName} descriptorSha256 must be lowercase SHA-256 hex";
    assert lib.assertMsg (
      builtins.hashString "sha256" canonicalDescriptor == entry.descriptorSha256
    ) "buck2-products: ${productName} canonical descriptor digest mismatch";
    assert lib.assertMsg (
      builtins.attrNames release == [
        "hash"
        "name"
        "tag"
        "url"
      ]
    ) "buck2-products: ${productName} release fields are not exact";
    assert lib.assertMsg (
      release.tag == derivedTag
    ) "buck2-products: ${productName} release tag does not match its product and payload digest";
    assert lib.assertMsg (release.name == derivedName)
      "buck2-products: ${productName} release asset name does not match its payload digest and module path";
    assert lib.assertMsg (
      release.url == derivedUrl
    ) "buck2-products: ${productName} release URL does not match its tag and asset name";
    assert lib.assertMsg (
      release.hash == descriptor.integrity
    ) "buck2-products: ${productName} release hash does not match descriptor integrity";
    {
      name = productName;
      value = {
        inherit artifact release;
        descriptor = descriptorFile;
        descriptorContent = canonicalDescriptor;
        expectedDescriptorSha256 = entry.descriptorSha256;
        expectedModuleSha256 = moduleSha256;
      }
      // (
        if isPackage then
          {
            expectedModuleSha512 = moduleSha512;
            producerCommit = entry.producerCommit;
          }
        else
          { }
      );
    };
  checkedProducts = map checkedProduct manifest.products;
  publishedProductNames = map (entry: entry.name) checkedProducts;
  releaseTags = map (entry: entry.value.release.tag) checkedProducts;
  uniquePublishedProductNames = lib.unique publishedProductNames;
  uniqueReleaseTags = lib.unique releaseTags;
  declaredProductNames = map (product: product.name) targets.products;
  declaredProductTargets = map (product: product.target) targets.products;
  sortProducts = builtins.sort (left: right: left.name < right.name);
  declaredProducts = sortProducts targets.products;
  publishedProducts = sortProducts (
    map (entry: {
      name = entry.name;
      target = (builtins.fromJSON entry.value.descriptorContent).target;
    }) checkedProducts
  );
in
assert lib.assertMsg (
  builtins.attrNames targets == [
    "products"
    "provenance"
    "schemaVersion"
  ]
) "buck2-products: target inventory fields are not exact";
assert lib.assertMsg (
  targets.schemaVersion == 1
) "buck2-products: unsupported target inventory schema";
assert lib.assertMsg (
  builtins.attrNames targets.provenance == [
    "fingerprint"
    "generator"
    "regenerationCommand"
    "semanticInputs"
    "source"
  ]
  && targets.provenance.generator == targetGenerator
  && targets.provenance.regenerationCommand == "devenv tasks run genie:run"
  &&
    targets.provenance.semanticInputs == [
      "genie/buck2/javascript-product-registry.ts"
      "nix/buck2-products/targets.json.genie.ts"
    ]
  && targets.provenance.source == "nix/buck2-products/targets.json.genie.ts"
) "buck2-products: target inventory provenance is invalid";
assert lib.assertMsg (
  targets.provenance.fingerprint == targetFingerprint
) "buck2-products: target inventory fingerprint mismatch";
assert lib.assertMsg (
  builtins.isList targets.products
  && targets.products != [ ]
  && builtins.all (
    product:
    builtins.attrNames product == [
      "name"
      "target"
    ]
    && builtins.isString product.name
    && (validJavascriptProductName product.name || validPackageName product.name)
    && builtins.isString product.target
    && builtins.match "([A-Za-z0-9_]+)?//[^][[:space:]]+:[^][[:space:]]+" product.target != null
  ) targets.products
) "buck2-products: target inventory products are malformed";
assert lib.assertMsg (
  builtins.length (lib.unique declaredProductNames) == builtins.length declaredProductNames
) "buck2-products: target inventory product names must be unique";
assert lib.assertMsg (
  builtins.length (lib.unique declaredProductTargets) == builtins.length declaredProductTargets
) "buck2-products: target inventory product targets must be unique";
assert lib.assertMsg (
  builtins.attrNames manifest == [
    "products"
    "schema"
  ]
) "buck2-products: manifest fields are not exact";
assert lib.assertMsg (
  manifest.schema == "effect-utils/buck2-release-products/v1"
) "buck2-products: unsupported manifest schema";
assert lib.assertMsg (
  builtins.isList manifest.products && manifest.products != [ ]
) "buck2-products: manifest products must be a non-empty list";
assert lib.assertMsg (
  builtins.length uniquePublishedProductNames == builtins.length publishedProductNames
) "buck2-products: product names must be unique";
assert lib.assertMsg (
  declaredProducts == publishedProducts
) "buck2-products: declared target inventory does not match the published manifest";
assert lib.assertMsg (
  builtins.length uniqueReleaseTags == builtins.length releaseTags
) "buck2-products: each product payload must have one unique release";
{
  inherit manifest targets;
  declaredProductNames = builtins.sort builtins.lessThan declaredProductNames;
  publishedProductNames = builtins.sort builtins.lessThan publishedProductNames;
  products = builtins.listToAttrs checkedProducts;
  fullyPublished = true;
}
