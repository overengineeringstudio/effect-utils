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

## Headless gates

Keep a scope alive around the work. No UI is needed. `beginMeasure`/`endMeasure`
split an interaction bracket; `measureWindow` brackets an Effect and defaults to
30 actual settlement frames (`endMeasure` defaults to zero).

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

There is no automatically installed browser handle or global counter bag.
Automation may opt into a host-selected, scoped bridge around the same headless
API; registration is direct and release removes it. The package `src/stories`
and `e2e` use a DOM-local bridge only with `testBridge=meters-e2e`.

Workspace install: `@overeng/meters: workspace:^`. Peers: `effect`, `react`,
`react-dom`. The headless import graph does not include React or canvas.
