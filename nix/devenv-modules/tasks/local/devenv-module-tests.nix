{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };

  devenvModuleTestsScript = pkgs.writeShellScript "devenv-module-tests" ''
    set -euo pipefail

    export NIX_FLAKE_REF="git+file://$PWD?shallow=1"
    export BUN_BIN=${pkgs.bun}/bin/bun
    export BASH_BIN=${pkgs.bashNonInteractive}/bin/bash
    export DATE_BIN=${pkgs.coreutils}/bin/date
    export XARGS_BIN=${pkgs.findutils}/bin/xargs
    exec "$BASH_BIN" ${./devenv-module-tests.sh} \
      "$PWD/nix/devenv-modules/tasks/shared/tests"
  '';
in
{
  tasks."devenv-modules:test" = {
    description = "Run shared module shell tests with two isolated workers and a serial shared-state barrier";
    exec = trace.exec "devenv-modules:test" "${devenvModuleTestsScript}";
    after = [ "pnpm:install" ];
  };
}
