# Bun install tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.bun {
#       packages = [
#         "packages/app"
#         "packages/website"
#         "scripts"
#       ];
#     })
#   ];
#
# Provides: bun:install, bun:install:<name> for each package
{ packages }:
{ lib, ... }:
let
  # Convert path to task name:
  # "packages/@overeng/foo" -> "foo"
  # "packages/@local/foo" -> "foo"
  # "packages/app" -> "app"
  # "apps/misc.schickling.dev" -> "misc-schickling-dev"
  # "pi-nix/remote-server" -> "pi-nix-remote-server"
  toName = path:
    let
      # Replace dots with dashes (task names can't have dots)
      sanitize = s: builtins.replaceStrings ["."] ["-"] s;
      parts = lib.splitString "/" path;
      last = lib.last parts;
    in
    if lib.hasInfix "@overeng/" path then sanitize last
    else if lib.hasInfix "@local/" path then sanitize last
    else sanitize (builtins.replaceStrings ["/"] ["-"] path);

  mkInstallTask = path: {
    "bun:install:${toName path}" = {
      exec = "bun install";
      cwd = path;
      execIfModified = [ "${path}/package.json" "${path}/bun.lock" ];
      after = [ "genie:run" ];
    };
  };

in {
  tasks = lib.mkMerge (map mkInstallTask packages ++ [
    {
      "bun:install" = {
        description = "Install all bun dependencies";
        after = map (p: "bun:install:${toName p}") packages;
      };
    }
  ]);
}
