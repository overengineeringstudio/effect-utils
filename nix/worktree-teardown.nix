{ pkgs }:
pkgs.writeShellApplication {
  name = "worktree-teardown";
  runtimeInputs = [
    pkgs.git
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.flock
    pkgs.jq
  ];
  text = builtins.readFile ./devenv-modules/tasks/shared/worktree-teardown.sh;
}
