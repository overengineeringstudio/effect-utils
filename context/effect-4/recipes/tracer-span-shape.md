# Pattern: tracer-span-shape

**Area:** Observability boundary  **Kind:** semantic CI gate  **Our usage:** `otel-contract`,
OpenTelemetry integration, and published weaver semantic conventions.

## v3

```ts
import * as OtelTracer from "@effect/opentelemetry/Tracer"

const tracerService = Layer.succeed(OtelTracer.OtelTracer, otelTracer)
const tracing = OtelTracer.layerWithoutOtelTracer.pipe(Layer.provideMerge(tracerService))
program.pipe(Effect.provide(tracing))
```

## v4

```ts
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"

const tracerService = Layer.succeed(OtelTracer.OtelTracer, otelTracer)
const tracing = OtelTracer.layerWithoutOtelTracer.pipe(Layer.provideMerge(tracerService))
program.pipe(Effect.provide(tracing))
```

## Equivalence

```sh
bun run run:pattern tracer-span-shape
```

IDENTICAL. Under a canonical non-recording OpenTelemetry tracer, both majors complete successfully,
report `isRecording() === false`, and export no spans. Under an SDK recording tracer, both export
the same ordered child/parent spans, contract attributes, parent relation, and status.

This is a durable contract gate. It should snapshot normalized span names, contract attributes,
nesting, and status under both recording and non-recording providers. Any mismatch must fail CI.

## Intended differences (alignment register entries)

- None.

## Gotchas

- Never read SDK-private fields such as `_duration` or `_performanceStartTime`. Canonical no-op
  spans omit them. Measure application timing from a local monotonic clock.
- A no-op span must use OpenTelemetry's canonical invalid span context. Do not fabricate trace or
  span IDs.
- A test that only installs an SDK provider misses the no-provider production boundary.
- Normalize nondeterministic IDs and timing, but do not normalize away span names, parent
  relationships, status, or contract attributes.
- The module rename is `@effect/opentelemetry/Tracer` to `@effect/opentelemetry/OtelTracer`.

## Codemod rule

```text
import * as Tracer from "@effect/opentelemetry/Tracer"
-> import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
```

Review identifier aliases and service-layer construction after the import rewrite.
