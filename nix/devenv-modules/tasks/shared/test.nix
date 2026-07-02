# Test tasks (vitest)
#
# Self-contained test tasks that run in package cwd while resolving Vitest from
# the installed package graph directly.
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
  packages ? [ ],
  installTask ? "pnpm:install",
  extraTests ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  hasPackages = packages != [ ];
  # Do not force preserve-symlinks here. pnpm's projected workspace graph
  # relies on realpath-based resolution, and preserve-symlinks caused Vitest to
  # miss hoisted dependencies in CI.
  #
  # The concrete vitest binary is instrumented with trace.instr (decision 0018):
  # otel-scrape owns a named command span beneath the task span and consumes the
  # vitest `--reporter=json` SIDE-CHANNEL it injects itself (decision 0017), so the
  # human reporter output stays on the terminal unchanged. `run_package_bin` is a
  # shell function, so it is resolved to a real bin path first (experiment 0007)
  # and otel-scrape wraps that path directly.
  vitestExec =
    {
      name,
      extraArgs ? "",
    }:
    ''
      set -euo pipefail
      source ${lib.escapeShellArg pnpmTaskHelpersScript}
      ${trace.instr {
        adapter = "vitest";
        inherit name;
      }}
      "''${_otel_instr[@]}" "$(resolve_package_bin vitest vitest)" run ${extraArgs}
    '';
  vitestWatchExec = ''
    set -euo pipefail
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest
  '';

  # Per-package test task using the workspace-aware vitest entrypoint.
  mkTestTask = pkg: {
    "test:${pkg.name}" = {
      description = "Run tests for ${pkg.name}";
      exec = trace.exec "test:${pkg.name}" (vitestExec {
        name = "test:${pkg.name}";
        extraArgs = pkg.vitestArgs or "";
      });
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
      exec =
        if hasPackages then
          null
        else
          trace.exec "test:run" (vitestExec {
            name = "test:run";
          });
      after =
        if hasPackages then map (pkg: "test:${pkg.name}") packages ++ extraTests else [ "genie:run" ];
    };
    "test:watch" = {
      guard = "vitest";
      description = "Run tests in watch mode";
      exec = trace.exec "test:watch" vitestWatchExec;
      after = [ "genie:run" ];
    };
  };

in
{
  packages = cliGuard.fromTasks guardedTasks;

  tasks = lib.mkMerge (
    (if hasPackages then map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages else [ ])
    ++ [ (cliGuard.stripGuards guardedTasks) ]
  );
}
