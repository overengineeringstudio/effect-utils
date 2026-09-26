# Import a native build_product rebuilt from source by `mkBuckProductFromSource`
# (`product.kind = "native"`). The descriptor exists only inside that build, so
# nothing about it is read at evaluation: the shared realization re-runs the
# descriptor contract at build time and binds it to what the caller declares
# here from the Buck target (product name, target label, platform, runtime).
{
  pkgs,
  realize ? import ../workspace-tools/lib/buck2-artifact-realize.nix { inherit pkgs; },
}:

let
  hostPlatform = pkgs.stdenv.hostPlatform;
  defaultPlatform =
    if hostPlatform.isDarwin then
      {
        os = "darwin";
        architecture = hostPlatform.parsed.cpu.name;
        abi = "darwin";
      }
    else
      {
        os = "linux";
        architecture = hostPlatform.parsed.cpu.name;
        abi = hostPlatform.libc;
      };
in
{
  sourceProduct,
  expectedPlatform ? defaultPlatform,
  runtimeKind ? if hostPlatform.isDarwin then "mach-o-dynamic" else "elf-dynamic",
}:

assert pkgs.lib.assertMsg (
  (sourceProduct.productKind or null) == "native"
) "buck2-native-source-import: sourceProduct must be a mkBuckProductFromSource native product";
realize {
  name = sourceProduct.productName;
  inherit expectedPlatform runtimeKind;
  expectedTarget = sourceProduct.target;
  descriptorPath = pkgs.lib.escapeShellArg "${sourceProduct}/descriptor.json";
  archivePath = pkgs.lib.escapeShellArg "${sourceProduct}/${sourceProduct.artifactName}";
  passthru.buck2Product = sourceProduct;
}
