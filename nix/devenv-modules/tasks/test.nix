# Test tasks (vitest)
#
# Usage in devenv.nix:
#   # Per-package tests (recommended):
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test {
#       packages = [
#         { path = "packages/@overeng/genie"; name = "genie"; }
#       ];
#       # Optional: custom vitest binary and config (for monorepo setups)
#       vitestBin = "packages/@overeng/utils/node_modules/.bin/vitest";
#       vitestConfig = "packages/@overeng/utils/vitest.config.ts";
#       # Optional: install task prefix (default: "pnpm", use "bun" for bun:install)
#       installTaskPrefix = "pnpm";
#     })
#   ];
#
#   # Simple tests (no per-package):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.test {}) ];
#
# Provides:
#   - test:run - Run all tests
#   - test:watch - Run tests in watch mode
#   - test:<name> - Run tests for specific package (when packages provided)
{
  packages ? [],
  vitestBin ? "vitest",
  vitestConfig ? null,
  installTaskPrefix ? "pnpm",
}:
{ lib, ... }:
let
  hasPackages = packages != [];
  
  # Build vitest command with optional config
  vitestCmd = if vitestConfig != null
    then "${vitestBin} run --config ${vitestConfig}"
    else "${vitestBin} run";
  
  vitestWatchCmd = if vitestConfig != null
    then "${vitestBin} --config ${vitestConfig}"
    else vitestBin;

  # For per-package tests, compute relative path to vitest binary
  mkTestTask = pkg: 
    let
      # Calculate relative path from package to vitest binary
      # e.g., from "packages/@overeng/genie" to "packages/@overeng/utils/node_modules/.bin/vitest"
      # becomes "../utils/node_modules/.bin/vitest"
      depth = lib.length (lib.splitString "/" pkg.path);
      prefix = lib.concatStringsSep "/" (lib.genList (_: "..") depth);
      relativeVitestBin = if vitestBin == "vitest" 
        then "vitest" 
        else "${prefix}/${vitestBin}";
      relativeVitestConfig = if vitestConfig == null
        then ""
        else " --config ${prefix}/${vitestConfig}";
    in {
      "test:${pkg.name}" = {
        description = "Run tests for ${pkg.name}";
        exec = "${relativeVitestBin} run${relativeVitestConfig}";
        cwd = pkg.path;
        execIfModified = [
          "${pkg.path}/src/**/*.ts"
          "${pkg.path}/src/**/*.test.ts"
          "${pkg.path}/vitest.config.ts"
        ];
        after = [ "${installTaskPrefix}:install:${pkg.name}" ];
      };
    };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkTestTask packages else [])
    ++ [{
      "test:run" = {
        description = "Run all tests";
        exec = if hasPackages then null else vitestCmd;
        after = if hasPackages 
          then map (pkg: "test:${pkg.name}") packages
          else [ "genie:run" ];
      };

      "test:watch" = {
        description = "Run tests in watch mode";
        exec = vitestWatchCmd;
        after = [ "genie:run" ];
      };
    }]
  );
}
