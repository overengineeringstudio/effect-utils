# otelite is a sibling of the telemetry front door

## Status

accepted

## Context

The preferred shape was for otelite tests to reuse the production
`withTelemetry({ shape: "test" })` front door. Package direction blocks that:
`@overeng/utils-dev` is the test-harness leaf and is already depended on by
tests in `@overeng/utils` and `@overeng/otel-contract`. Importing either package
back into `utils-dev` would create a project-reference cycle.

## Decision

The otelite harness keeps its own `Otlp.layerJson` construction. It mirrors the
`test` shape's 100ms intervals and 2000ms shutdown timeout, but does not import
`withTelemetry`, `Shape`, or `ServiceIdentity`.

Production/test fidelity is proven one level up: `@overeng/utils` tests run the
real `withTelemetry` front door against the same otelite receiver that the
harness provides.

## Rejected

- Moving `Shape` into `@overeng/otel-contract`: rejected because export timings
  are not schema and `utils-dev` still cannot import that package.
- Moving the front door into a new shared package: rejected for this PR because
  it would introduce a new public package and dependency closure.
- Branding the harness `serviceName`: rejected as a breaking fixture API change
  and still blocked by package direction.

## Consequences

- `utils-dev` remains structurally decoupled from the production front door.
- A future dep-light `@overeng/otel-core` could collapse the sibling.
- The sibling root cause is package dependency direction, distinct from
  `@overeng/restate-effect`'s global-registry requirement.
