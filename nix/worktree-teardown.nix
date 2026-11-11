{ pkgs }:
pkgs.writeShellApplication {
  name = "worktree-teardown";
  runtimeInputs = [
    pkgs.git
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.jq
  ];
  text = builtins.readFile ./devenv-modules/tasks/shared/worktree-teardown.sh;
}
