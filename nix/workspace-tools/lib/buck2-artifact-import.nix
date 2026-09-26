# Verify and import a published Buck2 build product into the Nix store.
#
# The descriptor is known at evaluation, so its digest pins the fetched payload.
# Realization (build-time descriptor contract, payload digest, archive scan,
# runtime inspection) is the shared `buck2-artifact-realize.nix` path, the same
# one source-built products use.
{
  pkgs,
  inspectElfDynamic ? import ./buck2-runtime-inspect-elf-dynamic.nix { inherit pkgs; },
  inspectElfStatic ? import ./buck2-runtime-inspect-elf-static.nix { inherit pkgs; },
  inspectMachODynamic ?
    if pkgs.stdenv.hostPlatform.isDarwin then
      import ./buck2-runtime-inspect-mach-o-dynamic.nix {
        inherit pkgs;
        inspectionTools = import ./buck2-darwin-inspection-tools.nix { inherit pkgs; };
      }
    else
      null,
}:

let
  lib = pkgs.lib;
  contract = import ./buck2-build-product-contract.nix;
  realize = import ./buck2-artifact-realize.nix {
    inherit
      pkgs
      inspectElfDynamic
      inspectElfStatic
      inspectMachODynamic
      ;
  };
in
{
  descriptor,
  expectedDescriptorDigest,
  expectedPlatform,
  url ? null,
  artifact ? null,
}:

let
  checkedDescriptor = contract.verifyDescriptor {
    inherit descriptor expectedDescriptorDigest;
  };
  payload = checkedDescriptor.payload;
  fetchedArtifact =
    if url == null then
      artifact
    else
      pkgs.fetchurl {
        inherit url;
        hash = payload.digest.sri;
      };
  descriptorFile = pkgs.writeText "${checkedDescriptor.name}-buck-build-product.json" (
    contract.canonicalDescriptorJson checkedDescriptor
  );
in
assert lib.assertMsg (builtins.isAttrs expectedPlatform)
  "buck2-artifact-import: expectedPlatform must be an exact platform attribute set";
assert lib.assertMsg (
  checkedDescriptor.platform == expectedPlatform
) "buck2-artifact-import: platform mismatch";
assert lib.assertMsg (
  !(url != null && artifact != null)
) "buck2-artifact-import: choose either a published URL or a declared artifact path";
assert lib.assertMsg (
  url != null || artifact != null
) "buck2-artifact-import: a published URL or declared artifact path is required";
realize {
  inherit (checkedDescriptor) name;
  inherit expectedPlatform expectedDescriptorDigest;
  runtimeKind = checkedDescriptor.runtime.kind;
  descriptorPath = lib.escapeShellArg "${descriptorFile}";
  archivePath = lib.escapeShellArg (toString fetchedArtifact);
  passthru = {
    descriptorDigest = expectedDescriptorDigest;
    inherit checkedDescriptor;
  };
}
