# Semantic Graph Requirements

This subsystem defines how repository-owned intent binds to the portable public
kernel. It refines BUCK-R05 through BUCK-R07.

## Assumptions

- **BUCK.GRAPH-A01 Native metadata:** Ecosystem manifests and lockfiles remain
  authoritative for the facts their ecosystems own.
- **BUCK.GRAPH-A02 Local policy:** Operation selection and private topology are
  repository-owned facts.

## Acceptable Tradeoffs

- **BUCK.GRAPH-T01 Generated projection:** A repository may check in a generated
  Buck projection when freshness and byte determinism are enforced.

## Requirements

### Must separate kernel from repository authority

- **BUCK.GRAPH-R01 Portable schema:** The kernel graph schema must describe
  packages, operations, first-party edges, file roles, dependency handles,
  capabilities, and artifacts without physical tool paths or private topology.
- **BUCK.GRAPH-R02 Repository binding:** A repository adapter must supply all
  repository IDs, paths, labels, aliases, and policy explicitly.
- **BUCK.GRAPH-R03 Native fidelity:** An adapter must preserve resolver-selected
  dependency identity and ecosystem semantics rather than re-resolve or infer
  them independently.

### Must be deterministic and local

- **BUCK.GRAPH-R04 Stable identity:** Package, operation, and dependency-handle
  identities must be stable across worktree locations and adapter
  implementation languages.
- **BUCK.GRAPH-R05 Deterministic normalization:** Equal semantic input must
  produce byte-identical normalized graph data independent of input order.
- **BUCK.GRAPH-R06 Narrow locality:** A local semantic change must rewrite only
  the smallest owning projection and invalidate only operations whose declared
  graph input changed.
- **BUCK.GRAPH-R07 Freshness:** CI must fail when generated projection bytes do
  not equal a clean regeneration from their declared sources.
- **BUCK.GRAPH-R08 Complete ownership:** Every source consumed by an admitted
  operation must have one declared role and owner; overlaps and unowned sources
  must fail validation.
