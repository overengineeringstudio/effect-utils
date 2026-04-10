# Aggregate check tasks
#
# Usage in devenv.nix:
#   # With unit tests (default):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check {}) ];
#
#   # With unit tests and playwright e2e tests:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasPlaywright = true; }) ];
#
#   # Without any tests:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasTests = false; }) ];
#
#   # Without lint (for repos not using lint-oxc module yet):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasTests = false; hasLint = false; }) ];
#
#   # Without nix checks (for repos without Nix CLI builds):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasNixCheck = false; }) ];
#
#   # Without megarepo checks (for repos that skip members in CI):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasMegarepoCheck = false; }) ];
#
#   # With strict type checking in aggregate gates:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { checkAllTypecheckTask = "ts:check:strict"; }) ];
#
#   # With additional custom checks:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { extraChecks = [ "workspace:check" ]; }) ];
#
# Provides: check:quick, check:all
#
# check:quick - Fast local development (ts:check, mr:check*, lint, nix-fingerprint)
# check:all   - Comprehensive validation (defaults to ts:check, can opt into ts:check:strict)
#               * mr:check included unless hasMegarepoCheck = false
#
# Note: Requires ts:check task to exist.
# Requires lint:check task (unless hasLint = false).
# Requires nix-cli module tasks (unless hasNixCheck = false):
#   - check:quick uses nix:check:quick
#   - check:all uses nix:flake:check
# check:all requires test:run (unless hasTests = false).
# check:all requires test:pw:run (if hasPlaywright = true).
{
  hasTests ? true,
  hasPlaywright ? false,
  hasLint ? true,
  hasNixCheck ? true,
  hasMegarepoCheck ? true,
  checkQuickTypecheckTask ? "ts:check",
  checkAllTypecheckTask ? checkQuickTypecheckTask,
  extraChecks ? [ ], # Additional check tasks to include (e.g., [ "workspace:check" ])
}:
{ lib, ... }:
let
  lintTask = lib.optional hasLint "lint:check";
  nixQuickTask = lib.optionals hasNixCheck [ "nix:check:quick" ];
  nixFullTask = lib.optionals hasNixCheck [ "nix:flake:check" ];
  testTasks = lib.optionals hasTests ([ "test:run" ] ++ lib.optional hasPlaywright "test:pw:run");
  megarepoTasks = lib.optionals hasMegarepoCheck [
    "mr:check"
    "mr:lock-sync-check"
  ];

  # Build description parts
  descParts =
    lib.optionals hasLint [ "lint" ]
    ++ lib.optionals hasNixCheck [ "nix" ]
    ++ lib.optionals hasTests [ "test" ]
    ++ lib.optionals hasPlaywright [ "e2e" ];
  extraDesc = if descParts != [ ] then ", ${lib.concatStringsSep ", " descParts}" else "";
in
{
  tasks = {
    "check:quick" = {
      description = "Fast checks for development (${checkQuickTypecheckTask}${lib.optionalString hasLint ", lint"}${lib.optionalString hasNixCheck ", nix-fingerprint"}) without tests";
      exec = "true";
      after = [ checkQuickTypecheckTask ]
        ++ megarepoTasks
        ++ lintTask
        ++ nixQuickTask
        ++ extraChecks;
    };

    "check:all" = {
      description = "All checks (${checkAllTypecheckTask}${extraDesc})";
      exec = "true";
      after = [ checkAllTypecheckTask ]
        ++ megarepoTasks
        ++ extraChecks
        ++ lintTask
        ++ nixFullTask
        ++ testTasks;
    };
  };
}
