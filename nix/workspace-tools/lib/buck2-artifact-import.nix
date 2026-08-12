# Verify and import a published Buck2 build product into the Nix store.
#
# This entry point intentionally rejects every runtime until a runtime-specific
# inspector exists. Shape validation is not runtime proof, and the former
# synthetic shell fixture must not make this bridge look admitted.
{ pkgs }:

let
  lib = pkgs.lib;
  contract = import ./buck2-build-product-contract.nix;
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
  checkedPlatform = checkedDescriptor.platform;
  runtimeKind = checkedDescriptor.runtime.kind;
in
assert lib.assertMsg (builtins.isAttrs expectedPlatform)
  "buck2-artifact-import: expectedPlatform must be an exact platform attribute set";
assert lib.assertMsg (
  checkedPlatform == expectedPlatform
) "buck2-artifact-import: platform mismatch";
assert lib.assertMsg (
  !(url != null && artifact != null)
) "buck2-artifact-import: choose either a published URL or a declared artifact path";
assert lib.assertMsg (
  url != null || artifact != null
) "buck2-artifact-import: a published URL or declared artifact path is required";
throw "buck2-artifact-import: runtime inspector is not available for ${runtimeKind}"
