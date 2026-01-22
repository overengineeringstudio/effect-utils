# Minimal lint tasks using only genie (no oxlint/oxfmt)
#
# Usage in devenv.nix:
#   imports = [
#     inputs.effect-utils.devenvModules.tasks.lint-genie
#   ];
#
# Provides: lint:check, lint:check:genie, lint:fix
{ ... }:
{
  tasks = {
    "lint:check:genie" = {
      exec = "genie --check";
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [ "lint:check:genie" ];
    };
    "lint:fix" = {
      description = "Fix all lint issues (placeholder - no formatter configured)";
      exec = "echo 'No lint fixer configured'";
    };
  };
}
