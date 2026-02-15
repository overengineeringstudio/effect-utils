# Minimal lint tasks using only genie (no oxlint/oxfmt)
#
# Usage in devenv.nix:
#   imports = [
#     inputs.effect-utils.devenvModules.tasks.lint-genie
#   ];
#
# Provides: lint:check, lint:check:genie, lint:fix
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "lint:check:genie" = {
      description = "Check generated files are up to date";
      exec = trace.exec "lint:check:genie" "genie --check";
      after = [ "genie:run" "pnpm:install" ];
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [ "lint:check:genie" ];
    };
    "lint:fix" = {
      description = "Fix all lint issues (no formatter configured)";
      exec = "echo 'No lint fixer configured'";
    };
  };
}
