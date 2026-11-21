{ pkgs, buck2 }:
pkgs.writeShellApplication {
  name = "worktree-teardown";
  runtimeInputs = [
    buck2
    pkgs.git
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.jq
  ];
  text = builtins.readFile ./devenv-modules/tasks/shared/worktree-teardown.sh;
}
