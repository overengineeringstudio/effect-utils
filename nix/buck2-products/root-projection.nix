# Rules and root metadata are separate from each product source closure.
{
  pkgs,
  repositoryRoot ? ../..,
  buckInputs ? import ./buck-inputs.nix {
    inherit repositoryRoot;
    inherit (pkgs) lib;
  },
}:
let
  paths = import ./root-projection-inputs.nix { inherit pkgs repositoryRoot buckInputs; };
in
pkgs.lib.fileset.toSource {
  root = repositoryRoot;
  fileset = pkgs.lib.fileset.unions (map (path: repositoryRoot + "/${path}") paths);
}
