# OpenTelemetry adapters

Two optional sub-path adapters layering on the core `onEvent` hook
(see [observing-sync.md](./observing-sync.md)) convert
[`SyncEvent`s](../../src/renderer/sync-events.ts) into OpenTelemetry
spans:

| Sub-path                            | Target                                                    | Dependency                                                                                        |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@overeng/notion-react/o11y/effect` | Effect consumers (pixeltrail, forge, ...) — **preferred** | Uses the ambient Effect `Tracer` service; consumers wire `@effect/opentelemetry` at their runtime |
| `@overeng/notion-react/o11y/otel`   | Non-Effect consumers                                      | Optional peer dep on `@opentelemetry/api`                                                         |

Both adapters emit the same logical span shape; the Effect variant
integrates trace-context propagation with the caller's Effect fiber so
op spans land as children of the caller's current span.

## Service name

Every emitted span carries a `service.name` attribute — default
`'notion-react'`. Override via `serviceName` so each subsystem is
queryable separately in Grafana while still sharing a trace:

```ts
yield * instrumentedSync(element, { pageId, cache, serviceName: 'pixeltrail-sync' })
```

Trace context still propagates through the caller. Grepping
`service.name=pixeltrail-sync` isolates the sync driver's spans;
grepping on the caller's service name shows the parent request; both
join the same trace id.

## Effect variant (primary)

```ts
import { instrumentedSync } from '@overeng/notion-react/o11y/effect'
import { NodeSdk } from '@effect/opentelemetry'
import { Effect, Layer } from 'effect'

const OtlpLayer = NodeSdk.layer(/* ... */)

const program = Effect.gen(function* () {
  yield* instrumentedSync(<Page />, {
    pageId,
    cache,
    serviceName: 'pixeltrail-sync',
  })
})

program.pipe(Effect.provide(OtlpLayer), Effect.runPromise)
```

`instrumentedSync` picks up the ambient `Effect.Tracer` service and the
fiber's current span (if any) as parent. Both sync-level and op-level
spans become children of the caller's current span — trace context
propagates automatically.

For finer control (e.g. composing an extra handler), use
`makeEffectSpanHandler`:

```ts
import { sync } from '@overeng/notion-react'
import { makeEffectSpanHandler } from '@overeng/notion-react/o11y/effect'

const program = Effect.gen(function* () {
  const tracer = yield* Effect.tracer
  const handler = makeEffectSpanHandler({ tracer, serviceName: 'pixeltrail-sync' })
  yield* sync(element, { pageId, cache, onEvent: handler })
})
```

## Raw OTEL variant (secondary)

```ts
import { sync } from '@overeng/notion-react'
import { createOtelEventHandler } from '@overeng/notion-react/o11y/otel'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { trace } from '@opentelemetry/api'

const sdk = new NodeSDK(/* OTLP exporter + resource */)
sdk.start()

const tracer = trace.getTracer('@overeng/notion-react')
const handler = createOtelEventHandler({ tracer, serviceName: 'pixeltrail-sync' })

await Effect.runPromise(sync(element, { pageId, cache, onEvent: handler }))
```

## Span catalogue

### Spans

| Name                       | When                        | Key attributes                                                                                                                                                                                                |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion-react.sync`        | Per sync invocation (root)  | `span.label=<pageId-short>`, `service.name`, `notion-react.page_id`, `notion-react.root_block_count`, `notion-react.ok`, `notion-react.op_count`, `notion-react.duration_ms`, `notion-react.fallback_reason?` |
| `notion-react.op.append`   | Each HTTP append            | `span.label=append`, `notion-react.op.id`, `notion-react.op.kind`, `notion-react.op.duration_ms`, `notion-react.op.result_count`                                                                              |
| `notion-react.op.update`   | Each HTTP update            | same shape as append                                                                                                                                                                                          |
| `notion-react.op.delete`   | Each HTTP delete            | plus optional `notion-react.op.note='already-archived'`                                                                                                                                                       |
| `notion-react.op.retrieve` | Drift / cold-baseline probe | same shape                                                                                                                                                                                                    |

Failed ops carry `notion-react.op.error` and an ERROR status.

### Span events (on the root sync span)

| Event                                                              | Attributes                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `cache:hit` / `cache:miss` / `cache:drift` / `cache:page-id-drift` | `span.label=cache:<kind>`                                 |
| `fallback`                                                         | `notion-react.fallback_reason`                            |
| `batch-flush`                                                      | `notion-react.batch.issued`, `notion-react.batch.batched` |
| `update-noop`                                                      | `notion-react.block_id`, `notion-react.noop_reason`       |
| `checkpoint-written`                                               | `notion-react.checkpoint.bytes?`                          |

## Re-entrancy

Each `makeEffectSpanHandler` / `createOtelEventHandler` call returns a
handler with its own closure state. Create one handler per concurrent
sync — handlers are not safe to share across overlapping `sync()` calls.

## See also

- [observing-sync.md](./observing-sync.md) — the underlying `onEvent` hook
- [o11y-design.md](../internals/o11y-design.md) — design rationale
