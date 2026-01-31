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
#     })
#   ];
#
# Provides: lint:check, lint:check:format, lint:check:oxlint, lint:check:genie, lint:check:genie:coverage
#           lint:fix, lint:fix:format, lint:fix:oxlint
{
  execIfModifiedPatterns,
  geniePatterns,
  genieCoverageDirs,
  genieCoverageExcludes ? [],
  lintPaths ? [ "." ],
}:
{ lib, ... }:
let
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
in
{
  tasks = {
    # Lint check tasks
    # Uses default config files (.oxfmtrc.json, .oxlintrc.json) - no -c flags needed
    "lint:check:format" = {
      description = "Check code formatting with oxfmt";
      exec = "oxfmt --check ${lintPathsArg}";
      after = [ "genie:run" ];
      execIfModified = execIfModifiedPatterns;
    };
    "lint:check:oxlint" = {
      description = "Run oxlint linter";
      exec = "oxlint --import-plugin --deny-warnings ${lintPathsArg}";
      after = [ "genie:run" ];
      execIfModified = execIfModifiedPatterns;
    };
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      exec = "genie --check";
      execIfModified = geniePatterns;
    };
    "lint:check:genie:coverage" = {
      description = "Check all config files have .genie.ts sources";
      exec = ''
        missing=$(find ${scanDirsArg} \
          -type f \( -name "package.json" -o -name "tsconfig.json" \) \
          ${excludeArgs} \
          | while read -r f; do
              [ ! -f "$f.genie.ts" ] && echo "$f"
            done | sort)
        if [ -n "$missing" ]; then
          echo "Missing .genie.ts sources for:"
          echo "$missing"
          exit 1
        fi
        echo "All config files have .genie.ts sources"
      '';
      # Cache based on genie files - if no new .genie.ts files added, coverage is unchanged
      execIfModified = geniePatterns;
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [ "lint:check:format" "lint:check:oxlint" "lint:check:genie" "lint:check:genie:coverage" ];
    };

    # Lint fix tasks
    "lint:fix:format" = {
      description = "Fix code formatting with oxfmt";
      exec = "oxfmt ${lintPathsArg}";
    };
    "lint:fix:oxlint" = {
      description = "Fix lint issues with oxlint";
      exec = "oxlint --import-plugin --deny-warnings --fix ${lintPathsArg}";
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [ "lint:fix:format" "lint:fix:oxlint" ];
    };
  };
}
