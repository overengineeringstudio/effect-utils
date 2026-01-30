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
#   # Without nix lockfile check (for repos without Nix CLI builds):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.check { hasNixCheck = false; }) ];
#
# Provides: check:quick, check:all
#
# Note: Requires ts:check task to exist.
# Requires lint:check task (unless hasLint = false).
# Requires nix:check:quick task (unless hasNixCheck = false).
# check:all requires test:run (unless hasTests = false).
# check:all requires test:pw:run (if hasPlaywright = true).
{
  hasTests ? true,
  hasPlaywright ? false,
  hasLint ? true,
  hasNixCheck ? true,
}:
{ lib, ... }:
let
  lintDeps = lib.optionals hasLint [ "lint:check" ];
  nixCheckDeps = lib.optionals hasNixCheck [ "nix:check:quick" ];
  testDeps = lib.optionals hasTests [ "test:run" ];
  playwrightDeps = lib.optionals hasPlaywright [ "test:pw:run" ];
  allTestDeps = testDeps ++ playwrightDeps;

  # Build description parts
  descParts = lib.optionals hasLint [ "lint" ] ++
              lib.optionals hasNixCheck [ "nix" ] ++
              lib.optionals hasTests [ "test" ] ++
              lib.optionals hasPlaywright [ "e2e" ];
  extraDesc = if descParts != [] then ", ${lib.concatStringsSep ", " descParts}" else "";
in
{
  tasks = {
    "check:quick" = {
      description = "Run quick checks (genie, typecheck${if hasLint then ", lint" else ""}${if hasNixCheck then ", nix" else ""}) without tests";
      after = [ "ts:check" "megarepo:check" ] ++ lintDeps ++ nixCheckDeps;
    };
    "check:all" = {
      description = "Run all checks (genie, typecheck${extraDesc})";
      after = [ "ts:check" "megarepo:check" ] ++ lintDeps ++ nixCheckDeps ++ allTestDeps;
    };
  };
}
