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
#   - test:watch - Run tests in watch mode
#   - test:<name> - Run tests for specific package (when packages provided)
{
  packages ? [],
  installTaskPrefix ? "pnpm",
  extraTests ? [],
}:
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  hasPackages = packages != [];

  # Per-package test task using package's own vitest
  mkTestTask = pkg: {
    "test:${pkg.name}" = {
      description = "Run tests for ${pkg.name}";
      # Use package's own vitest from node_modules/.bin/vitest
      exec = trace.exec "test:${pkg.name}" "node_modules/.bin/vitest run";
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
      # Conservative barrier: wait for all installs to finish before running tests.
      # TODO(#254): Replace full install barrier with canonical resolver-driven granular blockers.
      after = [ "${installTaskPrefix}:install" ];
    };
  };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkTestTask packages else [])
    ++ [{
      "test:run" = {
        description = "Run all tests";
        exec = if hasPackages then null else "vitest run";
        after = if hasPackages
          then map (pkg: "test:${pkg.name}") packages ++ extraTests
          else [ "genie:run" ];
      };

      "test:watch" = {
        description = "Run tests in watch mode";
        exec = "vitest";
        after = [ "genie:run" ];
      };
    }]
  );
}
