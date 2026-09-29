{ pkgs, runtimeClosure }:

let
  artifact = ../../buck2/products/vite-runtime-fixture.mjs;
  content = builtins.readFile artifact;
  moduleDigest = builtins.hashFile "sha256" artifact;
  descriptorContent = builtins.toJSON {
    schema = "effect-utils/javascript-product/v2";
    productName = "vite-runtime-closure-fixture";
    productKind = "cli";
    runtimeKind = "node";
    runtimeContract = "javascript-esm";
    runtimeContractVersion = "v1";
    platform = {
      os = "any";
      architecture = "any";
      abi = "any";
    };
    target = "//buck2/products:vite_runtime_fixture_module";
    modulePath = "vite-runtime-fixture.mjs";
    externalCapabilities = [ ];
    externalModules = [ "@vitejs/plugin-react" "vite" ];
    integrity = builtins.convertHash {
      hash = moduleDigest;
      hashAlgo = "sha256";
      toHashFormat = "sri";
    };
    sizeBytes = builtins.stringLength content;
    provenance = { configuredTarget = "//buck2/products:vite_runtime_fixture_module"; };
  };
in
(import ../workspace-tools/lib/javascript-product-import.nix { inherit pkgs; }) {
  inherit artifact descriptorContent runtimeClosure;
  descriptor = artifact;
  expectedDescriptorSha256 = builtins.hashString "sha256" descriptorContent;
  expectedExternalModules = [ "@vitejs/plugin-react" "vite" ];
  expectedModuleSha256 = moduleDigest;
  expectedProductKind = "cli";
  expectedProductName = "vite-runtime-closure-fixture";
  binaryName = "vite-runtime-closure-fixture";
  generateCompletions = false;
  smokeTestArgs = [ ];
}
