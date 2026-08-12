# Admission and Reuse Requirements

## Context

Admission changes which implementation is authoritative for one bounded
semantic result. It evaluates immutable evidence produced by upstream systems;
it is not a parallel graph, receipt universe, migration database, or runtime
router. Reuse is claimed only after independent consumption of public
contracts.

## Assumptions

- **BUCK.ADM-A01 Upstream authority:** Candidate identity, graphs, platforms,
  artifacts, and evidence are owned by their preceding subsystems.
- **BUCK.ADM-A02 Native records:** Admission references native records and the
  evidence envelope; it does not replace them.

## Acceptable Tradeoffs

- **BUCK.ADM-T01 Slice-local authority:** Disjoint semantic slices may be
  admitted independently.
- **BUCK.ADM-T02 Evidence over time:** Policy may require independent repeated
  observations, but never an elapsed-time soak without relevant evidence.

## Requirements

### Must decide a precise capability

- **BUCK.ADM-R01 Stable subject:** A decision must identify the operation,
  target set, target platform, execution platform, dependency closure,
  toolchain, artifact contract, policy version, and requested capability.
- **BUCK.ADM-R02 Deterministic predicate:** Equal subject, policy, and immutable
  evidence references must produce the same `admitted`, `rejected`, or
  `no-verdict` result and enumerate every gate outcome.
- **BUCK.ADM-R03 Exact proof binding:** Evidence from a different revision,
  contract, action identity, platform, policy, or proof kind must not satisfy a
  gate. Evaluated or emulated proof must not be reported as physical proof.
- **BUCK.ADM-R04 Upstream evidence vocabulary:** Gate outcomes must reference
  `05-evidence-verification` envelopes. Admission must not define another
  receipt schema or reinterpret missing evidence as success.

### Must change authority atomically

- **BUCK.ADM-R05 One active owner:** An admitted result has exactly one
  authoritative producer and route.
- **BUCK.ADM-R06 Atomic retirement:** The authority switch, command and CI
  routing, and deletion of the superseded producer and fallback for that exact
  slice occur in one coherent change after candidate proof. A non-authoritative
  candidate may coexist before that change.
- **BUCK.ADM-R07 Bounded remainder:** Any legacy behavior left for unadmitted
  slices must have a machine-checkable, non-overlapping semantic domain.
  Current rollout state and deletion checklists belong in the roadmap and
  GitHub issues, not a normative survivor database.
- **BUCK.ADM-R08 Coherent rollback:** Rollback restores a previously identified
  whole authority state; it must not activate an implicit runtime selector or
  two live producers.

### Must separate trust capabilities

- **BUCK.ADM-R09 Independent capabilities:** Local execution, remote-cache read,
  remote-cache write, remote execution, verified import, and system activation
  require distinct verdicts.
- **BUCK.ADM-R10 Trust isolation:** Public and private repositories must not
  share writable cache authority or credentials. Cross-boundary reuse requires
  explicit artifact classification, provenance validation, path-independent
  replay, and poisoning and credential-leak controls.

### Must prove reusable contracts

- **BUCK.ADM-R11 Public contract map:** Reuse must state exactly which schemas,
  conformance fixtures, and adapters are shared and which graph declarations,
  aliases, policies, and private system values remain consumer-owned.
- **BUCK.ADM-R12 Independent consumer:** General reuse must not be claimed until
  a second independently owned repository consumes versioned public contracts
  without private imports, copied generated output, or framework patches.
- **BUCK.ADM-R13 Compatibility and version skew:** Contracts must define
  supported version negotiation, fail-closed incompatibility, corpus version,
  logical label namespace and relocation behavior, and a no-reverse-dependency
  rule preventing shared infrastructure from depending on consumer repos.
- **BUCK.ADM-R14 Complexity contraction:** Admission must prove that the
  admitted domain has one producer and one primary developer interface, adds no
  permanent duplicate abstraction, and removes migration-only mechanisms.
