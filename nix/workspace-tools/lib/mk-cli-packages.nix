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
  dotdot = import (workspaceRootPath + "/packages/@overeng/dotdot/nix/build.nix") {
    inherit pkgs gitRev dirty;
    src = workspaceRoot;
  };
}
