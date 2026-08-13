# Buck2 Repository Build Requirements

## Context

These requirements define a portable public kernel for Buck-owned
repository-local work and its independent Nix import boundary.

- [01-semantic-graph](./01-semantic-graph/requirements.md) owns portable graph
  contracts and repository adapters.
- [02-execution-platforms](./02-execution-platforms/requirements.md) owns
  declared tools and configured platforms.
- [03-target-execution](./03-target-execution/requirements.md) owns admitted
  action semantics.
- [04-artifact-system-bridge](./04-artifact-system-bridge/requirements.md) owns
  `BuildProduct` and independent Nix import.
- [05-evidence-verification](./05-evidence-verification/requirements.md) owns
  Buck evidence and OpenTelemetry correlation.
- [06-admission-reuse](./06-admission-reuse/requirements.md) owns authority
  transfer and conformance.

## Assumptions

- **BUCK-A01 Buck execution truth:** Buck's configured graph, action keys,
  event log, and build report are authoritative for Buck analysis and execution.
- **BUCK-A02 Nix authority:** Nix owns immutable tool and input recipes, Nix
  store import, and system realization.
- **BUCK-A03 Consumer authority:** The system consuming an imported product owns
  deployment, activation, rollback, health, secrets, and fleet policy.
- **BUCK-A04 Ecosystem authority:** Package manifests and lockfiles remain valid
  resolver inputs even after ecosystem build commands cease to be producers.

## Acceptable Tradeoffs

- **BUCK-T01 Conservative input closure:** An operation may initially declare a
  measured, visible superset of inputs when it never omits a result-affecting
  input and has an explicit refinement test.
- **BUCK-T02 Version-bound evidence adapter:** Rich Buck event-log decoding may
  be pinned to the admitted Buck version while stable build-report fields remain
  tolerant of additive change.
- **BUCK-T03 Transitional launcher:** The existing TypeScript launcher may remain
  while direct Buck plus native evidence is proved as the baseline. A Rust
  observer is eligible only for a measured gap that cannot be satisfied at the
  caller or native-evidence boundary. Neither wrapper is a build authority.

## Requirements

### Must preserve narrow authority

- **BUCK-R01 Sole producer:** Buck must be the only producer and gate for every
  admitted bounded deterministic repository-local operation. Other systems may
  declare inputs, invoke Buck, or consume results but must not independently
  perform equivalent work.
- **BUCK-R02 Bounded operation:** Admission must name an operation whose inputs,
  outputs, failure semantics, target platform, and execution platform are
  finite and deterministic. Live effects are outside Buck success.
- **BUCK-R03 Directional boundary:** Nix may provide inputs and verify, import,
  wrap, and compose a `BuildProduct`; Buck actions must not evaluate Nix or
  mutate live dependency or system state.
- **BUCK-R04 Consumer-owned effects:** Publication, deployment, activation,
  rollback, and health must not be required evidence for shared Buck build
  success.

### Must be portable and exact

- **BUCK-R05 Exact identity:** An action identity must contain every
  result-affecting source, dependency closure, configuration, toolchain,
  platform, and policy input, and exclude irrelevant host state.
- **BUCK-R06 Public kernel:** Shared schemas, rules, executors, evidence
  adapters, and conformance fixtures must contain no private repository or
  fleet facts.
- **BUCK-R07 Repository adapters:** Each repository must own its semantic graph,
  aliases, dependency projections, admission policy, and private integration.
- **BUCK-R08 Hermetic execution:** Admitted actions must use declared providers
  and inputs, avoid ambient `PATH` and package-manager state, and fail closed on
  undeclared access or incompatible identity.

### Must cross into Nix safely

- **BUCK-R09 Portable product:** A portable `BuildProduct` descriptor must bind
  normalized payload bytes, entrypoints, target-platform/runtime constraints,
  and semantic provenance.
- **BUCK-R10 Independent import:** Nix import must validate the descriptor and
  payload independently, reject unknown or extra contract fields, and never
  rebuild repository sources as fallback.

### Must be observable and verifiable

- **BUCK-R11 First-class telemetry:** The calling control plane must represent
  every authoritative invocation in its OpenTelemetry trace and correlate
  native Buck evidence, invocation identity, result, and `BuildProduct` identity.
- **BUCK-R12 Native evidence:** Telemetry and normalized summaries must retain
  links to Buck-native evidence and must not invent an invalidation cause that
  the graph and native evidence cannot establish.
- **BUCK-R13 Signal safety:** Metrics must use bounded attributes; invocation
  IDs, labels, digests, paths, and evidence locations belong on spans, events,
  or links after sanitization.
- **BUCK-R14 Failure independence:** Telemetry export failure must not change
  Buck's result. Missing evidence required by admission must yield no verdict
  and may fail the surrounding policy gate.
- **BUCK-R15 Causal proof:** Authority, invalidation, hermeticity, product
  import, and telemetry claims require failure-capable RED/GREEN evidence at
  the actual seam.

### Must contract and compound

- **BUCK-R16 Immediate contraction:** Once an operation passes its authority
  gate, the superseded producer and migration-only surface must be removed in
  the immediately dependent change.
- **BUCK-R17 Cross-repository conformance:** The public kernel must be tested by
  independently owned repository adapters without centralizing their graphs.
