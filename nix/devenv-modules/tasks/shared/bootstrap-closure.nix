# Bootstrap-safe import-closure gate (issue #884; SCOPED TO BOOTSTRAP-PHASE, ZERO-TOLERANCE)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure {}) ];
#
# Provides: bootstrap-closure:check
#
# Runs effect-utils' shared checker over the importing repo's TRACKED
# `.genie.ts` sources declared `bootstrap`-phase (static `// @genie-bootstrap` pragma). A
# bootstrap-phase generator (and everything it transitively imports at RUNTIME) must be importable
# from a fresh checkout BEFORE install: one that reaches a runtime-only package — e.g. through a
# wide barrel that `export *`s a module importing `effect` — pulls that package into the bootstrap
# import closure and breaks the pre-install `genie --phase bootstrap` run on a fresh clone.
#
# Zero-tolerance: it fails on ANY bootstrap-phase violation. There is no baseline and no allowlist;
# `design-time` generators (the default) are out of scope by declaration. This gate is fast local
# feedback (R30); the empirical authority is `bootstrap:cold-proof` (R32), which runs the
# bootstrap-phase generators in a no-`node_modules` checkout before install (decision 0004).
#
# The gate is a checker, not a bootstrap-phase generator. The task runs a compiled Nix checker
# package so `typescript` and the walker implementation are explicit package inputs, not ambient
# Bun auto-install or downstream `node_modules` state.
{
  # Optional task prerequisites for repos that want local ordering. The checker itself is packaged
  # and does not require package-manager install state.
  after ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  effectUtilsSrc = builtins.path {
    path = ../../../..;
    name = "effect-utils-source";
  };
  checkerPkg = import (effectUtilsSrc + "/packages/@overeng/genie/nix/bootstrap-closure-check.nix") {
    inherit pkgs;
    src = effectUtilsSrc;
  };
in
{
  tasks = {
    "bootstrap-closure:check" = {
      inherit after;
      description = "Fail on any bootstrap-safe import-closure violation in bootstrap-phase .genie.ts sources (zero-tolerance)";
      exec = trace.exec "bootstrap-closure:check" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        ${checkerPkg}/bin/genie-bootstrap-closure-check --root "$root"
      '';
    };
  };
}
