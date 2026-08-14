# Buck2 Repository Build Ontology

## Language

**Public Kernel** is the portable schemas, rules, executors, evidence adapters,
and conformance fixtures shared by independently owned repositories.

**Repository Adapter** binds repository-owned semantic intent, dependency
selection, labels, aliases, and policy to the Public Kernel.

**Semantic Operation** is a bounded deterministic repository-local unit such as
a check, test suite, compilation, or package build.

**Configured Operation** is a Semantic Operation paired with its declared input
closure, target platform, execution platform, toolchain, and policy.

**Execution Platform** is where an action runs. **Target Platform** is what its
result is for.

**Authority Slice** is the smallest Configured Operation whose sole producer
can transfer independently to Buck.

**BuildProduct** is normalized Buck-produced payload bytes plus a portable
descriptor of entrypoints, target-platform/runtime constraints, and semantic
provenance. It contains no live-system state.

**Nix Import** is independent validation of a BuildProduct followed by creation
of a Nix store result without rebuilding repository sources.

**Native Evidence** is Buck's event log, build report, invocation identity, and
supported derived queries.

**Observer** is an optional execution-transparent adapter that converts Native
Evidence into telemetry under caller-provided trace context.

**Control Plane** is the consumer-owned task or CI system that owns trace roots,
evidence retention, admission policy, and live effects.

**Admission** is an evidence-backed grant for an exact operation, platform,
toolchain, policy, and trust tuple.

**No Verdict** means required evidence was not observed. It is neither success
nor failure, although consumer policy may fail closed.

## Structure

```text
Public Kernel + Repository Adapter
  -> Configured Operation
     -> Buck action and Native Evidence
        -> BuildProduct
           -> Nix Import

Control Plane
  -> trace context -> Observer -> Native Evidence telemetry
  -> evidence + independent checks -> Admission
  -> consumer-owned live effects
```

## Flagged Ambiguities

- Qualify platform as target or execution platform.
- Use operation for semantic intent and action for a Buck execution node.
- Use import only for the independent Nix boundary, not publication or
  activation.
- Name the exact admitted operation and tuple instead of saying supported.
- Distinguish Buck result, telemetry export result, evidence completeness,
  import result, and consumer live state.
