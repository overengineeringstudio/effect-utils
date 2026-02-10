# Lint tasks using oxlint/oxfmt
#
# Uses default config file paths (.oxfmtrc.json, .oxlintrc.json) - no explicit -c flags needed.
# Ignore patterns should be configured in the config files themselves (via genie).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
#       # Explicit glob patterns for execIfModified (avoids node_modules traversal)
#       # IMPORTANT: Use patterns that don't traverse into node_modules directories
#       # Good: "packages/@overeng/*/src/**/*.ts" (src/ never contains node_modules)
#       # Bad:  "packages/**/*.ts" (traverses into packages/*/node_modules/)
#       execIfModifiedPatterns = [
#         "packages/@overeng/*/src/**/*.ts"
#         "packages/@overeng/*/src/**/*.tsx"
#         "packages/@overeng/*/*.ts"  # root config files including *.genie.ts
#         "scripts/*.ts"
#         "scripts/commands/**/*.ts"
#       ];
#       # Glob patterns for .genie.ts files (for genie check caching)
#       # Should match all *.genie.ts files without traversing node_modules
#       geniePatterns = [
#         "packages/@overeng/*/*.genie.ts"
#         "scripts/*.genie.ts"
#       ];
#       # Directories to scan for genie coverage check
#       genieCoverageDirs = [ "packages" "scripts" ];  # required
#       # Extra directories to exclude from genie coverage
#       genieCoverageExcludes = [ "storybook-static" ];  # optional
#       # Path to tsconfig for type-aware linting (enables typescript/no-deprecated etc)
#       tsconfig = "tsconfig.all.json";  # optional
#       # Pre-built JS plugin paths to inject at runtime (for repos without node_modules)
#       # These are merged into .oxlintrc.json's jsPlugins field at runtime.
#       # jsPlugins = [ "${oxcConfigPlugin}/plugin.js" ];  # optional
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
  lintPaths ? [ "." ],
  # Type-aware linting: provide tsconfig to enable --type-aware flag.
  # Requires pkgs.tsgolint in devenv packages (auto-discovered on PATH by oxlint).
  tsconfig ? null,
  # Pre-built JS plugin paths to inject into oxlint config at runtime.
  # When provided, the oxlint task creates a temporary config merging these
  # jsPlugins into the project's .oxlintrc.json, allowing overeng/* rules
  # without needing effect-utils' node_modules installed.
  jsPlugins ? [ ],
  # Whether to treat warnings as errors. Set to false for repos with many
  # existing warnings that can't be fixed immediately.
  denyWarnings ? true,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  git = "${pkgs.git}/bin/git";
  defaultExcludes = [
    "node_modules"
    "dist"
    ".git"
    ".direnv"
    ".devenv"
    "tmp"
    ".next"
    ".vercel"
    ".contentlayer"
  ];
  allExcludes = defaultExcludes ++ genieCoverageExcludes;
  excludeArgs = builtins.concatStringsSep " " (map (d: "-not -path \"*/${d}/*\"") allExcludes);
  scanDirsArg = builtins.concatStringsSep " " genieCoverageDirs;
  lintPathsArg = builtins.concatStringsSep " " lintPaths;

  # Type-aware linting flags (enabled when tsconfig is provided)
  typeAwareFlags = if tsconfig != null then "--type-aware --tsconfig ${tsconfig}" else "";
  warningsFlag = if denyWarnings then "--deny-warnings" else "";

  # When jsPlugins are provided, inject them into the config at runtime.
  # Replaces any existing jsPlugins in .oxlintrc.json with the Nix-provided paths.
  # This ensures stale/unresolvable source paths from the genie template are dropped.
  hasJsPlugins = jsPlugins != [ ];
  jsPluginsJson = builtins.toJSON jsPlugins;
  mkOxlintCmd =
    extraFlags:
    let
      flags = "${warningsFlag} ${extraFlags}";
    in
    if hasJsPlugins then
      ''
        set -euo pipefail
        if [ ! -f .oxlintrc.json ]; then
          echo "error: jsPlugins requires .oxlintrc.json but none was found" >&2
          exit 1
        fi
        tmpconfig=$(${pkgs.coreutils}/bin/mktemp)
        trap 'rm -f "$tmpconfig"' EXIT
        ${pkgs.jq}/bin/jq --argjson plugins '${jsPluginsJson}' \
          '.jsPlugins = $plugins' \
          .oxlintrc.json > "$tmpconfig"
        oxlint -c "$tmpconfig" --import-plugin ${flags} ${typeAwareFlags} ${lintPathsArg}
      ''
    else
      "oxlint --import-plugin ${flags} ${typeAwareFlags} ${lintPathsArg}";
in
{
  # Provide tsgolint when type-aware linting is enabled
  packages = lib.optionals (tsconfig != null) [ pkgs.tsgolint ];

  tasks = {
    # Lint check tasks
    # Uses default config files (.oxfmtrc.json, .oxlintrc.json) - no -c flags needed
    "lint:check:format" = {
      description = "Check code formatting with oxfmt";
      exec = trace.exec "lint:check:format" "oxfmt --check ${lintPathsArg}";
      # TODO: Drop "pnpm:install" dep once devenv supports glob negation patterns (e.g. !**/node_modules/**)
      #   Upstream issue: https://github.com/cachix/devenv/issues/2422
      #   Upstream fix:   https://github.com/cachix/devenv/pull/2423
      after = [
        "genie:run"
        "pnpm:install"
      ];
      execIfModified = execIfModifiedPatterns;
    };
    "lint:check:oxlint" = {
      description = "Run oxlint linter";
      exec = trace.exec "lint:check:oxlint" (mkOxlintCmd "");
      # TODO: Drop "pnpm:install" dep once devenv supports glob negation patterns (e.g. !**/node_modules/**)
      #   Upstream issue: https://github.com/cachix/devenv/issues/2422
      #   Upstream fix:   https://github.com/cachix/devenv/pull/2423
      after = [
        "genie:run"
        "pnpm:install"
      ];
      execIfModified = execIfModifiedPatterns;
    };
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      exec = trace.exec "lint:check:genie" "genie --check";
      # TODO: Drop "pnpm:install" dep once devenv supports glob negation patterns
      #   See: https://github.com/cachix/devenv/issues/2422, https://github.com/cachix/devenv/pull/2423
      after = [ "pnpm:install" ];
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
            ${git} ls-files -- ${scanDirsArg}
            ${git} ls-files --others --exclude-standard -- ${scanDirsArg}
          } | sort -u | while IFS= read -r f; do
            case "$f" in
              package.json|tsconfig.json|*/package.json|*/tsconfig.json) echo "$f" ;;
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
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:format"
        "lint:check:oxlint"
        "lint:check:genie"
        "lint:check:genie:coverage"
      ];
    };

    # Lint fix tasks
    "lint:fix:format" = {
      description = "Fix code formatting with oxfmt";
      exec = trace.exec "lint:fix:format" "oxfmt ${lintPathsArg}";
      # TODO: Drop "pnpm:install" dep once devenv supports glob negation patterns
      #   See: https://github.com/cachix/devenv/issues/2422, https://github.com/cachix/devenv/pull/2423
      after = [ "pnpm:install" ];
    };
    "lint:fix:oxlint" = {
      description = "Fix lint issues with oxlint";
      exec = trace.exec "lint:fix:oxlint" (mkOxlintCmd "--fix");
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [
        "lint:fix:format"
        "lint:fix:oxlint"
      ];
    };
  };
}
