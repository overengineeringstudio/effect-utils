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
#   # Bound package-level fan-out for large repos / constrained CI runners.
#   # test:run runs aggregate packages in `packageConcurrency` independent
#   # chains, assigned longest-first by declared seconds (default weight 1):
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test {
#       packageConcurrency = 4;
#       packageWeights = { "test:genie" = 72; };
#     })
#   ];
#
# Each package must have:
#   - vitest as a devDependency in package.json
#   - vitest.config.ts in the package root
#   - optional `after = [ ... ]` for package-specific prerequisites
#   - optional `installTask` overriding the aggregate's installer for direct execution
#
# Provides:
#   - test:run - Run all tests
#   - test:watch - Run tests in watch mode
#   - test:<name> - Run tests for specific package (when packages provided)
{
  packages ? [ ],
  # Aggregate scope may be narrower than the standalone package task surface.
  aggregatePackages ? packages,
  installTask ? "pnpm:install",
  extraTests ? [ ],
  packageConcurrency ? null,
  packageWeights ? { },
  retainVitestJson ? false,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  hasPackages = packages != [ ];
  hasPackageConcurrency = packageConcurrency != null;
  validatedPackageConcurrency =
    if hasPackageConcurrency && (!builtins.isInt packageConcurrency || packageConcurrency < 1) then
      throw "packageConcurrency must be a positive integer or null"
    else
      packageConcurrency;
  validatedPackageWeights =
    if !builtins.isAttrs packageWeights then
      throw "packageWeights must be an attribute set of positive integer seconds"
    else
      lib.mapAttrs (
        name: weight:
        if !builtins.isInt weight || weight < 1 then
          throw "packageWeights.${name} must be a positive integer number of seconds"
        else
          weight
      ) packageWeights;
  taskFileStem =
    taskName:
    builtins.replaceStrings
      [
        ":"
        "/"
        " "
        "."
      ]
      [
        "-"
        "-"
        "-"
        "_"
      ]
      taskName;

  # Do not force preserve-symlinks here. pnpm's projected workspace graph
  # relies on realpath-based resolution, and preserve-symlinks caused Vitest to
  # miss hoisted dependencies in CI.
  #
  # The concrete vitest binary is instrumented with trace.instr (decision 0018):
  # otel-scrape owns a named command span beneath the task span and consumes the
  # vitest `--reporter=json` SIDE-CHANNEL it injects itself (decision 0017), so the
  # human reporter output stays on the terminal unchanged. `run_package_bin` is a
  # shell function, so it is resolved to a real bin path first (experiment 0007)
  # and otel-scrape wraps that path directly. When retainVitestJson is enabled,
  # the managed task owns the JSON output path, so otel-scrape reads but does not
  # delete the job-local report. Its public summary remains counts-only.
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
      _vitest_collection_args=()
      ${lib.optionalString retainVitestJson ''
        _vitest_collection_dir="''${VITEST_COLLECTION_REPORT_DIR:-''${DEVENV_ROOT:-$PWD}/tmp/otel-scrape/summaries}"
        mkdir -p "$_vitest_collection_dir"
        _vitest_collection_args=(
          --reporter=default
          --reporter=json
          "--outputFile.json=$_vitest_collection_dir/${taskFileStem name}.vitest.json"
        )
      ''}
      "''${_otel_instr[@]}" "$(resolve_package_bin vitest vitest)" run --testTimeout 30000 --hookTimeout 30000 "''${_vitest_collection_args[@]}" ${extraArgs}
    '';
  vitestWatchExec = ''
    set -euo pipefail
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    run_package_bin vitest vitest
  '';

  # Assign longest source tasks first to the least-loaded chain. Lexical task
  # names and stable chain indices break ties without runtime timing state.
  packageTaskName = pkg: "test:${pkg.name}";
  packageWeight = pkg: validatedPackageWeights.${packageTaskName pkg} or 1;
  sortedAggregatePackages = lib.sort (
    left: right:
    if packageWeight left == packageWeight right then
      packageTaskName left < packageTaskName right
    else
      packageWeight left > packageWeight right
  ) aggregatePackages;
  packageTestChains =
    if hasPackageConcurrency then
      lib.foldl'
        (
          chains: pkg:
          let
            lightestChain = lib.foldl' (
              lightest: chain: if chain.weight < lightest.weight then chain else lightest
            ) (builtins.head chains) chains;
          in
          map (
            chain:
            if chain.index == lightestChain.index then
              chain
              // {
                weight = chain.weight + packageWeight pkg;
                packages = chain.packages ++ [ pkg ];
              }
            else
              chain
          ) chains
        )
        (lib.genList (index: {
          inherit index;
          weight = 0;
          packages = [ ];
        }) validatedPackageConcurrency)
        sortedAggregatePackages
    else
      [ ];
  packageTestExecutionName = index: pkg: "test:run:chain:${toString index}:${pkg.name}";
  packageTestChainTails = map (
    chain: packageTestExecutionName chain.index (lib.last chain.packages)
  ) (lib.filter (chain: chain.packages != [ ]) packageTestChains);

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
      after = [ (pkg.installTask or installTask) ] ++ (pkg.after or [ ]);
    };
  };

  # Aggregate-only execution aliases carry per-chain ordering. Direct package
  # tasks keep their own prerequisites and never pull another source task into
  # their closure. Each alias uses the aggregate's one installer.
  mkPackageTestChain =
    chain:
    lib.imap0 (
      index: pkg:
      let
        execution = config.tasks.${packageTaskName pkg};
      in
      {
        "${packageTestExecutionName chain.index pkg}" = {
          # Reuse final task overrides, including pinned runtimes and tool env.
          inherit (execution) description exec cwd;
          env = execution.env or { };
          execIfModified = execution.execIfModified or [ ];
          # trace-audit-allow: inherit the final task's already-instrumented status; do not wrap twice.
          status = execution.status or null;
          after = [
            installTask
          ]
          ++ (pkg.after or [ ])
          ++ lib.optional (index > 0) (
            packageTestExecutionName chain.index (builtins.elemAt chain.packages (index - 1))
          );
        };
      }
    ) chain.packages;

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
          if hasPackageConcurrency && aggregatePackages != [ ] then
            packageTestChainTails ++ extraTests
          else
            map (pkg: "test:${pkg.name}") aggregatePackages ++ extraTests
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
builtins.seq validatedPackageConcurrency (
  builtins.deepSeq validatedPackageWeights {
    packages = cliGuard.fromTasks guardedTasks;

    tasks = lib.mkMerge (
      (if hasPackages then map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages else [ ])
      ++ (
        if hasPackages && hasPackageConcurrency then
          lib.concatMap mkPackageTestChain packageTestChains
        else
          [ ]
      )
      ++ [ (cliGuard.stripGuards guardedTasks) ]
    );
  }
)
