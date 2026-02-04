# Storybook tasks and processes
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
#   Tasks:
#     - storybook:build:<name> - Build storybook for specific package
#     - storybook:build - Aggregate task to build all storybooks
#   Processes (for dev servers):
#     - storybook-<name> - Run with: devenv up storybook-<name>
#
# Port allocation:
#   Uses devenv's automatic port allocation (processes.<name>.ports.<port>.allocate)
#   to avoid conflicts when running multiple storybooks or multiple devenv instances.
#   The port specified in the package config is the base port; if unavailable,
#   devenv will automatically find the next available port.
{
  packages ? [],
  installTaskPrefix ? "pnpm",
}:
{ lib, config, ... }:
let
  hasPackages = packages != [];

  # Use storybook binary directly from package's node_modules (relative to cwd)
  storybookBin = "./node_modules/.bin/storybook";

  mkBuildTask = pkg: {
    "storybook:build:${pkg.name}" = {
      description = "Build storybook for ${pkg.name}";
      exec = "${storybookBin} build";
      cwd = pkg.path;
      after = [ "${installTaskPrefix}:install:${pkg.name}" ];
    };
  };

  # Dev servers as processes (long-running, with TUI via process-compose)
  # Uses automatic port allocation to avoid conflicts
  # --host 0.0.0.0 allows access from other machines (useful for remote dev environments)
  processName = pkg: "storybook-${pkg.name}";
  mkProcess = pkg: {
    "${processName pkg}" = {
      ports.http.allocate = pkg.port;
      exec = ''
        ${storybookBin} dev -p "$DEVENV_PROCESS_PORT_HTTP" --host 0.0.0.0
      '';
      cwd = pkg.path;
    };
  };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkBuildTask packages else [])
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

  processes = lib.mkMerge (
    if hasPackages then map mkProcess packages else []
  );
}
