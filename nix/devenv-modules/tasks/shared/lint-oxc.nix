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
  # Real derivation/path backing the `oxlint` guard (e.g. the plugin-injecting
  # oxlint wrapper). When set, the guard owns `bin/oxlint` and exec's this by
  # absolute path under passthrough (see cli-guard.nix). The `oxfmt` guard uses
  # pkgs.oxfmt directly since that is in-module.
  oxlintPkg ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
  git = "${pkgs.git}/bin/git";
  scanDirsSetup = builtins.concatStringsSep "\n" (
    map (dir: "scan_dir_args+=(${builtins.toJSON dir})") genieCoverageDirs
  );
  excludePathspecsSetup = builtins.concatStringsSep "\n" (
    map (p: "pathspec_args+=(${builtins.toJSON ":(exclude)${p}"})") genieCoverageExcludes
  );
  coverageFileMatches = builtins.concatStringsSep " || " (
    lib.concatMap (f: [
      ''"$f" == ${builtins.toJSON f}''
      ''"$f" == */${f}''
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
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "lint:check:genie" "genie --check";
      execIfModified = geniePatterns;
    };
    "lint:check:genie:coverage" = {
      description = "Check all config files have .genie.ts sources";
      exec = trace.exec "lint:check:genie:coverage" ''
        set -euo pipefail

        scan_dir_args=()
        ${scanDirsSetup}
        pathspec_args=()
        ${excludePathspecsSetup}

        # Enumerate config files via git instead of scanning the filesystem.
        #
        # Rationale:
        # - Avoids traversing huge trees (node_modules) even when excluded.
        # - Correctly checks files that are tracked or about to be committed
        #   (untracked but not ignored).
        # - Prevents false negatives from caching based only on *.genie.ts files.
        files=$(
          {
            ${git} ls-files -- "''${scan_dir_args[@]}" "''${pathspec_args[@]}"
            ${git} ls-files --others --exclude-standard -- "''${scan_dir_args[@]}" "''${pathspec_args[@]}"
          } | sort -u | while IFS= read -r f; do
            if [[ ${coverageFileMatches} ]]; then
              echo "$f"
            fi
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
    "lint:check:asset-import-needs-type-reference" = {
      description = "Require a /// <reference> for asset side-effect imports in compiled source";
      exec = trace.exec "lint:check:asset-import-needs-type-reference" ''
        set -euo pipefail

        # A bare `import '...css'` (or scss/sass/less) in compiled, exported source needs an ambient
        # `*.css` declaration to type it. If that ambient lives only in a floating `.d.ts` pulled in
        # by this package's own tsconfig `include`, it does NOT travel into a downstream consumer
        # that compiles this source via `exports`-resolution — the side-effect import then fails with
        # TS2882 (see #837). A `/// <reference path|types ...>` directive in the SAME file is part of
        # that file's load graph, so the declaration travels into every program that compiles it.
        #
        # This guard requires that any compiled-source file with an asset side-effect import also
        # carries a `/// <reference>`. It runs out-of-band (an inline `oxlint-disable` of
        # `no-unassigned-import` cannot suppress it). Exempts the globs where side-effect imports are
        # allowed and not type-checked into downstream graphs: `.storybook/**`, `*.gen.*`, `*.d.ts`,
        # `*.test.*`, `*.stories.*`.
        offenders=$(
          {
            ${git} ls-files -- 'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
              'context/**/*.ts' 'context/**/*.tsx'
            ${git} ls-files --others --exclude-standard -- \
              'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
              'context/**/*.ts' 'context/**/*.tsx'
          } | sort -u | while IFS= read -r f; do
            [ -z "$f" ] && continue
            case "$f" in
              */.storybook/*|*.gen.*|*.d.ts|*.test.*|*.stories.*) continue ;;
            esac
            ${pkgs.gawk}/bin/awk '
              /^[[:space:]]*import[[:space:]]+['"'"'"][^'"'"'"]*\.(css|scss|sass|less)['"'"'"]/ { asset = 1 }
              /^[[:space:]]*\/\/\/[[:space:]]*<reference[[:space:]]/ { ref = 1 }
              END { if (asset == 1 && ref != 1) print FILENAME }
            ' "$f"
          done | sort -u
        )
        if [ -n "$offenders" ]; then
          echo "Asset side-effect import without a travelling type reference in compiled source:"
          echo "$offenders"
          echo ""
          echo "Add a '/// <reference path=\"...\" />' to a shipped '*.css' ambient in the importing"
          echo "file so the declaration travels into downstream TS checks (see #837), or move the"
          echo "import under a '.storybook/*' entry that is not type-checked downstream."
          exit 1
        fi
        echo "All asset side-effect imports in compiled source carry a type reference"
      '';
      # Intentionally no execIfModified caching: a newly added asset import in any source
      # file is exactly what this task exists to detect.
    };
    "lint:check:lockfile" = {
      description = "Verify pnpm-lock.yaml matches package.json specifiers";
      after = [ "pnpm:install" ];
      exec = trace.exec "lint:check:lockfile" ''
        set -euo pipefail
        store_dir="''${npm_config_store_dir:-''${PNPM_CONFIG_STORE_DIR:-''${PNPM_STORE_DIR:-$PWD/.devenv/pnpm-store}}}"
        export PNPM_STORE_DIR="$store_dir"
        export PNPM_CONFIG_STORE_DIR="$store_dir"
        export npm_config_store_dir="$store_dir"
        pnpm install \
          --frozen-lockfile \
          --ignore-scripts \
          --config.confirmModulesPurge=false \
          --config.side-effects-cache=false \
          --config.verify-store-integrity=true \
          --config.strict-store-pkg-content-check=true \
          --config.package-import-method=clone-or-copy \
          --pm-on-fail=ignore \
          --config.store-dir="$store_dir"
      '';
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [
        "lint:check:format"
        "lint:check:oxlint"
        "lint:check:genie"
        "lint:check:genie:coverage"
        "lint:check:asset-import-needs-type-reference"
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
  # Provide tsgolint when type-aware linting is enabled.
  # The oxlint/oxfmt guards own their command names (exec the reals via absolute
  # path, see cli-guard.nix), so oxfmt is dropped as a top-level provider here and
  # oxlint is dropped from the consumer's `packages` — removing the buildEnv
  # collision while keeping both reachable under passthrough.
  packages =
    lib.optionals (tsconfig != null) [ pkgs.tsgolint ]
    ++ cliGuard.fromTasks {
      tasks = guardedTasks;
      reals = {
        oxfmt = pkgs.oxfmt;
      }
      // lib.optionalAttrs (oxlintPkg != null) { oxlint = oxlintPkg; };
    };

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
