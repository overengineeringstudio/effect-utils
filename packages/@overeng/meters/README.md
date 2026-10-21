# @overeng/meters

Typed performance series, scoped Effect sessions, a canvas-backed React strip,
and headless measurement brackets. Readers share one store and frame clock;
rendering never owns collection.

The normative contracts are in [devtools](../../../context/devtools/spec.md),
with [meters requirements](../../../context/devtools/01-meters/requirements.md),
[API/lifecycle specification](../../../context/devtools/01-meters/spec.md), and
[ontology](../../../context/devtools/01-meters/ontology.md).

## Browser strip

Construct stable definitions outside React render. Factories are inert; the
provider keeps `meters.start` acquired until unmount.

```tsx
import * as React from 'react'
import { makeMeters, makeSeries, type FpsValue } from '@overeng/meters'
import { frameBlock, lightMeterTheme } from '@overeng/meters/canvas'
import { makeBrowserPlatform } from '@overeng/meters/platform/browser'
import { MetersProvider, MeterStrip } from '@overeng/meters/react'
import { frameSource } from '@overeng/meters/sources/frame'

const frames = makeSeries<FpsValue>({
  id: 'host.frames',
  label: 'Frames',
  unit: 'fps',
  capacity: 2600,
})
const meters = makeMeters({
  platform: makeBrowserPlatform(),
  sources: [frameSource({ id: 'host.frames', series: frames })],
})
const blocks = [frameBlock({ id: 'host.frames', series: frames })]

export const PerformanceStrip = () => {
  const [frozen, setFrozen] = React.useState(false)
  return (
    <MetersProvider meters={meters}>
      <MeterStrip
        meters={meters}
        blocks={blocks}
        theme={lightMeterTheme}
        frozen={frozen}
        onFrozenChange={setFrozen}
        onOpenDetail={({ id }) => console.info('Open detail', { id })}
      />
    </MetersProvider>
  )
}
```

Freeze captures only the renderer's bounded histories; collection and headless
reads continue. Detail activation belongs to the host. Multiple strips can share
one session. Hooks `useMeters`, `useSeries`, and `useSeriesSnapshot` read that
provider's typed store.

Presentation hooks publish every 250ms: in the frame publication phase when
frames are supported, otherwise on a timer. Publication pauses while the session
is hidden or stopped; raw event and interval acquisition remains independent.

### Breaking migration: explicit renderer time

Custom `block` descriptions receive `{ history, nowMs }`; bound readers require
`reader.describe({ nowMs })`. `makeStripView` requires `now: meters.clock.now`.
Numeric blocks keep their existing text and accessible names. Custom time-based
descriptions must use this injected time, not an ambient clock or last-draw cache.
Subscribed strip snapshots update on the existing 250ms presentation publication,
including epochs with no new sample, and retain array identity when text is
unchanged. Unsubscribed reads compute against the injected clock.

```ts
import { makeStripView } from '@overeng/meters/canvas'

const view = makeStripView({
  store: meters.store,
  blocks,
  now: meters.clock.now,
})
const text = view.readers[0]?.describe({ nowMs: meters.clock.now() })
```

`reader.snapshot()` remains a data-only bounded history copy: all reader methods
use the supplied `nowMs`. For a frozen view, evaluate descriptions/draw/evidence
with `view.frozenAtMs ?? meters.clock.now()`. Evidence `evaluatedAtMs` is this
explicit time. `latest.atMs` is the latest typed evidence timestamp and may
represent a synthetic state transition, not measurement age.

Blocks default to Latest evidence. A Bucket policy supplies mode, `bucketMs`,
`buckets` and the output `unit`; `resolveBlockAggregation` derives the completed
session-clock endpoint `floor(nowMs / bucketMs) * bucketMs` without bin arrays.
Bucket horizons do not inherit strip `historyMs`, and no implicit rate
normalization is applied.

## Headless gates

Keep a scope alive around the work. No UI is needed. `measurement` acquires a
scope-owned capability for split interactions; its single-shot `end` defaults
to zero settlement frames. `measureWindow` brackets an Effect and defaults to
30 actual visible settlement frames.

```ts
import { Effect } from 'effect'

const gate = Effect.gen(function* () {
  yield* meters.start
  const { measurement } = yield* meters.headless.measureWindow({
    work: Effect.sync(() => performHostInteraction()),
  })
  if (measurement._tag === 'Incomplete') {
    return { eligible: false, reasons: measurement.reasons }
  }
  return { eligible: true, passes: measurement.data.frameDrops <= 1 }
}).pipe(Effect.scoped)
```

Complete results contain bracket-scoped frame/counter deltas. Incomplete results
retain their reasons and partial evidence and **must never pass a budget**.
Calibration, visibility, observation loss, and source availability matter;
complete frame evidence does not certify an unrelated source's availability.
Unsupported capabilities produce tagged `Unavailable` observations shown as
`n/a`, never fabricated zeros.

For split work, acquire and end within the same owning scope:

```ts
const splitGate = Effect.gen(function* () {
  yield* meters.start
  const bracket = yield* meters.headless.measurement
  yield* hostWork
  return yield* bracket.end({ settleFrames: 5 })
}).pipe(Effect.scoped)
```

`end` validates settlement before claiming the capability, so invalid options can
be retried. Concurrent/repeated end fails `AlreadyEnded`; an unended resource
used after scope closure fails `ScopeClosed`, and session restart fails
`StaleGeneration`. Work failure/interruption abandons without settlement and
preserves its original Cause. Resource scopes do not prolong collection.

`MeasureResult` is both a value schema and a type exported by `/headless`;
`MeasureError` is a schema-backed tagged error. Encode wire results with
`Schema.encodeEffect(MeasureResult)` and decode untrusted results with
`Schema.decodeUnknownEffect(MeasureResult)` from the pinned Effect 4 API.
Capabilities are executable browser-local resources, not serializable data.

## Entry points

- Root, `/series`, `/headless`: platform-independent contracts, bounded histories,
  sessions, instrumentation, snapshots, and brackets.
- `/platform/browser`: injected browser environment and monotonic platform.
- `/sources/frame`, `/sources/long-frames`, `/sources/memory`: real browser timing,
  LoAF/longtask evidence, approximate JS heap, and explicit app-memory probes.
- `/sources/counters`, `/sources/status`, `/sources/fibers`, `/sources/spans`,
  `/sources/otel-browser`: explicitly configured instrumentation and adapters.
- `/canvas`, `/canvas/layout`: semantic light/dark themes, typed blocks, layout,
  and scoped renderer attachment.
- `/react`: provider, hooks, strip, and `RenderProfiler`/`reactCommitsSource`.
  Profiler receives an explicit instrumentation registry and counter token;
  counts represent actual commits, not component function invocations.

No browser global or counter bag is installed automatically. Automation may opt
into a host-selected scoped bridge. The package `src/stories` and `e2e` use a
DOM-local bridge only with `testBridge=meters-e2e`: `acquireMeasurement()` returns
an opaque token for a browser-owned resource scope; host locator interactions
run between acquisition and `finishMeasurement({ token, settleFrames })`.
Finish encodes `MeasureResult` for the host to decode. Invalid options preserve
the token for retry; claimed end closes its scope. Bridge teardown unregisters
directly, closes outstanding scopes, and cancels pending settlement. Tokens are
local to that bridge, not serialized core capabilities or callback protocols.

Workspace install: `@overeng/meters: workspace:^`. Peers: `effect`, `react`,
`react-dom`. The headless import graph does not include React or canvas.
