{
  pkgs,
  gitRev ? "unknown",
  workspaceRoot ? ./.,
  dirty ? false,
}:
let
  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot
    then workspaceRoot.outPath
    else workspaceRoot;
in
{
  genie = import (workspaceRootPath + "/packages/@overeng/genie/nix/build.nix") {
    inherit pkgs gitRev dirty;
    src = workspaceRoot;
  };
  megarepo = import (workspaceRootPath + "/packages/@overeng/megarepo/nix/build.nix") {
    inherit pkgs gitRev dirty;
    src = workspaceRoot;
  };
}
