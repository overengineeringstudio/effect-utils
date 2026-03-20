# Lint tasks using oxlint/oxfmt
#
# Uses default config file paths (.oxfmtrc.json, .oxlintrc.json) - no explicit -c flags needed.
# Ignore patterns should be configured in the config files themselves (via genie).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
#       # Explicit glob patterns for execIfModified.
#       # Use negation patterns to exclude vendored/generated trees globally.
#       execIfModifiedPatterns = [
#         "packages/*/src/**/*.ts"
#         "packages/*/src/**/*.tsx"
#         "packages/*/*.ts"  # root config files including *.genie.ts
#         "!**/node_modules/**"
#         "!**/dist/**"
#       ];
#       # Glob patterns for .genie.ts files (for genie check caching)
#       # Should match all *.genie.ts files without traversing node_modules
#       geniePatterns = [
#         "packages/*/*.genie.ts"
#       ];
#       # Directories to scan for genie coverage check
#       genieCoverageDirs = [ "packages" ];  # required
#       # Path prefixes to exclude from genie coverage (git pathspec patterns)
#       genieCoverageExcludes = [ "packages/vendored/" ];  # optional
#       # Config file names to check for genie coverage (default: package.json + tsconfig.json)
#       genieCoverageFiles = [ "package.json" "tsconfig.json" ];  # optional
#       # Path to tsconfig for type-aware linting (enables typescript/no-deprecated etc)
#       tsconfig = "tsconfig.all.json";  # optional
#       # Whether to fail on warnings (default: true for CI strictness)
#       # denyWarnings = false;  # optional
#     })
#   ];
#
# Provides: lint:check, lint:check:format, lint:check:oxlint, lint:check:genie, lint:check:genie:coverage
#           lint:fix, lint:fix:format, lint:fix:oxlint
{
  execIfModifiedPatterns,
  geniePatterns,
  genieCoverageDirs,
  genieCoverageExcludes ? [ ],
  genieCoverageFiles ? [
    "package.json"
    "tsconfig.json"
  ],
  lintPaths ? [ "." ],
  # Type-aware linting: provide tsconfig to enable --type-aware flag.
  # Requires pkgs.tsgolint in devenv packages (auto-discovered on PATH by oxlint).
  tsconfig ? null,
  # Whether to treat warnings as errors. Set to false for repos with many
  # existing warnings that can't be fixed immediately.
  denyWarnings ? true,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  git = "${pkgs.git}/bin/git";
  scanDirsArg = builtins.concatStringsSep " " genieCoverageDirs;
  # Git pathspec exclusion patterns applied to coverage check (e.g. "packages/vendored/")
  excludePathspecs = builtins.concatStringsSep " " (
    map (p: "':(exclude)${p}'") genieCoverageExcludes
  );
  # Bash case pattern matching config file names (e.g. "package.json|*/package.json|tsconfig.json|*/tsconfig.json")
  coverageFilePattern = builtins.concatStringsSep "|" (
    lib.concatMap (f: [
      f
      "*/${f}"
    ]) genieCoverageFiles
  );
  lintPathsArg = builtins.concatStringsSep " " lintPaths;

  # Type-aware linting flags (enabled when tsconfig is provided)
  typeAwareFlags = if tsconfig != null then "--type-aware --tsconfig ${tsconfig}" else "";
  warningsFlag = if denyWarnings then "--deny-warnings" else "";

  # Plugin injection is handled by oxlint-with-plugins wrapper on PATH.
  # Consumers should add oxlint-with-plugins to devenv packages instead of
  # passing jsPlugins here.
  mkOxlintCmd =
    extraFlags:
    let
      flags = "${warningsFlag} ${extraFlags}";
    in
    "oxlint --import-plugin ${flags} ${typeAwareFlags} ${lintPathsArg}";

  guardedTasks = {
    "lint:check:format" = {
      guard = "oxfmt";
      description = "Check code formatting with oxfmt";
      exec = trace.exec "lint:check:format" "oxfmt --check ${lintPathsArg}";
      execIfModified = execIfModifiedPatterns;
    };
    "lint:check:oxlint" = {
      guard = "oxlint";
      description = "Run oxlint linter";
      exec = trace.exec "lint:check:oxlint" (mkOxlintCmd "");
      execIfModified = execIfModifiedPatterns;
    }
    // lib.optionalAttrs (tsconfig != null) {
      after = [ "pnpm:install" ];
    };
    "lint:fix:format" = {
      guard = "oxfmt";
      description = "Fix code formatting with oxfmt";
      exec = trace.exec "lint:fix:format" "oxfmt ${lintPathsArg}";
    };
    "lint:fix:oxlint" = {
      guard = "oxlint";
      description = "Fix lint issues with oxlint";
      exec = trace.exec "lint:fix:oxlint" (mkOxlintCmd "--fix");
    };
  };

  otherTasks = {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      exec = trace.exec "lint:check:genie" "genie --check";
      execIfModified = geniePatterns;
    };
    "lint:check:genie:coverage" = {
      description = "Check all config files have .genie.ts sources";
      exec = trace.exec "lint:check:genie:coverage" ''
        set -euo pipefail

        # Enumerate config files via git instead of scanning the filesystem.
        #
        # Rationale:
        # - Avoids traversing huge trees (node_modules) even when excluded.
        # - Correctly checks files that are tracked or about to be committed
        #   (untracked but not ignored).
        # - Prevents false negatives from caching based only on *.genie.ts files.
        files=$(
          {
            ${git} ls-files -- ${scanDirsArg} ${excludePathspecs}
            ${git} ls-files --others --exclude-standard -- ${scanDirsArg} ${excludePathspecs}
          } | sort -u | while IFS= read -r f; do
            case "$f" in
              ${coverageFilePattern}) echo "$f" ;;
            esac
          done
        )

        missing=$(echo "$files" | while IFS= read -r f; do
          [ -z "$f" ] && continue
          [ -f "$f.genie.ts" ] || echo "$f"
        done | sort)
        if [ -n "$missing" ]; then
          echo "Missing .genie.ts sources for:"
          echo "$missing"
          exit 1
        fi
        echo "All config files have .genie.ts sources"
      '';
      # Intentionally no execIfModified caching: new unmanaged config files are exactly
      # what this task exists to detect.
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers";
      after = [ "pnpm:install" ];
      exec = trace.exec "lint:check:lockfile" ''
        set -euo pipefail
        export npm_config_manage_package_manager_versions=false
        pnpm install --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false
      '';
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:format"
        "lint:check:oxlint"
        "lint:check:genie"
        "lint:check:genie:coverage"
        "lint:check:lockfile"
      ];
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [
        "lint:fix:format"
        "lint:fix:oxlint"
      ];
    };
  };
in
{
  # Provide tsgolint when type-aware linting is enabled
  packages = lib.optionals (tsconfig != null) [ pkgs.tsgolint ] ++ cliGuard.fromTasks guardedTasks;

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
