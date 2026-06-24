# Dependency Materialization Intuition

_For: maintainers of effect-utils dependency tooling · Assumes: pnpm, Nix FODs,
devenv tasks, and Buck2 basics · Covers: the mental model behind the DMP VRS_

Dependency materialization is the contract for turning a workspace dependency
graph into something tools can execute against. The hard part is that the same
graph is realized through several mechanisms: a live `node_modules` tree during
development, a prepared dependency artifact in Nix, a job-local CI install, and
eventually Buck2 evidence or actions.

The VRS is shaped around one rule: dependency identity is shared, but mutation
authority is not.

```text
                 dependency materialization profile
                                |
        +-----------------------+-----------------------+
        |                       |                       |
  live pnpm state        Nix prepared data        Buck2 evidence
  mutable/repairable     immutable/restored       declared graph fact
        |                       |                       |
        +----------- projection + observability --------+
```

pnpm may resolve and link package data, but effect-utils-managed paths do not
trust package lifecycle scripts. Anything executable or native has a separate
owner:

- `.bin` entries are projection state derived from manifests.
- Native package outputs come from Nix or a pure package artifact
  classification.
- Shared package content is repaired or garbage-collected only by an authority
  that can see every active root.
- Buck2 consumes profile evidence before it owns live dependency mutation.

This is why the VRS is hierarchical. The root DMP contract defines shared
identity and authority vocabulary. Child systems define each realization:
live pnpm, projections, Nix prepared deps, store authority, Buck2 evidence, and
producer observability. Verification composes those children: fixture checks
prove contract regressions, synthetic proofs preserve known failure modes, and
real-workload benchmarks decide when a sharing or default change is actually
better.
