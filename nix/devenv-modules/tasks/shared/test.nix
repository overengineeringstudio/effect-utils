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
#   - optional `after = [ ... ]` for package-specific prerequisites
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
  packagesWithIndexes = lib.imap0 (index: pkg: pkg // { __testIndex = index; }) packages;

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

  chunkList =
    size: items:
    if items == [ ] then [ ] else [ (lib.take size items) ] ++ chunkList size (lib.drop size items);

  packageTestTaskNames = map (pkg: "test:${pkg.name}") packages;
  packageTestBatches =
    if hasPackageConcurrency then chunkList validatedPackageConcurrency packageTestTaskNames else [ ];
  packageTestBatchTaskName = index: "test:run:batch:${toString index}";
  lastPackageTestBatchTaskName = packageTestBatchTaskName (builtins.length packageTestBatches - 1);

  mkTestTask =
    pkg:
    let
      batchIndex =
        if hasPackageConcurrency then builtins.div pkg.__testIndex validatedPackageConcurrency else 0;
    in
    {
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
        after =
          [ installTask ]
          ++ (pkg.after or [ ])
          ++ lib.optional (hasPackageConcurrency && batchIndex > 0) (packageTestBatchTaskName (batchIndex - 1));
      };
    };

  mkPackageTestBatchTask = index: taskNames: {
    "${packageTestBatchTaskName index}" = {
      description = "Complete test:run package batch ${toString (index + 1)}";
      after = taskNames;
    };
  };

  guardedTasks = {
    "test:run" = {
      guard = "vitest";
      description = "Run all tests";
      exec = if hasPackages then null else vitestExec "";
      after =
        if hasPackages then
          if hasPackageConcurrency then
            [ lastPackageTestBatchTaskName ] ++ extraTests
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
    (if hasPackages then map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packagesWithIndexes else [ ])
    ++ (
      if hasPackages && hasPackageConcurrency then
        lib.imap0 mkPackageTestBatchTask packageTestBatches
      else
        [ ]
    )
    ++ [ (cliGuard.stripGuards guardedTasks) ]
  );
}
