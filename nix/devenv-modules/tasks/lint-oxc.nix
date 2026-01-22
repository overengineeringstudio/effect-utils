# Lint tasks using oxlint/oxfmt
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
#       # Directories to scan for genie coverage check
#       genieCoverageDirs = [ "packages" "scripts" ];  # required
#       # Extra directories to exclude from genie coverage
#       genieCoverageExcludes = [ "storybook-static" ];  # optional
#       # Custom oxfmt exclusions (in addition to node_modules)
#       oxfmtExcludes = [ "**/package.json" "**/tsconfig.json" ];  # optional
#       # Config file paths (default: ./oxfmt.json and ./oxlint.json)
#       oxfmtConfig = "./oxfmt.json";  # optional
#       oxlintConfig = "./oxlint.json";  # optional
#     })
#   ];
#
# Provides: lint:check, lint:check:format, lint:check:oxlint, lint:check:genie, lint:check:genie:coverage
#           lint:fix, lint:fix:format, lint:fix:oxlint
{
  genieCoverageDirs,
  genieCoverageExcludes ? [],
  oxfmtExcludes ? [],
  oxfmtConfig ? "./oxfmt.json",
  oxlintConfig ? "./oxlint.json",
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
  
  # Build oxfmt exclusion args
  oxfmtExcludeArgs = builtins.concatStringsSep " " (
    [ "'!**/node_modules/**'" ] ++ map (p: "'!${p}'") oxfmtExcludes
  );
in
{
  tasks = {
    # Lint check tasks
    "lint:check:format" = {
      description = "Check code formatting with oxfmt";
      exec = "oxfmt -c ${oxfmtConfig} --check . ${oxfmtExcludeArgs}";
      after = [ "genie:run" ];
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/*.js" "**/*.jsx" "oxfmt.json" ];
    };
    "lint:check:oxlint" = {
      description = "Run oxlint linter";
      exec = "oxlint -c ${oxlintConfig} --import-plugin --deny-warnings";
      after = [ "genie:run" ];
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/*.js" "**/*.jsx" "oxlint.json" ];
    };
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      exec = "genie --check";
      execIfModified = [ "**/*.genie.ts" ];
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
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [ "lint:check:format" "lint:check:oxlint" "lint:check:genie" "lint:check:genie:coverage" ];
    };

    # Lint fix tasks
    "lint:fix:format" = {
      description = "Fix code formatting with oxfmt";
      exec = "oxfmt -c ${oxfmtConfig} . ${oxfmtExcludeArgs}";
    };
    "lint:fix:oxlint" = {
      description = "Fix lint issues with oxlint";
      exec = "oxlint -c ${oxlintConfig} --import-plugin --deny-warnings --fix";
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [ "lint:fix:format" "lint:fix:oxlint" ];
    };
  };
}
