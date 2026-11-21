{ pkgs, buck2 }:
let
  release = import ./buck2-release.nix;
  supported = builtins.hasAttr pkgs.stdenv.hostPlatform.system release.platforms;
in
pkgs.writeShellApplication {
  name = "worktree-teardown";
  # Generic worktree tasks also run on platforms without a pinned Buck2 asset.
  # Keep their previous ambient-client behaviour without forcing that package.
  runtimeInputs = pkgs.lib.optional supported buck2 ++ [
    pkgs.git
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.jq
  ];
  text = builtins.readFile ./devenv-modules/tasks/shared/worktree-teardown.sh;
}
