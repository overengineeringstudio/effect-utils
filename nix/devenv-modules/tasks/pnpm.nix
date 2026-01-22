# pnpm install tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.pnpm {
#       packages = [
#         "packages/app"
#         "packages/website"
#         "scripts"
#       ];
#     })
#   ];
#
# Provides: pnpm:install, pnpm:install:<name> for each package
#
# NOTE: We use pnpm instead of bun for installation due to bun bugs with
# local file: dependencies. See: context/workarounds/bun-issues.md
# TODO: Switch back to bun:install once these issues are fixed:
#   - https://github.com/oven-sh/bun/issues/13223 (file: deps slow)
#   - https://github.com/oven-sh/bun/issues/22846 (install hangs)
{ packages }:
{ lib, ... }:
let
  # Convert path to task name (drop first segment if >1, strip @scope/):
  # "packages/@scope/foo" -> "foo"
  # "packages/@scope/foo/examples/basic" -> "foo-examples-basic"
  # "packages/app" -> "app"
  # "apps/example.com" -> "example-com"
  # "context/effect/socket" -> "effect-socket"
  # "scripts" -> "scripts"
  toName = path:
    let
      sanitize = s: builtins.replaceStrings ["/" "."] ["-" "-"] s;
      parts = lib.splitString "/" path;
      rest = if builtins.length parts > 1 
        then lib.concatStringsSep "/" (lib.drop 1 parts) 
        else path;
      m = builtins.match "@[^/]+/(.*)" rest;
      final = if m != null then builtins.head m else rest;
    in
    sanitize final;

  mkInstallTask = path: {
    "pnpm:install:${toName path}" = {
      description = "Install dependencies for ${toName path}";
      exec = "pnpm install";
      cwd = path;
      execIfModified = [ "${path}/package.json" "${path}/pnpm-lock.yaml" ];
      after = [ "genie:run" ];
    };
  };

in {
  tasks = lib.mkMerge (map mkInstallTask packages ++ [
    {
      "pnpm:install" = {
        description = "Install all pnpm dependencies";
        after = map (p: "pnpm:install:${toName p}") packages;
      };
    }
  ]);
}
