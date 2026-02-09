{
  pkgs,
  gitRev ? "unknown",
  commitTs ? 0,
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
    inherit pkgs gitRev commitTs dirty;
    src = workspaceRoot;
  };
  megarepo = import (workspaceRootPath + "/packages/@overeng/megarepo/nix/build.nix") {
    inherit pkgs gitRev commitTs dirty;
    src = workspaceRoot;
  };
  otel = import (workspaceRootPath + "/packages/@overeng/otel-cli/nix/build.nix") {
    inherit pkgs gitRev commitTs dirty;
    src = workspaceRoot;
  };
}
