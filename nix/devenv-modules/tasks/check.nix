# Aggregate check tasks
#
# Usage in devenv.nix:
#   # With tests (default):
#   imports = [ inputs.effect-utils.devenvModules.tasks.check ];
#
#   # Without tests:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasTests = false; }) ];
#
# Provides: check:quick, check:all
#
# Note: Requires ts:check, lint:check tasks to exist.
# check:all also requires test:run (unless hasTests = false).
{
  hasTests ? true
}:
{ ... }:
{
  tasks = {
    "check:quick" = {
      description = "Run quick checks (genie, typecheck, lint) without tests";
      after = [ "ts:check" "lint:check" ];
    };
    "check:all" = {
      description = "Run all checks (genie, typecheck, lint${if hasTests then ", test" else ""})";
      after = [ "ts:check" "lint:check" ] ++ (if hasTests then [ "test:run" ] else []);
    };
  };
}
