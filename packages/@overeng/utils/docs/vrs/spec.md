# Spec: telemetry foundation

The concrete surface of the telemetry foundation. Builds on
[requirements.md](./requirements.md); the hard-to-reverse rationale is in
[.decisions/](./.decisions/), cited by relative path. This is the as-built
design.

## Status

Implemented. The typed front door (`withTelemetry` / `TelemetryLayer`), the
`Shape` matrix, the `OtelConfig` gate, the endpoint resolver, the periodic
sampler primitives, and the schema-first contract in `@overeng/otel-contract`
are all built and exercised end-to-end against a real otelite receiver
(`@overeng/utils/src/node/otel-telemetry.test.ts`,
`@overeng/otel-contract/src/raw-otel-boundary.unit.test.ts`).

## Scope

Defines: the typed `withTelemetry` front door over `makeOtelCliLayer`; the
`Shape` → defaults matrix; the `ServiceIdentity` → resource attribute mapping;
the `OtelConfig` gate and `otelEndpointFromConfig` edge resolver; the
`telemetryEnabled` / `whenTelemetryEnabled` gates; the `sampleResource` /
`sampleGauge` periodic samplers; and the boundary to the schema-first contract
in `@overeng/otel-contract`.

Does not define: the OTLP wire format or `Otlp.layerJson` internals (owned by
`@effect/opentelemetry`); the shutdown-flush contract and exit-code handling
(owned by `@overeng/tui-react`, decision `0001-shutdown-flush-contract.md`); the
`@overeng/restate-effect` global-provider OTEL bridge (its decision 0007); the
otelite capture tooling (owned by `@overeng/utils-dev/otelite` and the `otelite`
Rust binary).

## Architecture

```
 composition root (a binary's bin/*.ts)
   │  identity = Schema.decode(ServiceIdentity)({ name, namespace, version })
   │  endpoint = yield* otelEndpointFromConfig()           // Option<string>, edge
   ▼
 withTelemetry({ identity, shape, endpoint })  ── thin typed front door
   │   shapeDefaults(shape) → { exportInterval, metricsExportInterval, shutdownTimeout }
   ▼
 makeOtelCliLayer({ identity, endpoint, ...knobs })
   │  resource = { serviceName: name, serviceVersion: version,
   │               attributes: { 'service.namespace': namespace } }
   ├── endpoint = None  ─────────────►  Layer.succeed(OtelConfig, { endpoint: None })
   │                                    (zero exporter overhead)
   └── endpoint = Some(url) ─────────►  Layer.mergeAll(
         OtelConfig{ endpoint: Some(url) },                // the resolved gate
         parentSpan(TRACEPARENT?)  provideMerge
           Otlp.layerJson({ baseUrl, resource, ...intervals, shutdownTimeout })
             provide FetchHttpClient.layer )               // OTLP/HTTP, pure-Effect

 product code instruments through @overeng/otel-contract (schema-first):
   OtelOperation.define(...).with({...})  /  OtelMetric.effect.counter(...).increment(...)
   gated, when telemetry is off, via whenTelemetryEnabled / sampleResource(OtelConfig)
```

The shared path NEVER touches the `@opentelemetry/api` global registry — no
`provider.register()`, no global context manager. Two consumers that genuinely
need a global SDK provider keep deliberate SIBLINGS, for two DIFFERENT structural
reasons (see [Sibling boundaries](#sibling-boundaries)).

## Front door

`withTelemetry(options): Layer<OtelConfig>` (alias `TelemetryLayer`) is a thin
typed wrapper over `makeOtelCliLayer`, NOT a reimplementation. It folds the raw
knobs behind `Shape` and validates the identity.

```ts
withTelemetry({
  identity,                      // ServiceIdentity (branded, decoded at the edge)
  shape,                         // 'cli' | 'service' | 'test'
  endpoint,                      // Option<string> — Some exports, None disables
  overrides?,                    // rare: { exportInterval?, metricsExportInterval?, shutdownTimeout? }
})
```

`makeOtelCliLayer({ identity, endpoint?, endpointEnvVar?, exportInterval?,
metricsExportInterval?, shutdownTimeout? })` is the underlying constructor.
`endpoint` (when given) is authoritative and pure — the layer reads no env;
`endpointEnvVar` (default `OTEL_EXPORTER_OTLP_ENDPOINT`) is the backward-compat
fallback only when `endpoint` is omitted. It is built with `Layer.suspend` (not
`Layer.unwrapEffect`) so the exporter's scope-close flush finalizer is reliably
tied to the layer scope (R09).

## Shape → defaults matrix

`shapeDefaults(shape)` (R03, R04). The `cli` row omits `shutdownTimeout` so
`makeOtelCliLayer`'s TTY-aware default applies (the safety ceiling, R10).

| Shape     | exportInterval | metricsExportInterval | shutdownTimeout                                          |
| --------- | -------------- | --------------------- | -------------------------------------------------------- |
| `cli`     | 250 ms         | 1000 ms               | TTY-aware default: 10 000 ms (TTY) / 30 000 ms (non-TTY) |
| `service` | 5000 ms        | 10 000 ms             | 5000 ms                                                  |
| `test`    | 100 ms         | 100 ms                | 2000 ms                                                  |

- `cli`: short-lived. Short intervals so a sub-second run ticks once; the
  scope-close finalizer force-flushes the final batch of every signal before
  exit.
- `service`: long-lived. Relaxed periodic export; the shutdown ceiling only
  bounds a graceful stop against a black-holed collector.
- `test`: deterministic short intervals against an explicit ephemeral endpoint,
  tight shutdown window for fast hermetic assertions.

## Identity → resource mapping (R02)

`ServiceIdentity` (from `@overeng/otel-contract`) maps onto the OTLP resource for
every signal:

| ServiceIdentity field | OTLP resource attribute |
| --------------------- | ----------------------- |
| `name`                | `service.name`          |
| `namespace`           | `service.namespace`     |
| `version`             | `service.version`       |

`OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` are still merged by
`@effect/opentelemetry`: the explicit identity wins on collision, env-only attrs
are preserved (runtime provenance intact).

### `<project>-<role>` name + fleet-binding seam (R01)

The conventional `service.name` is `` `${project}-${role}` ``, built and validated
in `@overeng/otel-contract`:

```ts
ServiceNameFromParts: Schema<OtelServiceName, { project; role }>  // decode at the edge
serviceIdentityFromBinding(b: FleetServiceBinding): Effect<ServiceIdentity, ParseError>
```

`ServiceNameFromParts` validates `project`/`role` as plain `NonEmptyTrimmedString`
THEN decodes the joined string through `OtelServiceName`. Both layers are
load-bearing: `OtelServiceName`'s pattern admits a trailing hyphen, so an empty
`role` would compose to `"<project>-"` and pass a single decode — the part-level
non-empty check closes that trap.

`FleetServiceBinding` is the PUBLIC type-seam: a plain-`string`
`{ project, role, namespace, version }` interface describing the SHAPE a private
fleet config supplies. This repo owns the TYPE + constructor; a private repo
supplies the VALUES. Fields are unbranded on purpose (decode happens at the edge,
in `serviceIdentityFromBinding`), and the public repo holds zero fleet values. See
[.decisions/0003-fleet-service-binding-seam.md](./.decisions/0003-fleet-service-binding-seam.md).

## The `OtelConfig` gate (R11, R12)

```ts
class OtelConfig: { endpoint: Option<string> }            // published by every layer build
otelEndpointFromConfig(envVar?): Effect<Option<string>>   // edge resolver (Config.option → orDie)
telemetryEnabled: Effect<boolean>                         // Some(endpoint) ⇒ true; absent tag ⇒ false
whenTelemetryEnabled(effect): Effect<void>                // run only when enabled, else no-op
```

`OtelConfig` is published whether or not an endpoint is configured (with
`endpoint = None` when off), so command code gates optional telemetry work on the
SAME signal the exporter was built from. `telemetryEnabled` reads it via
`Effect.serviceOption`, so the tag never enters a consumer's `R` and command code
stays runnable without the layer (absent ≡ disabled).

## Periodic samplers (R12, R13)

```ts
sampleResource({ sample: Effect<void>, interval? }): Effect<void, never, OtelConfig | Scope>
sampleGauge({ gauge, read: () => number, labels?, interval? }): Effect<void, never, OtelConfig | Scope>
```

Both fork a fiber for the lifetime of the enclosing scope, gated on
`telemetryEnabled` (so off ⇒ never forked ⇒ `read` never runs — a true no-op,
R12), and pinned to a real `Clock` (`Effect.withClock(Clock.make())` placed
BEFORE `forkScoped`) so the sampler ticks on wall time, not the ambient decision
clock (R13). `sampleGauge` is the labeled-`set` convenience over `sampleResource`.

## Schema-first contract boundary (`@overeng/otel-contract`, R06–R08)

Product code instruments through the schema-backed contracts, not raw OTEL:

- `OtelOperation.define({ name, schema, label })` → `.with` / `.withRoot` /
  `.withStream` / `.annotate`. Derives the `span.label` Grafana convention
  (R07); an empty label fails to encode.
- `OtelSpan.define` requires an `OtelAttr.spanLabel()` attribute.
- `OtelMetric.counter` / `.histogram` / `.gauge` + `OtelMetric.effect.*` bridge
  to Effect `Metric`. Labels must declare/infer low/bounded cardinality (R07).
- Branded names: `OtelServiceName` / `OtelServiceNamespace` / `OtelServiceVersion`
  / `OtelSpanName` / `OtelMetricName` / `OtelAttributeKey`, composed by
  `ServiceIdentity`.

The `no-raw-otel-primitives` lint (zero allowlist) makes a raw primitive in
product code a failing check; `raw-otel-boundary.unit.test.ts` proves real
production instrumentation routes through the helpers (R08).

## Sibling boundaries

Two consumers keep a deliberate SIBLING of this foundation. Same outcome
(a separate layer), DIFFERENT root cause — recorded distinctly so a future reader
does not collapse them or re-attempt convergence:

1. **`@overeng/restate-effect` (global-registry reason).** Restate's hook +
   inbound bridge + boundary observer read the active attempt span through the
   `@opentelemetry/api` GLOBAL (`trace.getActiveSpan()`), so restate REQUIRES a
   globally-registered SDK `TracerProvider` + global context manager. The shared
   path is pure-Effect `Otlp.layerJson` and deliberately never registers a global;
   serving restate here would double-export and drag `@opentelemetry/sdk-*` onto
   every CLI. Restate shares only the naming LAW (decodes the same
   `@overeng/otel-contract` brands). See `@overeng/restate-effect` decision 0007.

2. **`@overeng/utils-dev` otelite test harness (dependency-direction reason).**
   The otelite harness in `@overeng/utils-dev` is the universal test-harness leaf
   — every first-party package's _tests_ depend on it. So `utils-dev` importing
   the front door from `@overeng/utils`, or `ServiceIdentity` from
   `@overeng/otel-contract`, would close a `tsc --build` project-reference cycle
   (`utils` / `otel-contract` already reference `utils-dev` because their tests use
   it). The harness therefore hand-builds its `Otlp.layerJson` exporter and
   MIRRORS the `test`-shape knobs (short equal intervals + a 2000 ms shutdown
   ceiling) rather than importing them. Test↔prod fidelity is instead proven one
   level up, in `@overeng/utils/src/node/otel-telemetry.test.ts`, which exercises
   the real `withTelemetry({ shape: 'cli' })` front door against the SAME otelite
   receiver the harness boots. See
   [.decisions/0002-test-shape-sibling-convergence.md](./.decisions/0002-test-shape-sibling-convergence.md).

## Deferred (designed for later)

- **Front-door `service`/`test` end-to-end captures.** Only the `cli` shape has a
  full all-signals capture proof today (`otel-telemetry.test.ts`); `service` /
  `test` shapes are covered by the matrix + the harness sibling, not a separate
  front-door capture.
- **Shared `Shape`/`shapeDefaults` table across the test-harness boundary.** Left
  as a documented mirror, not a shared import, because no dep-light package both
  the harness and the front door can import without a cycle is the right home for
  exporter-mechanics data (it does not belong in the schema package
  `@overeng/otel-contract`).

## Open design questions

- **DQ01** Whether a future `@overeng/otel-core` (dep-light, holding `Shape` /
  `shapeDefaults` / resource mapping, importable by both the front door and the
  test harness) earns its keep as a new package, or whether the documented mirror
  is the simpler steady state. Not introduced here — it is a new abstraction not
  yet asked for.
