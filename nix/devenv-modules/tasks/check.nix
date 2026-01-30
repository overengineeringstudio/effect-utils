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
# Provides: check:quick, check:all
#
# check:quick - Fast local development (genie, typecheck, lint, nix-fingerprint)
# check:all   - Comprehensive pre-push validation (includes nix flake check)
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
}:
{ lib, ... }:
let
  lintTask = lib.optional hasLint "lint:check";
  nixQuickTask = lib.optionals hasNixCheck [ "nix:check:quick" ];
  nixFullTask = lib.optionals hasNixCheck [ "nix:flake:check" ];
  testTasks = lib.optionals hasTests ([ "test:run" ] ++ lib.optional hasPlaywright "test:pw:run");

  # Build description parts
  descParts = lib.optionals hasLint [ "lint" ] ++
              lib.optionals hasNixCheck [ "nix" ] ++
              lib.optionals hasTests [ "test" ] ++
              lib.optionals hasPlaywright [ "e2e" ];
  extraDesc = if descParts != [] then ", ${lib.concatStringsSep ", " descParts}" else "";
in
{
  tasks = {
    # Quick: Fast feedback for development (genie, typecheck, lint, nix fingerprint only)
    "check:quick" = {
      description = "Fast checks for development (genie, typecheck${lib.optionalString hasLint ", lint"}${lib.optionalString hasNixCheck ", nix-fingerprint"}) without tests";
      after = [ "ts:check" "megarepo:check" ] ++ lintTask ++ nixQuickTask;
    };

    # All: Comprehensive pre-push validation (includes full nix flake check)
    "check:all" = {
      description = "All checks (genie, typecheck${extraDesc})";
      after = [ "ts:check" "megarepo:check" ] ++ lintTask ++ nixFullTask ++ testTasks;
    };
  };
}
