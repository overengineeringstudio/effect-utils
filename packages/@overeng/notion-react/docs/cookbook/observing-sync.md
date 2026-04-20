# Observing sync

`sync()` accepts an optional `onEvent` hook that emits a typed stream of
`SyncEvent`s as it runs. Use it to measure HTTP ops, cache efficiency,
batching efficiency, per-op latency, and spurious churn — without
wrapping the Notion client or parsing tracer output.

## Why

The `SyncResult` return value answers "did the sync converge?" but not:

- how many Notion HTTP calls this render triggered,
- whether the cache was hot / cold / drifted,
- whether batching landed at the 100-child ceiling or dribbled out as
  many small calls,
- which op kinds dominate wall time,
- whether updates are being issued for content-identical blocks
  (hash instability).

`onEvent` exposes all of the above as typed events. Consumers choose
how to aggregate.

## Minimal example

```ts
import { sync } from '@overeng/notion-react'
import { Effect } from 'effect'

const program = Effect.gen(function* () {
  yield* sync(element, {
    pageId,
    cache,
    onEvent: (e) => console.log(e._tag, e),
  })
})
```

## Tally per sync (pixeltrail-style)

Most consumers want per-sync counters:

```ts
import { sync, type SyncEvent } from '@overeng/notion-react'
import { Effect } from 'effect'

const tally = {
  httpOps: 0,
  byKind: { append: 0, update: 0, delete: 0, retrieve: 0 },
  maxBatch: 0,
  noops: 0,
  failures: 0,
}

const program = Effect.gen(function* () {
  yield* sync(element, {
    pageId,
    cache,
    onEvent: (e: SyncEvent) => {
      switch (e._tag) {
        case 'OpIssued':
          tally.httpOps++
          tally.byKind[e.kind]++
          break
        case 'BatchFlush':
          if (e.batched > tally.maxBatch) tally.maxBatch = e.batched
          break
        case 'UpdateNoop':
          tally.noops++
          break
        case 'OpFailed':
          tally.failures++
          break
      }
    },
  })
  // persist `tally` in your own store for trending
})
```

## Correlating ops

Every `OpIssued` has exactly one matching terminal event
(`OpSucceeded` or `OpFailed`) with the same `id`. Use `id` to build
latency histograms:

```ts
const inflight = new Map<number, number>()
onEvent: (e) => {
  if (e._tag === 'OpIssued') inflight.set(e.id, e.at)
  if (e._tag === 'OpSucceeded' || e._tag === 'OpFailed') {
    const started = inflight.get(e.id)
    inflight.delete(e.id)
    // e.durationMs is already populated; started is there if you
    // want wall-clock queue time instead of Effect-measured time
  }
}
```

## Event catalogue (v1)

| Event               | Payload                                                          | Purpose                           |
| ------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `SyncStart`         | `pageId`, `rootBlockCount`, `at`                                 | Sync begun                        |
| `CacheOutcome`      | `kind: 'hit'\|'miss'\|'drift'\|'page-id-drift'`, `pageId`, `at`  | Cache effectiveness               |
| `FallbackTriggered` | `reason: SyncFallbackReason`, `at`                               | Full-rebuild path taken           |
| `OpIssued`          | `id`, `kind`, `at`                                               | HTTP call started                 |
| `OpSucceeded`       | `id`, `kind`, `durationMs`, `resultCount`, `at`                  | HTTP call succeeded               |
| `OpFailed`          | `id`, `kind`, `durationMs`, `error`, `at`                        | HTTP call failed                  |
| `BatchFlush`        | `issued`, `batched`, `at`                                        | Batching efficiency per call      |
| `UpdateNoop`        | `id`, `blockId`, `reason: 'hash-equal'\|'other'`, `at`           | Elided update — hash churn signal |
| `CheckpointWritten` | `pageId`, `bytes?`, `at`                                         | Per-op cache flush completed      |
| `SyncEnd`           | `pageId`, `durationMs`, `ok`, `opCount`, `fallbackReason?`, `at` | Sync finished                     |

## Performance contract

- Emit sites are guarded by a single `if (onEvent !== undefined)` check.
  No event construction and no closure allocation happens when the hook
  is not subscribed.
- `onEvent` runs synchronously in the sync driver's hot path. Keep it
  fast — accumulate into plain counters, don't do I/O. If you need to
  persist, buffer and flush after `sync()` returns.

## OTEL adapters

Two drop-in adapters convert `SyncEvent`s into OpenTelemetry spans
without requiring consumers to hand-roll a span bridge. See
[observability-otel.md](./observability-otel.md) for setup,
the span catalogue, and the `service.name` override contract.

- `@overeng/notion-react/o11y/effect` — preferred for Effect consumers;
  uses the ambient `Effect.Tracer` service and inherits the caller's
  current span as parent.
- `@overeng/notion-react/o11y/otel` — raw `@opentelemetry/api` tracer.

The raw `onEvent` hook stays the core contract — both adapters are
implemented on top of it.
