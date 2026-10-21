{ inputs, pkgs, ... }:
let
  effectUtils = inputs.effect-utils;
  pnpmPkg = import (effectUtils + "/nix/pnpm.nix") { inherit pkgs; };
in
{
  imports = [
    (
      {
        lib,
        config,
        pkgs,
        ...
      }:
      let
        module =
          (import (effectUtils + "/nix/devenv-modules/tasks/shared/pnpm.nix") {
            packages = [ "." ];
            sourceInputPaths = [ "repos/source/packages/shared" ];
            inherit pnpmPkg;
            materialize = true;
            globalCache = false;
            globalVirtualStore = false;
          })
            { inherit lib config pkgs; };
      in
      module
      // {
        # Lockfile authoring expects Genie; this fixture proves the install surface.
        tasks = builtins.removeAttrs module.tasks [
          "pnpm:update"
          "pnpm:dedupe"
        ];
      }
    )
  ];

  packages = with pkgs; [
    nodejs
    coreutils
    findutils
    gnugrep
    gawk
    git
    flock
  ];
  cachix.enable = false;

  tasks."consumer:assert" = {
    after = [ "pnpm:install" ];
    exec = ''
      ${pkgs.nodejs}/bin/node assert-consumer.cjs
    '';
  };
}
