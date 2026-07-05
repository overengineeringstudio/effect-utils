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
  #
  # The concrete vitest binary is instrumented with trace.instr (decision 0018):
  # otel-scrape owns a named command span beneath the task span and consumes the
  # vitest `--reporter=json` SIDE-CHANNEL it injects itself (decision 0017), so the
  # human reporter output stays on the terminal unchanged. `run_package_bin` is a
  # shell function, so it is resolved to a real bin path first (experiment 0007)
  # and otel-scrape wraps that path directly.
  #
  # R01 — native Vitest runner OTEL (the `vitest.*` runner-mechanics span tree) is
  # enabled by exporting VITEST_OTEL_RUNNER=1, which flips the root
  # `vitest.config.ts` `experimental.openTelemetry` block on. We gate that on a
  # collector context being present: the devenv OTEL module exports
  # OTEL_EXPORTER_OTLP_ENDPOINT whenever a collector (local or system) is active,
  # and the runner SDK is an OTLP/HTTP exporter, so an endpoint — not merely a
  # spool dir — is the correct signal. Bare local runs and watch mode leave the
  # endpoint unset, so runner OTEL stays absent there (spec A03).
  vitestOtelRunnerGate = ''
    if [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      export VITEST_OTEL_RUNNER=1
    fi
  '';

  # F1/R02 — per-package tasks run the package's own vitest binary FROM THE REPO
  # ROOT against the root `vitest.config.ts`, filtered to this package's project
  # (`--project <package.json name>`). This makes the global
  # `experimental.openTelemetry` block reach every package with zero per-package
  # config edits, while the package's own project config still selects its tests
  # and setup (only that project runs). The package's vitest binary and project
  # name are resolved while cwd is still the package directory (the task cwd),
  # then we cd to the repo root so vitest picks up the root config.
  vitestExec =
    {
      name,
      extraArgs ? "",
      perPackage ? false,
    }:
    if perPackage then
      ''
        set -euo pipefail
        source ${lib.escapeShellArg pnpmTaskHelpersScript}
        ${vitestOtelRunnerGate}
        _vitest_bin="$(resolve_package_bin vitest vitest)"
        _project_name="$("''${NODE_BIN:-node}" -p "require('$PWD/package.json').name")"
        ${trace.instr {
          adapter = "vitest";
          inherit name;
        }}
        cd "''${DEVENV_ROOT:-$PWD}"
        "''${_otel_instr[@]}" "$_vitest_bin" run --project "$_project_name" --testTimeout 30000 --hookTimeout 30000 ${extraArgs}
      ''
    else
      ''
        set -euo pipefail
        source ${lib.escapeShellArg pnpmTaskHelpersScript}
        ${vitestOtelRunnerGate}
        ${trace.instr {
          adapter = "vitest";
          inherit name;
        }}
        "''${_otel_instr[@]}" "$(resolve_package_bin vitest vitest)" run --testTimeout 30000 --hookTimeout 30000 ${extraArgs}
      '';
  vitestWatchExec = ''
    set -euo pipefail
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest
  '';

  # Per-package test task using the workspace-aware vitest entrypoint.
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
        exec = trace.exec "test:${pkg.name}" (vitestExec {
          name = "test:${pkg.name}";
          extraArgs = pkg.vitestArgs or "";
          perPackage = true;
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
        after = [
          installTask
        ]
        ++ (pkg.after or [ ])
        ++ lib.optional (hasPackageConcurrency && batchIndex > 0) (
          packageTestBatchTaskName (batchIndex - 1)
        );
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
      exec =
        if hasPackages then
          null
        else
          trace.exec "test:run" (vitestExec {
            name = "test:run";
          });
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
      exec = trace.exec "test:watch" vitestWatchExec;
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
