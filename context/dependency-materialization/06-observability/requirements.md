# Dependency Materialization Observability Requirements

## Context

Observability is the producer-side contract for dependency materialization
facts. effect-utils builders and tasks emit facts; downstream tracing tools may
translate them into spans, events, dashboards, or review evidence.

## Assumptions

- **A01 Producer ownership:** effect-utils owns the stability of dependency
  materialization fact names and payload shapes it emits.
- **A02 Translation boundary:** External tools may translate build logs or task
  facts into OpenTelemetry, but they must not redefine the producer facts.

## Requirements

### Must explain materialization

- **DMP.OBS-R01 Phase facts:** Live install, staging, prepare, normalize, scan,
  restore, projection, repair, GC, and evidence phases must be attributable.
- **DMP.OBS-R02 Timing and size:** Facts must include enough timing and size
  data to explain regressions.
- **DMP.OBS-R03 Reuse outcome:** Cache hit, reuse, invalidation, bypass, and
  repair decisions must be explicit.
- **DMP.OBS-R04 Stable profile linkage:** Facts must include profile ids or
  safe profile references when available.

### Must be machine-readable

- **DMP.OBS-R05 JSON bridge:** Sandboxed build-log facts must use a stable JSON
  line protocol on registered surfaces.
- **DMP.OBS-R06 Safe paths:** Public facts must use repo-relative or redacted
  paths.
- **DMP.OBS-R07 Conformance fixtures:** Fact schemas used as bridge contracts
  need fixtures before consumers depend on them.
