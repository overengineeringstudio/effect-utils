# Sync Observability — Design Proposal

Status: draft — design only, no implementation.
Scope: instrumenting the cache-backed `sync()` driver in
`@overeng/notion-react` so consumers (starting with pixeltrail) can measure
sync efficiency per-run and trend it over time.

## Motivation

The incremental sync driver (`src/renderer/sync.ts`) already returns a
`SyncResult` counter summary (`{appends, updates, inserts, removes,
fallbackReason?}`) plus an optional `fallbackReason`. That's enough to answer
"did a sync converge?" but not enough to answer the questions we actually
care about:

- How many Notion HTTP ops did this render trigger?
- How effective was the cache (hit/miss/drift)?
- Are there ops the reconciler could have avoided (e.g. content-identical
  update emitted due to hash drift, or retrieveChildren on every hot-cache
  sync)?
- How efficient is batching — are coalesced append runs landing at the
  100-child ceiling, or are we issuing many small calls?
- What's the latency breakdown per op kind? Which ops dominate wall time?
- How do these numbers trend across days of pixeltrail runs?

Today, answering any of these requires reading Effect tracer output by hand
or wrapping `NotionBlocks` at the consumer layer. The library should expose
a first-class instrumentation surface instead.

Non-goals:

- This is about observing sync, not about changing sync semantics.
- Not proposing a specific backend (Prometheus, Grafana, Notion block) —
  those are consumer concerns.
- Not proposing sampling / aggregation strategy inside the library — that
  belongs to the consumer.

## Dimensions to Track

Per `sync()` invocation:

| Dimension                                                                        | Source                                               | Purpose                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Ops emitted (diff plan)                                                          | `tallyDiff(plan)`                                    | How much work the reconciler decided was needed                     |
| Ops issued (HTTP calls)                                                          | counted at API boundary                              | How much of that survived batching                                  |
| Ops per kind: `appendChildren`, `updateBlock`, `deleteBlock`, `retrieveChildren` | API boundary                                         | Where cost concentrates                                             |
| Batching efficiency                                                              | `batch_size` per flush, `runs` per sync              | How effective coalescing is (`#101`)                                |
| Batch fill ratio                                                                 | batch_size / APPEND_CHILDREN_MAX                     | Are we hitting the ceiling?                                         |
| Cache outcome                                                                    | cold / hot / schema-mismatch / drift / page-id-drift | From existing `SyncFallbackReason`                                  |
| Drift probe cost                                                                 | 1 retrieveChildren per hot-cache sync                | Quantifies the pre-flight cost                                      |
| Candidate tree size                                                              | nodes, depth                                         | Render size baseline — ops/block ratio only meaningful against this |
| Cache tree size                                                                  | nodes                                                | Prior state baseline                                                |
| Latency wall clock                                                               | per op, per batch, per sync end-to-end               | Time budget; pixeltrail R21 budget                                  |
| Op outcome                                                                       | success / fail + `NotionSyncError.reason`            | Error rate by kind                                                  |
| Checkpoint flushes                                                               | count, cache size written                            | Cost of per-batch cache save (`#102`)                               |
| ID-map resolution count                                                          | size of `idMap`                                      | Implicit: blocks created                                            |
| Schema / page-id drift flags                                                     | existing flags                                       | Correlate trend data to root causes                                 |

Derived ratios worth surfacing (but the library should not compute — let
consumers derive):

- ops / candidate node — low = cache effective, high = churn
- HTTP calls / op — low = batching effective
- sync latency / op count — per-op cost
- fallback rate over time — drift frequency

## Approaches

### (a) Effect-native via `@effect/opentelemetry`

Wrap the `sync` driver and each API call in `Effect.withSpan(...)` and emit
metrics via `@effect/opentelemetry` Tracer/Metric. The library declares a
tracer name (`@overeng/notion-react`) and consumers install a tracer layer.

Pros:

- Native to Effect idioms the library is already built on.
- Spans come for free around `NotionBlocks.*` calls — wall-clock per op
  requires no extra code.
- Consumers running Effect+OTEL (most of the target fleet) get zero-config.

Cons:

- Peer-dep coupling: adds `@effect/opentelemetry` to the dependency surface.
- Consumers without OTEL pay eval cost even if they don't subscribe.
- Metrics-style aggregation is opaque — hard to inspect a single sync's
  op list programmatically.

### (b) Plain OTEL SDK via `@opentelemetry/api`

Same shape as (a) but using the vendor-neutral global API. Library writes
to `trace.getTracer('@overeng/notion-react')` and `metrics.getMeter(...)`.
Consumers wire their own SDK.

Pros:

- Universal; works outside Effect consumers too.
- No Effect coupling beyond what the library already has.

Cons:

- Still requires a peer dep (soft if we gate on `globalThis`).
- Duplicates work for Effect consumers who'd rather go through the Effect
  tracer layer (it adapts to OTEL under the hood anyway).
- Can't easily carry Effect error context (`NotionSyncError.reason`) into
  span attributes without adapter code.

### (c) Pluggable reporter hook

Add an optional `onEvent: (event: SyncEvent) => void` to `sync(element,
opts)`. Library emits a typed tagged-enum `SyncEvent` stream synchronously
at each interesting point. Consumers choose: log, count, forward to OTEL,
pipe to pixeltrail's own store.

Pros:

- Zero runtime deps, zero peer deps.
- Zero overhead when `onEvent` is `undefined` (single truthy check per
  emission site — V8 inlines the branch).
- Ergonomic for small consumers; pixeltrail can just accumulate into a
  tally without building an OTEL pipeline.
- Typed events are self-documenting and test-friendly.
- Tree-shakes cleanly if no `onEvent` is provided; no imports pulled in.

Cons:

- Consumers reinvent aggregation.
- No built-in dashboards.
- Synchronous callback — long-running consumer code would add sync latency.
  Mitigation: document the "keep it fast; buffer" contract.

### (d) Hybrid — (c) as core + optional adapter packages

Library's only coupling is the typed event stream (c). Ship optional
sub-path adapters:

- `@overeng/notion-react/o11y/otel` — drop-in that forwards `SyncEvent`s
  to the global OTEL tracer + meter.
- `@overeng/notion-react/o11y/effect` — an `Effect`-aware layer that wraps
  `sync` in tracer spans derived from the events.

Both adapters import the core event type but do not ship their deps as peer
deps of the main entry — consumers opt in per sub-path.

Pros:

- Keeps the main library dep-free.
- Gives Effect/OTEL users a one-liner.
- Pixeltrail-style consumers (tally into sqlite) use the raw hook.
- Each adapter is independently testable.

Cons:

- More surface area to document.
- Must keep adapters in-repo and versioned with core to avoid drift.

## Recommendation

Approach **(d) hybrid**, starting with the (c) core:

1. Land the typed `SyncEvent` union and `onEvent` hook first. This unblocks
   pixeltrail and gives us a stable contract.
2. Ship `o11y/effect` adapter second — it's the shortest path to real
   tracing for the Effect-native consumers (pixeltrail, forge).
3. Defer `o11y/otel` until a non-Effect consumer actually asks for it.

Rationale: the library should not impose a telemetry stack on consumers
who just want counters. The `onEvent` hook is the minimum contract that
makes every other approach derivable. Effect tracing can be layered on
top without changing core.

## Event Schema

Using `Data.TaggedEnum` per library convention:

```ts
import { Data } from 'effect'

export type SyncEvent = Data.TaggedEnum<{
  SyncStart: {
    readonly pageId: string
    readonly priorCacheNodes: number | undefined
    readonly candidateNodes: number
    readonly candidateDepth: number
  }
  SyncEnd: {
    readonly pageId: string
    readonly durationMs: number
    readonly result: SyncResult
    readonly httpOps: number
  }
  CacheOutcome: {
    readonly outcome: 'hot' | 'cold' | 'schema-mismatch' | 'cache-drift' | 'page-id-drift'
    readonly probeDurationMs: number | undefined
  }
  OpIssued: {
    readonly id: number // sync-local monotonic counter
    readonly kind: 'appendChildren' | 'updateBlock' | 'deleteBlock' | 'retrieveChildren'
    readonly parentId: string | undefined
    readonly batchSize: number // 1 for non-batched kinds
  }
  OpSucceeded: {
    readonly id: number
    readonly durationMs: number
    readonly resultCount: number // # server blocks confirmed
  }
  OpFailed: {
    readonly id: number
    readonly durationMs: number
    readonly reason: string // NotionSyncError.reason
  }
  BatchFlush: {
    readonly parentId: string
    readonly batchSize: number
    readonly batchCapacity: number // APPEND_CHILDREN_MAX
    readonly fillRatio: number
  }
  FallbackTriggered: {
    readonly reason: SyncFallbackReason
  }
  CheckpointWritten: {
    readonly afterOpId: number
    readonly durationMs: number
  }
}>

export const SyncEvent = Data.taggedEnum<SyncEvent>()
```

Notes:

- Payloads are small scalar-heavy structs so the zero-overhead path is a
  cheap `if (onEvent === undefined) return` at the emit site.
- `OpIssued.id` correlates `OpIssued` → `OpSucceeded`|`OpFailed` without a
  closure allocation. Consumers build the latency histograms themselves.
- `BatchFlush` is emitted alongside `OpIssued` for `appendChildren` — they
  carry redundant `batchSize`, but having a distinct event lets consumers
  specialise on batching efficiency without parsing op events.
- `CacheHit`/`CacheMiss` per-block is _not_ included. The diff already
  decides retention implicitly via the LCS match; per-node events would
  be noisy (N events per sync) for little added insight. `CacheOutcome`
  at the sync level is sufficient.

## Pixeltrail Usage

Pixeltrail's daily Notion sync already stores run metadata. Consuming
`onEvent` would look like:

```ts
const tally = {
  httpOps: 0,
  byKind: { appendChildren: 0, updateBlock: 0, deleteBlock: 0, retrieveChildren: 0 },
  totalBatchSize: 0,
  maxBatchSize: 0,
  failures: 0 as number,
}
yield *
  sync(element, {
    pageId,
    cache,
    onEvent: SyncEvent.$match({
      OpIssued: ({ kind, batchSize }) => {
        tally.httpOps++
        tally.byKind[kind]++
        if (kind === 'appendChildren') {
          tally.totalBatchSize += batchSize
          tally.maxBatchSize = Math.max(tally.maxBatchSize, batchSize)
        }
      },
      OpFailed: () => {
        tally.failures++
      },
      // ... other events no-op
    }),
  })
// persist tally row in pixeltrail's sqlite for trending
```

Trending surfaces in pixeltrail:

- "Sync efficiency" row in the tray: `httpOps / candidateNodes` with a
  sparkline across the last N days.
- Alert when `ops/node` ratio exceeds the rolling p95 by 2x (suggests
  spurious drift or hash instability).
- Dedicated Notion block emitted back to the status page showing batch
  fill ratio, fallback rate, and p95 op latency.
- R21 budget check: `SyncEnd.durationMs` rolls into the existing R21
  budget line.

## Prod-readiness Requirements

- **Zero overhead when unsubscribed.** Emit sites are
  `if (onEvent) onEvent(SyncEvent.OpIssued({...}))`. No allocation when
  `onEvent === undefined`. Validated by a micro-benchmark in the unit
  test suite (emit-disabled vs baseline).
- **Tree-shakable.** `SyncEvent` type lives next to `sync`; the
  `Data.taggedEnum` constructor is tree-shakable when unused. Adapter
  sub-paths (`o11y/effect`, eventually `o11y/otel`) are separate entries
  in `exports` so consumers don't pull OTEL unless they import the
  adapter.
- **Typed.** Full TS narrowing via `SyncEvent.$match`. No `any`.
- **Tested.**
  - Smoke test: trivial sync emits `SyncStart`, exactly one `SyncEnd`,
    and a plausible op-event sequence.
  - Correlation test: every `OpIssued` has exactly one terminal
    `OpSucceeded`/`OpFailed` with the same `id`.
  - Fallback test: cold-cache run emits `CacheOutcome{cold}` and
    `FallbackTriggered{cold-cache}`.
  - Batching test: 250 appends under one parent produce
    `ceil(250/100)=3` `BatchFlush` events with fillRatio `[1.0, 1.0, 0.5]`.
  - Disabled-overhead test: `sync` without `onEvent` does no measurable
    extra work vs the current implementation.
- **Documented.** New cookbook page: `docs/cookbook/observing-sync.md`
  covering:
  - Event catalogue with payload shapes.
  - The pixeltrail tally pattern.
  - Correlating `OpIssued` → terminal event.
  - When to reach for the Effect adapter vs raw hook.
  - Performance contract (keep `onEvent` fast).

## Open Questions

1. **Hash-caused no-op updates.** The diff emits `update` whenever
   `prior.hash !== cand.hash`. If the hash function is sensitive to
   projected-props ordering changes that are semantically no-ops, we'd
   like to observe "update issued but server payload byte-identical to
   prior." Should this be a distinct event (`UpdateNoop`) or derived by
   the consumer from prior snapshots? Leaning: out of scope for v1 —
   surface only if pixeltrail data shows the churn is real.

2. **Drift-probe caching.** Every hot-cache sync issues one
   `retrieveChildren` for drift detection. Is it worth exposing a
   `DriftProbeSkipped` event for a future mode where we only probe every
   N syncs, or is the probe cost negligible and the event unnecessary?
   Depends on measured probe latency from the first week of pixeltrail
   data.

3. **Per-block cache events.** Should we emit per-node `CacheHit` /
   `CacheMiss` (one event per candidate node) for deep debugging, even
   if pixeltrail doesn't need them? Tradeoff: event volume scales with
   tree size. Possibly behind a `verbose: true` flag. Leaning: skip for
   v1, add behind a flag only if someone needs it.
