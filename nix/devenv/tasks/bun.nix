{ lib, ... }:
let
  packages = import ./packages.nix { inherit lib; };
  inherit (packages) allPackages toName;

  mkInstallTask = path: {
    "bun:install:${toName path}" = {
      exec = "bun install";
      cwd = path;
      execIfModified = [ "${path}/package.json" "${path}/bun.lock" ];
      after = [ "genie:run" ];
    };
  };

in {
  tasks = lib.mkMerge (map mkInstallTask allPackages ++ [
    {
      "bun:install" = {
        description = "Install all bun dependencies";
        after = map (p: "bun:install:${toName p}") allPackages;
      };
    }
  ]);
}
