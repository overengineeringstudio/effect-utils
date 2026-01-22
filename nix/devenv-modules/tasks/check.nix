# Aggregate check tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.check ];
#
# Provides: check:quick, check:all
#
# Note: Requires ts:check, lint:check tasks to exist.
# check:all also requires test:run.
{ ... }:
{
  tasks = {
    "check:quick" = {
      description = "Run quick checks (genie, typecheck, lint) without tests";
      after = [ "ts:check" "lint:check" ];
    };
    "check:all" = {
      description = "Run all checks (genie, typecheck, lint, test)";
      after = [ "ts:check" "lint:check" "test:run" ];
    };
  };
}
