# Buck2 Repository Build Vision

## The Problem

1. **Repository work is too coarse:** Compilation, checking, testing, and
   packaging often invalidate or execute more work than their semantic inputs
   require.
2. **Build authority overlaps:** Nix, package managers, ecosystem tools, and
   wrappers can independently produce or gate the same repository-local result.
3. **Build behavior is opaque:** A developer or CI system cannot consistently
   connect an invocation to the actions, reuse decisions, outputs, and evidence
   that explain it.
4. **Fast artifacts lack a narrow system boundary:** Repository builds need to
   enter Nix without making Buck a system manager or making Nix rebuild the
   repository sources.
5. **Repository-specific solutions do not compound:** Private topology and
   local task policy prevent otherwise reusable build mechanisms from serving
   independently owned repositories.

## The Vision

- Bounded deterministic repository-local operations are declared once and
  produced by Buck with identities that follow their result-affecting inputs.
- A portable public kernel supplies schemas, rules, executors, native-evidence
  contracts, and conformance tests; each repository owns its semantic graph and
  policy adapters. An execution wrapper is added only when direct Buck plus its
  native evidence cannot satisfy a measured observability requirement.
- Nix supplies immutable inputs and independently verifies and imports portable
  Buck products into the Nix store.
- Consumers own every live effect after import, including deployment,
  activation, rollback, and health policy.
- OpenTelemetry connects repository work to the surrounding task or CI trace
  while Buck-native evidence remains the execution truth.

## What This Is Not

- It is not a replacement for Nix input, store, or system-realization authority.
- It is not a deployment, activation, rollback, or runtime-health framework.
- It is not a universal package-manager or dependency resolver.
- It is not a permanent launcher or a second task graph around Buck.
- It is not a central graph containing consumer-private topology or policy.

## Success Criteria

1. An irrelevant mutation executes no action for an unaffected admitted target;
   a relevant mutation executes the affected closure.
2. Each admitted operation has Buck as its only producer and gate in normal
   development and CI paths.
3. A clean compatible host can reproduce an admitted result from only declared
   sources, dependencies, tools, platforms, and policy.
4. An independent Nix evaluation rejects a malformed or mismatched product and
   imports a valid product without rebuilding repository sources.
5. A task trace identifies the Buck invocation, outcome, evidence, product, and
   import result without placing high-cardinality identities on metrics.
6. The public kernel passes the same conformance fixtures in at least two
   independently owned repositories whose graphs and policies remain local.
