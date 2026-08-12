# Buck2 Repository Build Requirements

## Context

These requirements define the cross-repository contract for Buck2-owned
repository-local work and its one-way integration with Nix-managed systems.
They build on the repository's dependency-materialization contract when a
target consumes package-manager dependency data, but do not make dependency
materialization the owner of the broader build system.

Subsystems refine this root contract in dependency order:

- [01-semantic-graph](./01-semantic-graph/requirements.md)
- [02-execution-platforms](./02-execution-platforms/requirements.md)
- [03-target-execution](./03-target-execution/requirements.md)
- [04-artifact-system-bridge](./04-artifact-system-bridge/requirements.md)
- [05-evidence-verification](./05-evidence-verification/requirements.md)
- [06-admission-reuse](./06-admission-reuse/requirements.md)

## Assumptions

- **BUCK-A01 Nix system authority:** Nix owns tool recipes, source pins,
  patches, system dependency composition, and managed-system realization.
- **BUCK-A02 Managed activation:** Home Manager, NixOS, and nix-darwin own
  generation activation and rollback.
- **BUCK-A03 Ecosystem metadata:** Package manifests and lockfiles remain valid
  ecosystem interfaces and resolver inputs even when their ecosystem build
  commands are not terminal execution authorities.
- **BUCK-A04 Native Buck semantics:** Buck's declared graph, configured
  platforms, action keys, native logs, and build reports are the authority for
  its analysis and execution behavior.
- **BUCK-A05 Repository ownership:** Each repository owns its first-party graph
  and private integration instances while conforming to shared public schemas.

## Acceptable Tradeoffs

- **BUCK-T01 Conservative precision:** A newly modeled target may temporarily
  declare a conservative superset of result-affecting inputs when the excess is
  visible, measured, and cannot cause an undeclared dependency.
- **BUCK-T02 Explicit bootstrap:** The current immutable Nix realization may be
  local-only when its identity and restrictions are explicit. Future portable
  or remote tool transport requires a current consumer, comparative evidence,
  and its own design decision.
- **BUCK-T03 Language refinement:** Language adapters may use different rich
  payloads rather than forcing all ecosystems into one optional-field schema.

## Requirements

### Must have one authority per concern

- **BUCK-R01 Exclusive repository-local authority:** For an admitted semantic
  slice and platform, Buck must be the sole terminal authority for
  repository-local compilation, type checking, testing, lint and format
  verification, action-required code generation, packaging, and deployable
  artifact production. Other tools may supply metadata or regeneration inputs
  but must not independently gate or publish equivalent work.
- **BUCK-R02 Directional system boundary:** Nix and development-environment
  tooling must delegate admitted repository-local work to Buck. Nix may verify,
  import, relocate, wrap, compose, activate, and roll back Buck products, but
  must not rebuild their repository sources.
- **BUCK-R03 Authority-visible failure:** Unsupported platforms, missing
  capabilities, and unavailable verified artifacts must fail explicitly. No
  boundary may silently select a legacy source-build authority.

### Must identify only result-affecting work

- **BUCK-R04 Exact result identity:** Each action identity must contain every
  result-affecting source, dependency closure, configuration, toolchain,
  target platform, execution platform, and policy input at the narrowest
  correct semantic boundary, and exclude irrelevant state.
- **BUCK-R05 Stable semantic contracts:** Logical package and target IDs,
  operation contracts, providers, and artifact schemas must not encode their
  generator or helper implementation language, host-private path, or mutable
  physical placement.
- **BUCK-R06 Deterministic projection and output:** Equal semantic input must
  produce byte-identical generated projections and, where the operation
  contract permits, byte-identical outputs independent of worktree location,
  input enumeration order, and irrelevant metadata.

### Must be hermetic and portable where admitted

- **BUCK-R07 Declared realization:** Authoritative actions must use declared
  inputs and executable providers, run without ambient package-manager state or
  PATH discovery, and fail closed on undeclared access or identity mismatch.
- **BUCK-R08 Per-platform admission:** Authority and reuse must be admitted for
  an explicit target-platform, execution-platform, toolchain, and policy tuple.
  Evidence for one tuple must not imply support for another.
- **BUCK-R09 Trust isolation:** Public and private repositories or incompatible
  principals must not share writable cache authority. Reuse across trust
  boundaries requires verified immutable results and explicit provenance
  policy.

### Must be observable and independently verified

- **BUCK-R10 Native evidence:** Every authoritative path must preserve Buck's
  native execution evidence and expose a safe correlation from user invocation
  through actions, cache outcomes, materialization, artifacts, system import,
  activation, and live observation where applicable.
- **BUCK-R11 Causal verification:** Authority, invalidation, equivalence,
  portability, and rollback claims must be proven by independent
  RED-before/GREEN-after controls at their actual seams. Missing prerequisites
  or incomplete observation produce no verdict.
- **BUCK-R12 Explainable efficiency:** Correctness is a hard constraint. Among
  correct designs, the admitted design must be non-dominated across invalidation
  breadth, wall time, CPU, memory, bytes, cache growth, and operational
  complexity among evaluated candidates.

### Must contract and compound

- **BUCK-R13 Immediate authority contraction:** Once a semantic slice passes
  its complete deterministic authority gate and the new path is independently
  verified, the superseded producer and migration-only compatibility surface
  must be removed in the immediately dependent change rather than retained for
  an arbitrary calendar soak.
- **BUCK-R14 Data-driven repetition:** Repeated graph, action, verification,
  benchmark, and lifecycle behavior must be represented as typed data over
  shared implementations. Handwritten exceptions require a distinct semantic
  invariant.
- **BUCK-R15 Cross-repository conformance:** Shared schemas, rules, tool
  bindings, artifact contracts, and evidence contracts must be versioned and
  testable in independently owned repositories without embedding private
  topology or centralizing their first-party graphs.
