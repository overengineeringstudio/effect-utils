{
  pkgs,
  buck2 ? import ./buck2.nix { inherit pkgs; },
}:
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
  text = ''
    export BUCK2_NATIVE_BIN=${buck2}/libexec/buck2
  '' + builtins.readFile ./devenv-modules/tasks/shared/worktree-teardown.sh;
}
