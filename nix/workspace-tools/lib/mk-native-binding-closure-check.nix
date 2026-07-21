# Proposed new file: nix/workspace-tools/lib/mk-native-binding-closure-check.nix
#
# Thin `nix flake check` wrapper around the native-binding closure-completeness
# assertion. Given a prepared deps-FOD output, asserts every pure-package-artifact
# native binding within the workspace's declared `supportedArchitectures` is
# physically present. Turns the #807 closure-completeness guarantee into a
# build-graph gate: a bindingless (or partially materialized) deps FOD becomes a
# hard, precisely named check failure instead of a silent ship that only breaks
# on the target arch.
#
# The assertion auto-derives the required families from the resolved closure
# (decision 0007) — consumers never hand-list families. Its scope is honest:
# it enforces closure-COMPLETENESS for a root that OPTED IN to carrying optional
# bindings (engagement=fail). It does NOT decide whether a root that needs
# bindings has opted in; a non-opted-in root runs in advisory warn mode
# (decision 0009). The gate that catches a needs-binding root which forgot to opt
# in is the downstream cross-platform build (e.g. a real `vite build` in CI), not
# this check.
#
# Separate derivation, not an assertion inside the FOD: the deps FOD is a
# content-addressed fixed-output derivation whose hash merely *describes* its
# content; a bindingless FOD is not "wrong", it is a different (incomplete)
# artifact. The correctness judgement belongs in a normal check derivation whose
# closure includes the FOD output. (The same script can ALSO run inside the FOD
# installPhase pre-archive as the hard #1 gate — both consume one detector.)
#
# REQUIRED bundling (do not drop): the check source imports the genie
# `native-dependency-policy.ts` (the single policy registry) and the shared
# `native-dep-policy-lib.ts` helpers. A bare script store-path cannot resolve
# sibling imports inside the `pkgs.bun` check derivation, so `genieSrc` is the
# (filtered) genie source dir and we `bun build` the check *within it* into a
# single self-contained store artifact first, then run that. This is what makes
# the wired artifact the same imported+bundled code the repo ships — one
# registry, not a forked inline copy (decision 0007).
{ pkgs, genieSrc }:

let
  lib = pkgs.lib;
  # Bundle the check + its sibling imports into one self-contained JS file. The
  # entry resolves `../native-dependency-policy.ts` and
  # `./native-dep-policy-lib.ts` from within `genieSrc`.
  bundledCheck =
    pkgs.runCommand "native-binding-closure-check-bundled.js" { nativeBuildInputs = [ pkgs.bun ]; }
      ''
        bun build ${genieSrc}/ci-scripts/native-binding-closure-check.ts \
          --target=bun --outfile "$out"
      '';
in
# `makeOverridable` so each produced check carries a `.override { forceFail = true; }`
# handle: anyone can force fail-mode for a one-off `nix build` red-on-broken
# DEMONSTRATION against a pre-fix FOD WITHOUT editing the wired flake `checks`
# entry. This is a demonstration aid only — it is NOT a rollout phase. Making
# binding inclusion the default for a class of roots is a deliberate versioned
# prepared-deps transition (decision 0009), not a flag flipped here. Steady state
# needs no override: a root that opts into optional bindings already yields
# engagement=fail (see `engagement` below).
lib.makeOverridable (
  {
    # The prepared deps-FOD output derivation (root.depsBuild).
    depsBuild,
    # Stable name for the check derivation.
    name,
    # Install dir of this root; the lockfile/workspace live under it in the tree.
    # "." for the aggregate root.
    installDir ? ".",
    # Engagement (decision 0009). A root that opts into optional-binding
    # inclusion is expected to be closure-complete -> hard FAIL. A root that has
    # NOT opted in still runs the check but in advisory WARN mode (its bindings
    # are not required for that root), so a repin never breaks it.
    includeOptionalDependencies ? false,
    # Demonstration-only force-fail (see `makeOverridable` note above). Not a
    # rollout phase; leave false in wired checks.
    forceFail ? false,
    # Completeness criterion. `all-declared-triples` (default) is the
    # shared-FOD-hash soundness gate. `build-platform` requires only the build
    # host's triple, for a per-system hash fallback (needs buildPlatformTriple).
    completenessMode ? "all-declared-triples",
    # "os,cpu,libc" for build-platform mode (e.g. "linux,arm64,glibc"); null
    # otherwise.
    buildPlatformTriple ? null,
    # Documented escape hatch: families/triples intentionally excluded from the
    # assertion, reason-carrying (decision 0007 / DMP.NIX.NATIVE-R11). Format per
    # entry: "family" or "family@os-cpu-libc" optionally "=reason".
    waivers ? [ ],
  }:
  let
    subdir = if installDir == "." then "" else "/${installDir}";
    engagement = if includeOptionalDependencies || forceFail then "fail" else "warn";
    waiveArg = builtins.concatStringsSep ";" waivers;
  in
  pkgs.runCommand "${name}-native-binding-closure-check"
    {
      nativeBuildInputs = [ pkgs.bun ];
      # Pure: the script only reads files from the FOD output. No network.
    }
    ''
      set -o pipefail
      tree=${depsBuild}
      lockfile="$tree${subdir}/pnpm-lock.yaml"
      workspace="$tree${subdir}/pnpm-workspace.yaml"

      export NBCC_ENGAGEMENT=${engagement}
      export NBCC_WAIVERS=${lib.escapeShellArg waiveArg}
      export NBCC_COMPLETENESS_MODE=${lib.escapeShellArg completenessMode}
      ${lib.optionalString (
        buildPlatformTriple != null
      ) "export NBCC_BUILD_PLATFORM_TRIPLE=${lib.escapeShellArg buildPlatformTriple}"}

      if [ ! -f "$lockfile" ] || [ ! -f "$workspace" ]; then
        msg="native-binding-closure-check: prepared tree is missing pnpm-lock.yaml/pnpm-workspace.yaml under ${installDir} (tree=$tree)"
        # Respect engagement: a warn-mode (non-opted-in) root must not hard-fail
        # on a missing lockfile — the check is advisory for it. An opted-in root
        # with a missing lockfile is a real integrity failure.
        if [ "${engagement}" = "warn" ]; then
          echo "$msg" >&2
          echo "native-binding-closure-check: engagement=warn — reporting only, not failing." | tee "$out"
          exit 0
        fi
        echo "$msg" >&2
        exit 1
      fi

      ${pkgs.bun}/bin/bun ${bundledCheck} "$tree${subdir}" "$lockfile" "$workspace" | tee "$out"
    ''
)
