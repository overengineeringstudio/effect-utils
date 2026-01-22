# Lint tasks using oxlint/oxfmt
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-oxc {
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
  genieCoverageDirs,
  genieCoverageExcludes ? []
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
in
{
  tasks = {
    # Lint check tasks
    "lint:check:format" = {
      exec = "oxfmt -c ./oxfmt.json --check . '!**/node_modules/**'";
      after = [ "genie:run" ];
    };
    "lint:check:oxlint" = {
      exec = "oxlint -c ./oxlint.json --import-plugin --deny-warnings";
      after = [ "genie:run" ];
    };
    "lint:check:genie" = {
      exec = "genie --check";
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
      exec = "oxfmt -c ./oxfmt.json .";
    };
    "lint:fix:oxlint" = {
      exec = "oxlint -c ./oxlint.json --import-plugin --deny-warnings --fix";
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [ "lint:fix:format" "lint:fix:oxlint" ];
    };
  };
}
