{
  workerCount ? 4,
  scriptWeights ? { },
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  validWeights = builtins.all (weight: builtins.isInt weight && weight > 0) (
    builtins.attrValues scriptWeights
  );
  weightsFile = pkgs.writeText "devenv-module-test-weights.json" (builtins.toJSON scriptWeights);

  devenvModuleTestsScript = pkgs.writeShellScript "devenv-module-tests" ''
    set -euo pipefail

    export NIX_FLAKE_REF="git+file://$PWD?shallow=1"
    export BUN_BIN=${pkgs.bun}/bin/bun
    export BASH_BIN=${pkgs.bashNonInteractive}/bin/bash
    export DATE_BIN=${pkgs.coreutils}/bin/date
    export XARGS_BIN=${pkgs.findutils}/bin/xargs
    export JQ_BIN=${pkgs.jq}/bin/jq
    export MODULE_TEST_WORKERS=${toString workerCount}
    export MODULE_TEST_WEIGHTS=${weightsFile}
    exec "$BASH_BIN" ${./devenv-module-tests.sh} \
      "$PWD/nix/devenv-modules/tasks/shared/tests"
  '';
in
assert builtins.isInt workerCount && workerCount > 0;
assert validWeights;
{
  tasks."devenv-modules:test" = {
    description = "Run shared module shell tests with ${toString workerCount} isolated workers and a serial shared-state barrier";
    exec = trace.exec "devenv-modules:test" "${devenvModuleTestsScript}";
    after = [ "pnpm:install" ];
  };
}
