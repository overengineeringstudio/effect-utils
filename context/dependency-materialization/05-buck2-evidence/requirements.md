# Buck2 Dependency-Closure Requirements

## Context

This subsystem refines the dependency-materialization contract for dependency
facts consumed by Buck targets. The canonical repository-build architecture now
lives at [`context/buck2`](../../buck2/).

This node owns only the join between Dependency Materialization identities and
Buck's semantic graph. It does not own general Buck authority, language
actions, toolchains, artifacts, Nix import, observability, or admission.

**Refines:** DMP-R09 through DMP-R11, DMP-R16, and DMP-R18 through DMP-R24.

## Assumptions

- **A01 Materialization identity:** Package bytes, resolved package contexts,
  and task closures use the identities defined by the parent dependency-
  materialization requirements.
- **A02 Semantic graph:** Buck target and operation identity follow
  [`BUCK.GRAPH`](../../buck2/01-semantic-graph/requirements.md).
- **A03 No live repair:** An authoritative Buck action consumes immutable
  dependency projections and never owns live package-manager repair or GC.

## Acceptable Tradeoffs

- **T01 Conservative closure:** A target may temporarily consume a declared
  conservative closure when its excess is visible and measured, but the schema
  must retain the task-role and platform dimensions required to refine it.

## Requirements

### Must bridge identities without merging authorities

- **DMP.BUCK-R01 Declared dependency inputs:** A Buck target must consume
  declared closure records and immutable dependency artifacts, never ambient
  package-manager state.
- **DMP.BUCK-R02 Layered dependency identity:** Dependency identity must
  distinguish normalized package payload, complete resolver context, and the
  target-local observable closure.
- **DMP.BUCK-R03 Resolver fidelity:** The projection must preserve the
  ecosystem resolver's selected versions, peer or feature contexts, patches,
  target conditions, and integrity evidence without independently reselecting
  them.
- **DMP.BUCK-R04 First-party edge separation:** Internal workspace dependencies
  remain semantic Buck target edges when their first-party identity or context
  can affect the result; they must not be hidden inside one external tree.

### Must preserve exact invalidation

- **DMP.BUCK-R05 Closure-scoped input:** A target action receives only the
  external dependency records and artifacts observable for its importer,
  semantic operation, capabilities, target platform, and execution platform.
- **DMP.BUCK-R06 Unrelated resolver stability:** A lockfile or manifest change
  that leaves a target's selected observable closure byte-identical must not
  change its closure identity or execute its actions.
- **DMP.BUCK-R07 Sharded projection:** Parsing or generating a repository-wide
  resolver graph must not make the complete lockfile or a whole-repository
  manifest an input to every target action.

### Must be verifiable and safe

- **DMP.BUCK-R08 Complete derivation evidence:** A closure record must identify
  its resolver inputs, projection/compiler ABI, task role, platforms,
  capabilities, selected records, and immutable artifact digests without
  credentials or host-private paths.
- **DMP.BUCK-R09 Fail-closed projection:** Missing edges, digest mismatch,
  ambiguous contexts, unsafe paths, unsupported sources, or undeclared ambient
  access must fail before consumer execution.
- **DMP.BUCK-R10 Causal equivalence proof:** Authority requires resolver-
  reference equivalence plus relevant, irrelevant, restoration, and missing-
  edge RED/GREEN controls through the real consuming Buck action.
