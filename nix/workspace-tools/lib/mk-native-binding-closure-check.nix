# Thin `nix flake check` wrapper around the native-binding closure-completeness
# assertion. Given a prepared deps-FOD output, asserts every pure-package-artifact
# native binding within the workspace's declared `supportedArchitectures` is
# physically present. Turns the #807 closure-completeness guarantee into a
# build-graph gate: a bindingless (or partially materialized) deps FOD becomes a
# hard, precisely named check failure instead of a silent ship that only breaks
# on the target arch.
#
# The assertion is ALWAYS-ON and auto-derives the required families from the
# resolved closure (by design) — consumers never hand-list families;
# `includeOptionalDependencies` is the separate per-consumer opt-in for the FIX
# (materialization). This check is the guardrail that fails even when a consumer
# forgets to opt in.
#
# Separate derivation, not an assertion inside the FOD: the deps FOD is a
# content-addressed fixed-output derivation whose hash merely *describes* its
# content; a bindingless FOD is not "wrong", it is a different (incomplete)
# artifact. The correctness judgement belongs in a normal check derivation whose
# closure includes the FOD output. (The same script can ALSO run inside the FOD
# installPhase pre-archive as the hard #1 gate — both consume one detector.)
#
# REQUIRED bundling (do not drop): the check source imports the genie
# `native-dependency-policy.ts`. A bare script store-path cannot resolve sibling
# imports inside the `pkgs.bun` check derivation, so we `bun build` it into a
# single self-contained store artifact first, then run that. (The standalone
# prototype inlines the policy and skips this; the productionized version must
# bundle.)
{ pkgs, checkSource }:

let
  lib = pkgs.lib;
  # Bundle the check + its imports into one self-contained JS file in the store.
  bundledCheck =
    pkgs.runCommand "native-binding-closure-check-bundled.js" { nativeBuildInputs = [ pkgs.bun ]; }
      ''
        bun build ${checkSource} --target=bun --outfile "$out"
      '';
in
# `makeOverridable` so each produced check carries a `.override { phase2 = true; }`
# handle: an operator can force fail-mode for a one-off `nix build` red-on-broken
# DEMONSTRATION against a pre-fix FOD WITHOUT editing the wired flake `checks` entry.
# Steady state needs no override: a root that sets includeOptionalDependencies=true
# already yields engagement=fail (see `engagement` below).
lib.makeOverridable (
  {
    # The prepared deps-FOD output derivation (root.depsBuild).
    depsBuild,
    # Stable name for the check derivation.
    name,
    # Install dir of this root; the lockfile/workspace live under it in the tree.
    # "." for the aggregate root.
    installDir ? ".",
    # Engagement phasing (rollout-safety guard). When the root opted into
    # includeOptionalDependencies it is expected to be closure-complete -> hard
    # FAIL. A root that has NOT opted in still runs the check but in WARN mode so
    # a repin never breaks (phase 1). Flip `phase2` true to hard-fail by default.
    includeOptionalDependencies ? false,
    phase2 ? false,
    # Documented escape hatch: families intentionally excluded from the assertion.
    waiveFamilies ? [ ],
  }:
  let
    subdir = if installDir == "." then "" else "/${installDir}";
    engagement = if includeOptionalDependencies || phase2 then "fail" else "warn";
    waiveArg = builtins.concatStringsSep "," waiveFamilies;
  in
  pkgs.runCommand "${name}-native-binding-closure-check"
    {
      nativeBuildInputs = [ pkgs.bun ];
      # Pure: the script only reads files from the FOD output. No network.
    }
    ''
      tree=${depsBuild}
      lockfile="$tree${subdir}/pnpm-lock.yaml"
      workspace="$tree${subdir}/pnpm-workspace.yaml"

      if [ ! -f "$lockfile" ] || [ ! -f "$workspace" ]; then
        echo "native-binding-closure-check: prepared tree is missing pnpm-lock.yaml/pnpm-workspace.yaml under ${installDir}" >&2
        echo "  tree=$tree" >&2
        exit 1
      fi

      export NBCC_ENGAGEMENT=${engagement}
      export NBCC_WAIVE_FAMILIES=${lib.escapeShellArg waiveArg}
      ${pkgs.bun}/bin/bun ${bundledCheck} "$tree${subdir}" "$lockfile" "$workspace" | tee "$out"
    ''
)
