# Storybook tasks (dev server & build)
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.storybook {
#       packages = [
#         { path = "packages/@overeng/tui-react"; name = "tui-react"; port = 6006; }
#         { path = "packages/@overeng/megarepo"; name = "megarepo"; port = 6007; }
#       ];
#       # Optional: install task prefix (default: "pnpm", use "bun" for bun:install)
#       installTaskPrefix = "pnpm";
#     })
#   ];
#
# Provides:
#   - storybook:dev:<name> - Start storybook dev server for specific package
#   - storybook:build:<name> - Build storybook for specific package
#   - storybook:build - Aggregate task to build all storybooks
{
  packages ? [],
  installTaskPrefix ? "pnpm",
}:
{ lib, ... }:
let
  hasPackages = packages != [];

  mkDevTask = pkg: {
    "storybook:dev:${pkg.name}" = {
      description = "Start storybook dev server for ${pkg.name} (port ${toString pkg.port})";
      exec = "pnpm storybook";
      cwd = pkg.path;
      after = [ "${installTaskPrefix}:install:${pkg.name}" ];
    };
  };

  mkBuildTask = pkg: {
    "storybook:build:${pkg.name}" = {
      description = "Build storybook for ${pkg.name}";
      exec = "pnpm storybook:build";
      cwd = pkg.path;
      after = [ "${installTaskPrefix}:install:${pkg.name}" ];
    };
  };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkDevTask packages else [])
    ++ (if hasPackages then map mkBuildTask packages else [])
    ++ [{
      "storybook:build" = {
        description = "Build all storybooks";
        exec = null;
        after = if hasPackages
          then map (pkg: "storybook:build:${pkg.name}") packages
          else [];
      };
    }]
  );
}
