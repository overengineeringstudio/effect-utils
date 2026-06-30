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
#   # Bound package-level fan-out for large repos / constrained CI runners:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.test { packageConcurrency = 4; }) ];
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
  packageConcurrency ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  hasPackages = packages != [ ];
  hasPackageConcurrency = packageConcurrency != null;
  validatedPackageConcurrency =
    if hasPackageConcurrency && packageConcurrency < 1 then
      throw "packageConcurrency must be at least 1"
    else
      packageConcurrency;
  # Do not force preserve-symlinks here. pnpm's projected workspace graph
  # relies on realpath-based resolution, and preserve-symlinks caused Vitest to
  # miss hoisted dependencies in CI.
  vitestExec = extraArgs: ''
    set -euo pipefail
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest run --testTimeout 30000 --hookTimeout 30000 ${extraArgs}
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
      exec = trace.exec "test:${pkg.name}" (vitestExec (pkg.vitestArgs or ""));
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

  boundedPackageTestRunExec =
    let
      taskNames = map (pkg: "test:${pkg.name}") packages;
      quotedTasks = lib.concatMapStringsSep " " lib.escapeShellArg taskNames;
    in
    ''
      set -euo pipefail

      failed=0
      running_pids=()

      wait_for_running_tasks() {
        local pid
        for pid in "''${running_pids[@]}"; do
          if ! wait "$pid"; then
            failed=1
          fi
        done
        running_pids=()
      }

      for task in ${quotedTasks}; do
        (
          # Preserve each package task's own dependency graph while bounding the
          # package task bodies from this parent scheduler.
          DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false devenv tasks run --mode before "$task"
        ) &
        running_pids+=("$!")

        if [ "''${#running_pids[@]}" -ge ${toString validatedPackageConcurrency} ]; then
          wait_for_running_tasks
        fi
      done

      wait_for_running_tasks

      exit "$failed"
    '';

  guardedTasks = {
    "test:run" = {
      guard = "vitest";
      description = "Run all tests";
      exec =
        if hasPackages then
          if hasPackageConcurrency then trace.exec "test:run" boundedPackageTestRunExec else null
        else
          vitestExec "";
      after =
        if hasPackages then
          if hasPackageConcurrency then
            [ installTask ] ++ extraTests
          else
            map (pkg: "test:${pkg.name}") packages ++ extraTests
        else
          [ "genie:run" ];
    };
    "test:watch" = {
      guard = "vitest";
      description = "Run tests in watch mode";
      exec = vitestWatchExec;
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
