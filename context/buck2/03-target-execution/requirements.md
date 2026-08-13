# Target Execution Requirements

## Context

Target execution turns the repository's generated first-party target intent into
declared Buck actions. It builds on the repository-wide Buck requirements and
the sibling toolchain and platform contract. Language-specific requirements
refine this contract under [`01-typescript/`](./01-typescript/requirements.md)
and [`02-rust/`](./02-rust/requirements.md).

## Assumptions

- **BUCK.EXEC-A01 Generated graph:** Package-local target intent is a
  deterministic, freshness-gated input to target execution.
- **BUCK.EXEC-A02 Toolchain boundary:** Tool recipes, executable identity,
  runtime closure, target platform, and execution platform are supplied by the
  sibling toolchain and platform subsystem. Target execution consumes those
  providers and does not redefine their realization mechanics.
- **BUCK.EXEC-A03 Artifact boundary:** Deployment packaging and system
  convergence consume declared target outputs through independently verified
  artifact interfaces.

## Acceptable Tradeoffs

- **BUCK.EXEC-T01 Language adapters:** Languages may expose different typed
  payloads and quality surfaces while consuming the one semantic graph.
  Uniformity is not required where it would erase result-affecting language
  semantics.
- **BUCK.EXEC-T02 Multiple actions:** One user-facing target may expand to
  multiple actions when compilation, validation, testing, normalization, or
  packaging have different inputs and invalidation boundaries.

## Requirements

### Must preserve semantic intent

- **BUCK.EXEC-R01 Typed target consumption:** Every first-party action must
  consume the versioned semantic representation owned by the semantic graph and
  reject invalid language payloads before execution.
- **BUCK.EXEC-R02 Shared graph identity:** Target name, package ownership,
  first-party edges, visibility, declared inputs, target platform, and execution
  constraints must reference the semantic graph directly. Target execution
  must not define or normalize a second common envelope.
- **BUCK.EXEC-R03 Language fidelity:** A language adapter must preserve every
  result-affecting language semantic needed by its compiler, test harness,
  quality tools, runtime resources, and generated outputs.

### Must own declared actions

- **BUCK.EXEC-R04 Declared execution:** Authoritative actions must consume only
  declared sources, configuration, dependencies, tools, resources, environment,
  platform identity, and upstream action outputs.
- **BUCK.EXEC-R05 Action separation:** Compilation, linting, format checking,
  documentation checking, testing, normalization, and packaging must remain
  separately addressable when they have different inputs, failure semantics, or
  reuse boundaries.
- **BUCK.EXEC-R06 No ambient resolution:** Authoritative actions must not
  discover tools or dependencies through ambient `PATH`, user state, mutable
  package stores, undeclared workspace trees, or live package-manager repair.
- **BUCK.EXEC-R07 Stable providers:** Consumers must depend on semantic
  providers rather than implementation-specific paths or incidental default
  outputs. Provider contracts must keep compilation outputs, runnable outputs,
  quality evidence, and deployable artifacts distinguishable.

### Must expose complete quality surfaces

- **BUCK.EXEC-R08 Quality completeness:** Each admitted language must expose
  authoritative build, test, lint, format-check, and documentation-test
  behavior, or an explicit verified result that a surface does not apply.
- **BUCK.EXEC-R09 Failure fidelity:** A diagnostic-producing action must fail
  the authoritative gate when repository policy classifies any reported
  diagnostic as failing. Producing diagnostics successfully is not itself a
  passing quality result.
- **BUCK.EXEC-R10 Inventory fidelity:** Test and documentation-test actions must
  expose an exact executable and case inventory. An empty or partial harness
  must not satisfy parity accidentally.

### Must consume canonical tooling

- **BUCK.EXEC-R11 Canonical tool inputs:** Every executable used by an
  authoritative action must arrive through a declared sibling toolchain
  provider carrying content, platform, runtime-closure, and protocol identity.
- **BUCK.EXEC-R12 Stage0 consumer:** When a support tool participates in
  realizing its own build toolchain, target execution must consume an immutable,
  digest-verified stage0 provider. It must not create a self-hosting action
  cycle, perform an ambient fallback, or own stage0 platform realization.
- **BUCK.EXEC-R13 Support-tool equivalence:** A stage0 support tool and a
  graph-built successor must share a versioned action protocol and produce
  behaviorally equivalent declared outputs before the successor can replace the
  stage0 input.

### Must be observable and fail closed

- **BUCK.EXEC-R14 Platform admission:** Unsupported target or execution
  platforms must fail during analysis or provider validation rather than run a
  host-compatible approximation.
- **BUCK.EXEC-R15 Exact invalidation evidence:** Admission must include
  RED/GREEN controls proving that each relevant input change reruns the minimal
  affected actions and each irrelevant change preserves their action identity.
- **BUCK.EXEC-R16 Execution evidence:** Action identity, declared tool and
  dependency identity, execution or reuse outcome, produced artifact identity,
  and retained native Buck evidence must be joinable without treating a cache
  outcome as an inferred invalidation reason.
- **BUCK.EXEC-R17 Verified artifact handoff:** A deployable target must hand a
  normalized artifact and structured provenance to the artifact verifier. It
  must not silently delegate compilation or bundling to the convergence layer.
