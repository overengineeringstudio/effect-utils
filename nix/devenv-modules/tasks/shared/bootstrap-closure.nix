# Bootstrap-safe import-closure gate (issue #884; BASELINE + RATCHET)
#
# Usage in devenv.nix (effect-utils, default entry):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure {}) ];
#
# Downstream members must pass their own repo-relative `entry` (a bun script that imports
# `checkBootstrapClosure` from `@overeng/genie/node` and applies its own committed baseline):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure { entry = "genie/bootstrap-closure-check.ts"; }) ];
#
# Provides: bootstrap-closure:check
#
# Runs the bun entry (default genie/ci-scripts/bootstrap-closure-check.ts) over every TRACKED
# `.genie.ts` source. A generator source (and everything it transitively imports at RUNTIME)
# must be importable from a fresh checkout BEFORE install: one that reaches a runtime-only
# package — e.g. through a wide barrel that `export *`s a module importing `effect` — pulls
# that package into the bootstrap import closure and breaks `genie:run` on a fresh clone.
#
# The gate is baseline + ratchet: it fails ONLY on NEW violations not present in the committed
# baseline (genie/bootstrap-closure-baseline.json), so the pre-existing violations keep it green
# today while any regression (a new/widened import) is caught. It also warns on stale baseline
# entries (a baselined source that no longer violates) so the baseline can be ratcheted down.
{
  # Repo-relative path to the bun entry.
  entry ? "genie/ci-scripts/bootstrap-closure-check.ts",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "bootstrap-closure:check" = {
      description = "Fail on NEW bootstrap-safe import-closure violations in .genie.ts sources (baseline + ratchet)";
      exec = trace.exec "bootstrap-closure:check" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        ${pkgs.bun}/bin/bun "$root/${entry}"
      '';
    };
  };
}
