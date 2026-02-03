# Test tasks (vitest)
#
# Self-contained test tasks - each package uses its own vitest from node_modules.
# This ensures packages are independently testable without cross-package dependencies.
#
# Usage in devenv.nix:
#   # Per-package tests (recommended):
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test {
#       packages = [
#         { path = "packages/@overeng/genie"; name = "genie"; }
#         { path = "packages/@overeng/tui-core"; name = "tui-core"; }
#       ];
#       # Optional: install task prefix (default: "pnpm", use "bun" for bun:install)
#       installTaskPrefix = "pnpm";
#     })
#   ];
#
#   # Simple tests (no per-package):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.test {}) ];
#
# Each package must have:
#   - vitest as a devDependency in package.json
#   - vitest.config.ts in the package root
#
# Provides:
#   - test:run - Run all tests
#   - test:watch - Run tests in watch mode (requires single package or vitestBin override)
#   - test:<name> - Run tests for specific package (when packages provided)
{
  packages ? [],
  installTaskPrefix ? "pnpm",
  extraTests ? [],
  # Legacy: shared vitest binary (deprecated, violates self-containment)
  # Use only for migration; each package should have its own vitest
  vitestBin ? null,
  vitestConfig ? null,
}:
{ lib, ... }:
let
  hasPackages = packages != [];
  hasSharedVitest = vitestBin != null;

  # Build vitest command for simple (non-package) mode
  simpleVitestCmd = if vitestConfig != null
    then "${if hasSharedVitest then vitestBin else "vitest"} run --config ${vitestConfig}"
    else "${if hasSharedVitest then vitestBin else "vitest"} run";

  simpleVitestWatchCmd = if vitestConfig != null
    then "${if hasSharedVitest then vitestBin else "vitest"} --config ${vitestConfig}"
    else if hasSharedVitest then vitestBin else "vitest";

  # Per-package test task using package's own vitest
  mkTestTask = pkg:
    let
      # Use package's own vitest from node_modules/.bin/vitest
      # This runs from the package directory with cwd = pkg.path
      vitestCommand = "node_modules/.bin/vitest run";
    in {
      "test:${pkg.name}" = {
        description = "Run tests for ${pkg.name}";
        exec = vitestCommand;
        cwd = pkg.path;
        execIfModified = [
          "${pkg.path}/src/**/*.ts"
          "${pkg.path}/src/**/*.tsx"
          "${pkg.path}/src/**/*.test.ts"
          "${pkg.path}/src/**/*.test.tsx"
          "${pkg.path}/test/**/*.ts"
          "${pkg.path}/test/**/*.tsx"
          "${pkg.path}/test/**/*.test.ts"
          "${pkg.path}/test/**/*.test.tsx"
          "${pkg.path}/vitest.config.ts"
        ];
        # Only depends on the package's own install task
        after = [ "${installTaskPrefix}:install:${pkg.name}" ];
      };
    };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkTestTask packages else [])
    ++ [{
      "test:run" = {
        description = "Run all tests";
        exec = if hasPackages then null else simpleVitestCmd;
        after = if hasPackages
          then map (pkg: "test:${pkg.name}") packages ++ extraTests
          else [ "genie:run" ];
      };

      "test:watch" = {
        description = "Run tests in watch mode";
        exec = simpleVitestWatchCmd;
        after = [ "genie:run" ];
      };
    }]
  );
}
