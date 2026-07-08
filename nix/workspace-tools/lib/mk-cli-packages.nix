{
  pkgs,
  gitRev ? "unknown",
  commitTs ? 0,
  workspaceRoot ? ./.,
  dirty ? false,
  typeProofCompilerBin,
}:
let
  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot then
      workspaceRoot.outPath
    else
      workspaceRoot;
in
{
  genie = import (workspaceRootPath + "/packages/@overeng/genie/nix/build.nix") {
    inherit
      pkgs
      gitRev
      commitTs
      dirty
      ;
    src = workspaceRoot;
    inherit typeProofCompilerBin;
  };
  genie-bootstrap-runner =
    import (workspaceRootPath + "/packages/@overeng/genie/nix/bootstrap-runner.nix")
      {
        inherit
          pkgs
          gitRev
          commitTs
          dirty
          ;
        src = workspaceRoot;
        inherit typeProofCompilerBin;
      };
  genie-bootstrap-closure-check =
    import (workspaceRootPath + "/packages/@overeng/genie/nix/bootstrap-closure-check.nix")
      {
        inherit
          pkgs
          gitRev
          commitTs
          dirty
          ;
        src = workspaceRoot;
      };
  megarepo = import (workspaceRootPath + "/packages/@overeng/megarepo/nix/build.nix") {
    inherit
      pkgs
      gitRev
      commitTs
      dirty
      ;
    src = workspaceRoot;
  };
  ci-tools = import (workspaceRootPath + "/packages/@overeng/ci-tools/nix/build.nix") {
    inherit
      pkgs
      gitRev
      commitTs
      dirty
      ;
    src = workspaceRoot;
  };
}
