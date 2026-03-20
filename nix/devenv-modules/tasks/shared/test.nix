# Test tasks (vitest)
#
# Self-contained test tasks that run in package cwd while using the repo-root
# hoisted install via `pnpm exec`.
#
# Usage in devenv.nix:
#   # Per-package tests (recommended):
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test {
#       packages = [
#         { path = "packages/@overeng/genie"; name = "genie"; }
#         { path = "packages/@overeng/tui-core"; name = "tui-core"; }
#       ];
#       # Optional: install task name (default: "pnpm:install")
#       installTask = "pnpm:install";
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
  installTask ? "pnpm:install",
  extraTests ? [],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  hasPackages = packages != [];

  # Per-package test task using the workspace-aware vitest entrypoint.
  mkTestTask = pkg: {
    "test:${pkg.name}" = {
      description = "Run tests for ${pkg.name}";
      exec = trace.exec "test:${pkg.name}" "pnpm exec vitest run";
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
      after = [ installTask ];
    };
  };

  guardedTasks = {
    "test:run" = {
      guard = "vitest";
      description = "Run all tests";
      exec = if hasPackages then null else "pnpm exec vitest run";
      after = if hasPackages
        then map (pkg: "test:${pkg.name}") packages ++ extraTests
        else [ "genie:run" ];
    };
    "test:watch" = {
      guard = "vitest";
      description = "Run tests in watch mode";
      exec = "pnpm exec vitest";
      after = [ "genie:run" ];
    };
  };

in {
  packages = cliGuard.fromTasks guardedTasks;

  tasks = lib.mkMerge (
    (if hasPackages then map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages else [])
    ++ [ (cliGuard.stripGuards guardedTasks) ]
  );
}
