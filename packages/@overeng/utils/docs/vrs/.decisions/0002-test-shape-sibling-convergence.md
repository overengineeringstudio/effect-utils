# otelite test path is a sibling of the front door, not a shared import

## Status

accepted

## Context

The goal was test↔prod telemetry fidelity: have the otelite test path consume the
SAME front door as production — `withTelemetry({ shape: 'test', endpoint })`
posting to the local otelite OTLP receiver the harness boots — instead of a
bespoke parallel exporter. The `test` shape already exists; mechanically,
`withTelemetry` POSTing all three signals into an otelite capture is already
proven (`@overeng/utils/src/node/otel-telemetry.test.ts`, the `cli` shape).

The question was feasibility of the shared import, decided exactly like the
`@overeng/restate-effect` convergence spike: FULL convergence (harness builds its
layer through `withTelemetry`, bespoke construction deleted) only if there is no
structural blocker; otherwise the MAXIMAL clean convergence plus a documented
sibling.

## Decision

**SIBLING (partial convergence), forced by package dependency direction.**

`@overeng/utils-dev` is the universal test-harness leaf: every first-party
package's _tests_ depend on it. Concretely, both `@overeng/utils` and
`@overeng/otel-contract` already declare `@overeng/utils-dev` as a test
devDependency and carry a `tsc --build` project reference to it (their tests use
the otelite harness). So the reverse edge — `utils-dev` importing `withTelemetry`
from `@overeng/utils`, OR `ServiceIdentity` from `@overeng/otel-contract` — would
close a project-reference CYCLE. No first-party code can flow INTO `utils-dev`.

Therefore:

- The harness KEEPS its hand-built `Otlp.layerJson` exporter
  (`makeInProcessAllSignalsLayer` / `makeInProcessLayer` /
  `makeOtelVitestLayer`). Nothing importable can replace it; nothing is deleted.
- The one available code convergence is applied: the all-signals harness layer
  now MIRRORS the `test`-shape flush semantics — a 2000 ms `shutdownTimeout`
  matching `shapeDefaults('test')` — where it previously omitted it and relied on
  scope-close alone. The intervals already matched (100 ms). A cross-reference
  comment ties it to `Shape` / `shapeDefaults('test')`.
- Test↔prod fidelity is proven NOT by a shared import but one level up:
  `@overeng/utils/src/node/otel-telemetry.test.ts` exercises the real
  `withTelemetry({ shape: 'cli' })` front door against the SAME otelite receiver
  the harness boots, asserting traces + metrics + logs with the typed identity on
  each. That test lives in `@overeng/utils` precisely because only `utils` can
  import BOTH the front door AND the otelite harness.

### Rejected alternatives

- **Move `Shape` / `shapeDefaults` into `@overeng/otel-contract`** (so both
  import it): rejected. `otel-contract` is a SCHEMA package; export-interval /
  shutdown mechanics are not schema, and it is moot anyway — `utils-dev` cannot
  import `otel-contract` either (same cycle).
- **Relocate `makeOtelCliLayer` / `Otlp.layerJson` to a shared package**:
  rejected. It drags `@effect/opentelemetry` + `@effect/platform` into the shared
  closure — the same "do not bloat every consumer" objection as decision 0001,
  and a public-API contortion the task forbids.
- **Swap the harness `serviceName: string` for `ServiceIdentity`**: rejected. It
  is a breaking change to a public test fixture (consumers pass raw strings), the
  brand is unimportable (cycle), and the full struct requires
  `namespace` + `version` — the same break `@overeng/restate-effect` declined.

## Why

This sibling has a DIFFERENT root cause from the `@overeng/restate-effect` OTEL
sibling (decision 0007): restate's is the global `@opentelemetry/api` registry
(provider registration / `getActiveSpan`); this one is package dependency
direction (the test-harness leaf). Same outcome label, different reason — kept
distinct so a future reader does not blur them or re-attempt FULL convergence.

## Consequences

- The harness layer construction stays in `@overeng/utils-dev`, structurally
  decoupled from the front door, with its flush window now matching the `test`
  shape.
- A future `@overeng/otel-core` (dep-light, holding `Shape` / `shapeDefaults` /
  the resource mapping, importable by both the harness and the front door) could
  collapse this sibling — but it is a new package not yet asked for (spec DQ01),
  so the documented mirror is the steady state for now.
- All otelite-consuming suites stay green: the utils-dev `otelite` + `node-vitest`
  suites, megarepo `store-gc-otel`, and otel-contract `raw-otel-boundary`.
