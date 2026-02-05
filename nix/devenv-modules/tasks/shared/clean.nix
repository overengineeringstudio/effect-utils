# Clean build artifacts task
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.clean {
#       packages = myPackages;  # Same list as pnpm.nix
#       extraDirs = [ ".contentlayer" "storybook-static" ];
#     })
#   ];
#
# Provides: build:clean
{ packages, extraDirs ? [] }:
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  # Clean dist, .next, and .tsbuildinfo for each package
  packageCleanCommands = lib.concatMapStringsSep "\n" (p: ''
    rm -rf ${p}/dist ${p}/.next
    rm -f ${p}/*.tsbuildinfo
  '') packages;
  
  # Clean extra directories at repo root
  extraDirCommands = lib.concatMapStringsSep "\n" (d: "rm -rf ${d}") extraDirs;
in
{
  tasks = {
    "build:clean" = {
      description = "Remove build artifacts (dist, .next, tsbuildinfo${if extraDirs != [] then ", " + builtins.concatStringsSep ", " extraDirs else ""})";
      exec = trace.exec "build:clean" ''
        echo "Cleaning build artifacts..."
        ${packageCleanCommands}
        ${extraDirCommands}
        echo "Done"
      '';
    };
  };
}
