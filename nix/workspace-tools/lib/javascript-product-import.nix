# Import one Buck-produced JavaScript product into the Nix store.
#
# Published mode (javascript-published-import.nix) validates the release
# manifest's independently pinned descriptor at evaluation. Source mode
# (javascript-source-import.nix) is constructed only by from-source.nix and
# validates the descriptor and revision provenance during the importing build,
# so evaluation never reads the producer output.
{ pkgs }:
let
  lib = pkgs.lib;
  published = import ./javascript-published-import.nix { inherit pkgs; };
  source = import ./javascript-source-import.nix { inherit pkgs; };
  # One call contract for both modes: any parameter of either mode is
  # accepted, and each mode receives only its own parameters.
  accepted = builtins.functionArgs published // builtins.functionArgs source;
in
args:
let
  unexpected = builtins.attrNames (removeAttrs args (builtins.attrNames accepted));
in
assert lib.assertMsg (
  unexpected == [ ]
) "javascript-product-import: unexpected argument(s): ${toString unexpected}";
if (args.sourceImport or null) != null then
  source (builtins.intersectAttrs (builtins.functionArgs source) args)
else
  published (builtins.intersectAttrs (builtins.functionArgs published) args)
