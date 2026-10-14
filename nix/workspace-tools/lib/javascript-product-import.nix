# Import one Buck-produced JavaScript product into the Nix store.
#
# Published mode (javascript-published-import.nix) validates the release
# manifest's independently pinned descriptor at evaluation. Source mode
# (javascript-source-import.nix) is constructed only by from-source.nix and
# validates the descriptor and revision provenance during the importing build,
# so evaluation never reads the producer output.
{ pkgs }:

{
  sourceImport ? null,
  ...
}@args:
if sourceImport != null then
  import ./javascript-source-import.nix { inherit pkgs; } args
else
  import ./javascript-published-import.nix { inherit pkgs; } args
