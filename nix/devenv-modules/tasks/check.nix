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
# Provides: check:quick, check:all
#
# Note: Requires ts:check, lint:check tasks to exist.
# check:all requires test:run (unless hasTests = false).
# check:all requires test:pw:run (if hasPlaywright = true).
{
  hasTests ? true,
  hasPlaywright ? false,
}:
{ lib, ... }:
let
  testDeps = lib.optionals hasTests [ "test:run" ];
  playwrightDeps = lib.optionals hasPlaywright [ "test:pw:run" ];
  allTestDeps = testDeps ++ playwrightDeps;
  
  testDesc = lib.concatStringsSep ", " (
    lib.optionals hasTests [ "test" ] ++
    lib.optionals hasPlaywright [ "e2e" ]
  );
in
{
  tasks = {
    "check:quick" = {
      description = "Run quick checks (genie, typecheck, lint) without tests";
      after = [ "ts:check" "lint:check" ];
    };
    "check:all" = {
      description = "Run all checks (genie, typecheck, lint${if allTestDeps != [] then ", ${testDesc}" else ""})";
      after = [ "ts:check" "lint:check" ] ++ allTestDeps;
    };
  };
}
