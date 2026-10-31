# Fractal Declaration DSL — Requirements

## Context

This package owns reusable TypeScript authoring and lowering for native Fractal declarations. Native Fractal owns grammar admission, scheduling, authorization and execution. Consuming graph repositories own domain policy and publication.

## Assumptions

- **STDSL-A01 Native authority:** A selected native grammar and runtime revision is the authority for declaration meaning and supported enforcement.
- **STDSL-A02 Effect foundation:** Consumers use the package's selected Effect version for shared rich values.

## Acceptable Tradeoffs

- **STDSL-T01 Clean cutover:** API and composition quality take precedence over avoiding caller migration. Replaced live authoring paths are removed rather than retained as compatibility aliases.

## Requirements

### Must preserve semantic truth

- **STDSL-R01 One meaning:** Every supported serializable declaration value has one canonical semantic representation. All admitted input spellings normalize to it; conflicting meanings are rejected.
- **STDSL-R02 Native fidelity:** Lowering preserves supported native meaning, including dependencies, loops, round and mission finalizers, input/product references and child missions. Unsupported runtime guarantees are not represented as enforced capabilities.
- **STDSL-R03 Time fidelity:** Elapsed durations, absolute instants and local-calendar recurrences are distinct. Equivalent admitted time inputs lower deterministically; unsupported precision, range or nonfinite values are rejected without silent rounding or truncation.

### Must support safe reuse

- **STDSL-R04 Composable authoring:** Reusable fragments compose without mutation and retain scoped reference ownership and dependency-state guarantees until assembly.
- **STDSL-R05 Definition references:** Source-owned cross-declaration references use imported typed definitions or typed identity values. Unknown targets, incorrect subject kinds and invalid revision bindings are rejected before publication; serialized names are boundary representations, not the primary TypeScript authoring contract.
- **STDSL-R06 Layer ownership:** Generic representation, validation and lowering remain independent of fleet/domain policy and publication. Authoring helpers do not redefine native scheduling, execution or authorization.

### Must preserve bounded authority

- **STDSL-R07 Exact-plan binding:** Plan-based review and execution bind to the same immutable pre-run plan. Reusable authority, where supplied by native Fractal, is bounded to the exact plan and its admitted action, scope, identity and consumption limits; declarations do not manufacture authority.
