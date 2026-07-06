# Bootstrap-safe import-closure gate (issue #884; SCOPED TO BOOTSTRAP-PHASE, ZERO-TOLERANCE)
#
# Usage in devenv.nix (effect-utils, default entry):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure {}) ];
#
# Downstream members must pass their own repo-relative `entry` (a bun script that imports
# `checkBootstrapClosure` from `@overeng/genie/node` and scopes to its own bootstrap-phase set):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure { entry = "genie/bootstrap-closure-check.ts"; }) ];
#
# Provides: bootstrap-closure:check
#
# Runs the bun entry (default genie/ci-scripts/bootstrap-closure-check.ts) over the TRACKED
# `.genie.ts` sources declared `bootstrap`-phase (static `// @genie-phase bootstrap` pragma). A
# bootstrap-phase generator (and everything it transitively imports at RUNTIME) must be importable
# from a fresh checkout BEFORE install: one that reaches a runtime-only package — e.g. through a
# wide barrel that `export *`s a module importing `effect` — pulls that package into the bootstrap
# import closure and breaks the pre-install `genie --phase bootstrap` run on a fresh clone.
#
# Zero-tolerance: it fails on ANY bootstrap-phase violation. There is no baseline and no allowlist;
# `design-time` generators (the default) are out of scope by declaration. This gate is fast local
# feedback for the ordering contract (decision 0004); install ordering is the ultimate arbiter.
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
      description = "Fail on any bootstrap-safe import-closure violation in bootstrap-phase .genie.ts sources (zero-tolerance)";
      exec = trace.exec "bootstrap-closure:check" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        ${pkgs.bun}/bin/bun "$root/${entry}"
      '';
    };
  };
}
