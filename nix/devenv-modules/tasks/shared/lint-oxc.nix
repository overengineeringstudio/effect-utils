# Lint tasks using oxlint/oxfmt
#
# Uses default config file paths (.oxfmtrc.json, .oxlintrc.json) - no explicit -c flags needed.
# Ignore patterns should be configured in the config files themselves (via genie).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
#       # Git pathspecs that define the lint surface.
#       lintPaths = [ "packages" "scripts" ];
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
  geniePatterns,
  genieCoverageDirs,
  genieCoverageExcludes ? [ ],
  genieCoverageFiles ? [
    "package.json"
    "tsconfig.json"
  ],
  # Git pathspecs that define the lint surface. Lint tasks enumerate tracked and
  # untracked non-ignored files below these paths, so ignored dependency/build
  # trees are never walked by devenv or the lint tools.
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
  lintPathspecsSetup = builtins.concatStringsSep "\n" (
    map (pathspec: "lint_pathspec_args+=(${builtins.toJSON pathspec})") lintPaths
  );

  mkLintExec =
    {
      command,
      includeCase,
    }:
    ''
      set -euo pipefail

      lint_pathspec_args=()
      ${lintPathspecsSetup}

      files=$(mktemp)
      trap 'rm -f "$files"' EXIT
        {
          ${git} ls-files -z -- "''${lint_pathspec_args[@]}"
          ${git} ls-files -z --others --exclude-standard -- "''${lint_pathspec_args[@]}"
        } | ${pkgs.coreutils}/bin/sort -zu | while IFS= read -r -d "" path; do
          [ -e "$path" ] || [ -L "$path" ] || continue
          case "$path" in
            ${includeCase}
              printf '%s\0' "$path"
              ;;
          esac
        done > "$files"

      if [ ! -s "$files" ]; then
        echo "No lint files matched"
        exit 0
      fi

        ${pkgs.findutils}/bin/xargs -0 ${command} < "$files"
    '';

  oxlintIncludeCase = ''
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx)
  '';
  oxfmtIncludeCase = ''
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.json|*.jsonc|*.yaml|*.yml|*.toml|*.html|*.css|*.md|*.markdown)
  '';

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
    mkLintExec {
      command = "oxlint --import-plugin ${flags} ${typeAwareFlags}";
      includeCase = oxlintIncludeCase;
    };

  guardedTasks = {
    "lint:check:format" = {
      guard = "oxfmt";
      description = "Check code formatting with oxfmt";
      exec = trace.exec "lint:check:format" (mkLintExec {
        command = "oxfmt --check";
        includeCase = oxfmtIncludeCase;
      });
      execIfModified = [ ];
    };
    "lint:check:oxlint" = {
      guard = "oxlint";
      description = "Run oxlint linter";
      exec = trace.exec "lint:check:oxlint" (mkOxlintCmd "");
      execIfModified = [ ];
    }
    // lib.optionalAttrs (tsconfig != null) {
      after = [ "pnpm:install" ];
    };
    "lint:fix:format" = {
      guard = "oxfmt";
      description = "Fix code formatting with oxfmt";
      exec = trace.exec "lint:fix:format" (mkLintExec {
        command = "oxfmt";
        includeCase = oxfmtIncludeCase;
      });
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
