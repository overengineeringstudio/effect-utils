# Meters Spec

This document specifies `@overeng/meters`. It builds on
[requirements.md](./requirements.md).

Status: **Draft** — the target API and implementation contract, not a description
of the legacy engine currently being replaced.

## Scope

This spec defines sources, cadence, typed series/history, session acquisition,
frame bookkeeping, instrumentation, renderers, React bindings, headless gates,
and clean migration. Package composition and common identifier rules belong to
[the parent spec](../spec.md). The [devbar](../02-devbar/spec.md) owns its shell;
[RPC integration](../04-rpc-devtools/spec.md) owns RPC aggregation;
[RPC observer](../03-rpc-observer/spec.md) owns transport interception.

Meters does not define RPC wire types, capture policy, a telemetry exporter,
automatic instrumentation, persistence, or application transports.

## Package Surface

Trace: DT.MET-R01–R04, R21, R28, R33.

```text
@overeng/meters (Effect contracts/session; no React or platform initialization)
  +-- /series                deterministic storage and reducers
  +-- /sources/frame         frame evidence and calibration
  +-- /sources/long-frames   shared scoped LoAF/longtask collector adapter
  +-- /sources/memory        heap source and explicit app-memory probe
  +-- /sources/fibers        host-enabled runtime gauge
  +-- /sources/spans         content-free completed-span aggregation
  +-- /sources/otel-browser  existing SpanRing/tracer seam adapter
  +-- /sources/counters      typed counters/gauges
  +-- /sources/status        host-provided status events, no transport
  +-- /canvas                pure blocks/layout + scoped canvas attachment
  +-- /headless              snapshots/brackets + optional scoped test bridge
  +-- /react                 provider/hooks/strip/text/tooltips/Profiler
```

There is no `/sources/rpc` or `/sources/rpc-explorer`: the corresponding source
belongs to `@overeng/rpc-devtools/core`. Root exports do not re-export platform
sources or UI entrypoints. Headless imports do not pull React or canvas into
the graph. Browser telemetry is optional and isolated behind its adapter.
Every module is declarative: no top-level browser reads, timers, observers,
metric enablement, runtime creation, or tracer mutation. Source factories
allocate configuration only. Manifest/export changes are authored in the
package's generator source rather than hand-editing generated manifests.

Signatures below are TypeScript contracts. Opaque tokens and the heterogeneous
source-registration closure are implemented privately; they are not cast-based
escape hatches. Multi-argument APIs use named objects.

## Samples and Series

Trace: DT.MET-R05, R07, R16; parent DT-R13–R14.

```text
Series<T> = identity + label + unit + capacity
  observations: Value<T> | Unavailable | Gap
  timestamps: session-local monotonic milliseconds
```

```ts
import type { Effect, Scope } from 'effect'

type Cadence =
  | { readonly _tag: 'PerFrame' }
  | { readonly _tag: 'Interval'; readonly everyMs: number }
  | { readonly _tag: 'Event' }

type UnavailableReason =
  | 'Unsupported'
  | 'NotConfigured'
  | 'NotIsolated'
  | 'PermissionDenied'
  | 'MeasurementFailed'
  | 'NoSamples'
  | 'Hidden'
  | 'HistoryLost'
  | 'CalibrationInvalid'
  | 'Stopped'

type Sample<TValue> =
  | { readonly _tag: 'Value'; readonly atMs: number; readonly value: TValue }
  | { readonly _tag: 'Unavailable'; readonly atMs: number; readonly reason: UnavailableReason }
  | {
      readonly _tag: 'Gap'
      readonly atMs: number
      readonly durationMs: number
      readonly reason: 'MissedFrame' | 'Hidden' | 'Overflow'
    }

type Unit = 'fps' | 'ms' | 'bytes' | 'count' | 'status'
interface Series<TValue> {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly capacity: number
  // opaque invariant TValue token, minted only by makeSeries
}
declare const makeSeries: <TValue>(options: {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly capacity: number
}) => Series<TValue>

interface NumberValue {
  readonly _tag: 'Number'
  readonly value: number
}
interface StatusValue {
  readonly _tag: 'Status'
  readonly state:
    'Connecting' | 'Connected' | 'Disconnected' | 'Reconnecting' | 'Syncing' | 'Synced' | 'Error'
  readonly label: string
}
```

Identifiers follow the [parent naming contract](../spec.md#naming-contract).
`makeSeries` rejects invalid IDs and non-positive/non-integer capacity. A token
belongs to one payload type; registration of another token with the same ID
fails rather than replacing it. A source's ID and cadence are immutable for a
session. Invalid/non-finite interval duration is a configuration error.

All `atMs` use the injected monotonic clock; a session snapshot includes
`timeOriginMs` for interpretation. Event adapters normalize browser entry
start times to this coordinate system and keep arrival order distinct from an
entry's measurement time. Appends use nondecreasing observation timestamps;
delayed entry start/duration stays in the payload rather than moving the ring's
observation clock backward. Values must be finite and unit-correct. A registered
counter at zero is measured zero; no observation yet is `NoSamples`.

## SeriesStore and History

Trace: DT.MET-R06–R09; parent DT-R14 and Q10.

```text
writer --O(1) append--> fixed-capacity ring
                          +-- live read-only cursor (canvas/reducers)
                          +-- explicit immutable snapshot (React/headless)
                          +-- independent subscriber notifications
```

```ts
interface Retention {
  readonly capacity: number
  readonly length: number
  readonly oldestAtMs: number | undefined
  readonly newestAtMs: number | undefined
  readonly overflowCount: number
  readonly firstRetainedSequence: number
  readonly nextSequence: number
}
interface SeriesView<TValue> extends Retention {
  readonly revision: number
  readonly latest: Sample<TValue> | undefined
  readonly at: (index: number) => Sample<TValue> | undefined
}
interface SeriesSnapshot<TValue> extends Retention {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly revision: number
  readonly samples: readonly Sample<TValue>[]
}
interface SeriesWriter<TValue> {
  readonly append: (options: { readonly sample: Sample<TValue> }) => void
}
interface SeriesStore {
  readonly register: <TValue>(options: { readonly series: Series<TValue> }) => SeriesWriter<TValue>
  readonly read: <TValue>(options: { readonly series: Series<TValue> }) => SeriesView<TValue>
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly subscribe: (options: { readonly notify: () => void }) => () => void
  readonly getRevision: () => number
}
```

A ring uses fixed slots and increasing sequence numbers, not `shift`, `splice`,
or per-frame array copying. Once full, each overwritten sample increments
`overflowCount`. Overflow evidence is ring metadata; appending an additional
`Gap` into the same full ring must not recursively count itself as another lost
observation. Renderers use retained sequences/range to mark truncated history.

Live views are synchronous cursors and must not be retained as immutable
historical snapshots. `snapshotSeries` lazily materializes immutable arrays;
its identity is stable until that series revision changes. Store subscriptions
signal revisions and never drain a queue shared with another reader. React
publication is coalesced at 250ms while visible; canvas reads the live revision
and headless explicit reads are current. Publishing requires a running lease;
no permanent timer is installed by defining a store.

Every source carries its own capacity; no global sample-count default stands in
for a time budget. The strip's normal visual horizon is approximately 10s.
For a 240Hz per-frame source, 10s requires at least 2400 actual sample slots,
plus any explicit gap observations. Hosts choose capacity from expected cadence
and memory budget. A smaller ring exposes its shorter actual range rather than
stretching it to look like 10s. Interval/event history remains time-based.
Frame statistics use their own 2s window and can report `HistoryLost` if configured
capacity cannot supply that window. Lifetime counters are separate from rings.

## Scoped Lifecycle and FrameClock

Trace: DT.MET-R01–R04, R13–R16.

```text
constructed (inert)
  -- first scoped lease --> acquiring --> collecting
  -- extra lease -----------------------> same collectors
  -- last release --> synchronously deactivate callbacks --> async finalizers
  -- new lease waits for finalizers --> reacquire, preserve cumulative totals
```

```ts
interface SourceError {
  readonly _tag: 'SourceError'
  readonly sourceId: string
  readonly reason: 'AcquisitionFailed' | 'InvalidConfiguration'
  readonly cause: Error
}
interface FrameTick {
  readonly atMs: number
  readonly elapsedMs: number
  readonly sequence: number
}
interface ClockStopped {
  readonly _tag: 'ClockStopped'
  readonly reason: 'Stopped' | 'Hidden'
}
interface FrameClock {
  readonly subscribe: (options: {
    readonly listener: (tick: FrameTick) => void
    readonly phase: 'Source' | 'Draw'
  }) => Effect.Effect<void, never, Scope.Scope>
  readonly waitFrames: (options: { readonly count: number }) => Effect.Effect<void, ClockStopped>
  readonly now: () => number
}
interface SourceRegistration<TEnv = never> {
  readonly id: string
  readonly cadence: Cadence
  // opaque, type-erased registration closure; no public untyped writer
}
interface Source<TValue, TEnv = never> extends SourceRegistration<TEnv> {
  readonly series: Series<TValue>
  readonly start: (options: {
    readonly sink: SeriesWriter<TValue>
    readonly clock: FrameClock
  }) => Effect.Effect<void, SourceError, TEnv | Scope.Scope>
}
declare const makeSource: <TValue, TEnv = never>(options: {
  readonly id: string
  readonly cadence: Cadence
  readonly series: Series<TValue>
  readonly start: Source<TValue, TEnv>['start']
}) => Source<TValue, TEnv>

interface Platform {
  readonly now: () => number
  readonly timeOriginMs: number
  readonly requestFrame: (callback: (atMs: number) => void) => number
  readonly cancelFrame: (id: number) => void
  readonly isVisible: () => boolean
  readonly observeVisibility: (listener: (visible: boolean) => void) => () => void
  // Host/browser adapter supplies capabilities only when acquired.
}
interface Meters<TEnv = never> {
  readonly store: SeriesStore
  readonly clock: FrameClock
  readonly headless: Headless
  readonly start: Effect.Effect<void, SourceError, TEnv | Scope.Scope>
}
declare const makeMeters: <TEnv = never>(options: {
  readonly sources: readonly SourceRegistration<TEnv>[]
  readonly platform: Platform
}) => Meters<TEnv>
```

`makeSource` captures a typed registration closure so heterogeneous sources
can be listed without `any`, casting payloads, or exposing untyped store writes.
`Source.start` is implemented with `Effect.acquireRelease` or equivalent scoped
composition. It returns after collector installation; its enclosing scope must
remain alive. A source must not be returned from `Effect.scoped` after its
collector scope has already closed. The session acquires all selected sources
transactionally: an acquisition failure releases already acquired resources.

Per-frame sources subscribe to `FrameClock`; none requests its own rAF.
Interval sources use single-flight Effect loops. Event sources install removable
subscriptions only. Unsupported sources append `Unavailable` once and install
no futile polling. Expected observation failure appends unavailable evidence
and preserves its cause in diagnostics; unexpected defects are surfaced through
the owning runtime rather than converted to healthy values. A subscriber fault
must be reported without preventing delivery to other subscribers.

The first session lease opens source scopes and visibility observation; the
last closes them. No rAF exists until a selected source or attached renderer
needs frames. The clock has at most one pending callback, delivers all source
callbacks before draw callbacks, and uses the same tick for every strip.
Hidden state cancels pending rAF and pauses periodic browser polling; event
subscriptions remain installed where needed to observe actual events. Resume
records a hidden gap, resets the previous timestamp/bucket index, and does not
reset lifetime totals. `waitFrames` fails with `Hidden`/`Stopped` immediately
when it cannot continue. No settlement promise waits indefinitely for hidden
frames. Finalization cancels browser callbacks synchronously before awaiting
asynchronous cleanup; a late probe checks its acquisition generation and
cannot append after release. Reacquisition waits behind unfinished cleanup.
A new session is the cumulative-counter reset boundary.

## Frame Bookkeeping

Trace: DT.MET-R10–R13, R18–R19; parent Q3/Q10/Q11.

```text
rAF timestamps -> duration ring -> observed 2s avg/p50/p99
              -> calibration ring -> bucket -> bucket-index misses
                                           -> cumulative skipped total
captured tick ------------------------------> cumulative captured total
```

```ts
type Calibration =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Calibrated'; readonly bucket: 60 | 120 | 144 | 160 | 240 }
  | { readonly _tag: 'Unsupported'; readonly observedFps: number }
interface FpsValue {
  readonly _tag: 'Fps'
  readonly durationMs: number
  readonly skippedFrames: Sample<NumberValue>
  readonly framesCaptured: number
  readonly calibration: Calibration
}
interface FrameStats {
  readonly averageFps: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly framesCaptured: number
  readonly frameDrops: Sample<NumberValue>
  readonly calibration: Calibration
}
declare const frameSource: (options: {
  readonly id: string
  readonly series: Series<FpsValue>
}) => Source<FpsValue>
```

| Step                        | Rule                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial tick                | Increment captured total; establish timestamp baseline; do not invent a zero-duration sample for statistics                                                                        |
| Visible interval            | Record positive duration; captured sequence is independent of wall-clock bucket index                                                                                              |
| Calibration                 | Retain 500 positive durations; every 100 captured frames use the mean of ten entries around the median (five below and five from the median upward)                                |
| Bucket selection            | Round `1000 / mean` and choose nearest bucket in 60/120/144/160/240 only when absolute distance is strictly less than 10; otherwise `Unsupported`                                  |
| Missing frames              | With valid calibration, derive current index `floor(atMs / (1000 / bucket))`; skipped estimate is `max(0, currentIndex - previousIndex - 1)`                                       |
| Bucket change/resume        | Rebase previous bucket index on that tick, add no artificial misses, preserve cumulative counts                                                                                    |
| Trailing window             | Include valid visible durations whose ending timestamp falls in the latest 2000ms; average FPS is `1000 / mean(duration)`; p50/p99 use nearest-rank quantiles of that duration set |
| No valid durations          | `NoSamples`, not synthetic FPS or zero percentiles                                                                                                                                 |
| Calibration pending/invalid | Observed FPS/duration statistics may be available; skipped-frame estimate is unavailable and frame-drop gates are ineligible                                                       |

Quantile scratch storage is reused and results cached by the frame revision.
Reducers run at summary publication (250ms) or an explicit headless snapshot
read; canvas draws cached summary statistics and never triggers sorting.
Insufficient configured history is reported rather than quietly shortening the
2s window. Calibration transitions and invalid intervals are recorded
independently of ring eviction so active brackets cannot miss them. Skipped
frames are scheduling estimates, not proof that the compositor dropped a
presented frame.

## Typed Instrumentation

Trace: DT.MET-R09, R18, R26–R27.

```text
host service injection -> counter.add / gauge.set -> monotonic totals/current values
                                                        +-- event Source
                                                        +-- bracket baselines
```

```ts
interface CounterToken {
  readonly id: string
} // opaque counter token
interface GaugeToken {
  readonly id: string
} // distinct opaque gauge token
interface Counter {
  readonly add: (options: { readonly by: number }) => void
  readonly read: () => number
}
interface Gauge {
  readonly set: (options: { readonly value: number }) => void
  readonly read: () => number
}
interface Instrumentation {
  readonly counter: (options: { readonly token: CounterToken }) => Counter
  readonly gauge: (options: { readonly token: GaugeToken }) => Gauge
}
declare const makeInstrumentation: (options: {
  readonly counters: readonly CounterToken[]
  readonly gauges: readonly GaugeToken[]
}) => Instrumentation
declare const counterToken: (options: { readonly id: string }) => CounterToken
declare const gaugeToken: (options: { readonly id: string }) => GaugeToken
declare const counterSource: (options: {
  readonly id: string
  readonly series: Series<NumberValue>
  readonly instrumentation: Instrumentation
  readonly token: CounterToken
}) => Source<NumberValue>
declare const gaugeSource: (options: {
  readonly id: string
  readonly series: Series<NumberValue>
  readonly instrumentation: Instrumentation
  readonly token: GaugeToken
}) => Source<NumberValue>
```

The host constructs and injects the typed instrumentation service at its
application composition boundary; no global bag or module augmentation is
used. An instrument is registered deliberately, begins at real zero, and keeps
its total/value across source detach and session-lease remount. Counters accept
finite nonnegative increments; gauges accept finite current values. A decrease
is a gauge operation, not a negative counter increment. Undeclared instruments
are configuration errors, not lazy creation by arbitrary strings.

Counter/gauge sources subscribe to instrument changes only while acquired;
interval readers remain an explicit `makeSource` option when event writes are
not available. Source views and brackets access the same cumulative registry
bound by the source-registration closure. Newly declared counters begin at
zero; those first appearing during a bracket contribute their entire increment.
Visual counter rates compute deltas over timestamps without resetting totals.
Threshold blocks use semantic warning/danger roles supplied by the theme.

## Built-in Sources and Availability

Trace: DT.MET-R16, R22–R28; parent DT-R16–R17, R22.

| Source / cadence            | Real payload and seam                                                                                           | Availability and detail semantics                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FPS / PerFrame              | `FpsValue`; shared rAF timestamps, captured/skipped counters and calibration                                    | Missing frame capability = `Unsupported`; hidden gap; calibration explicitly pending/unsupported                                                                                                                         |
| Jank / Event                | LoAF duration, blocking duration, render-phase timings; fallback longtask duration                              | Feature-detect `PerformanceObserver.supportedEntryTypes`; use LoAF if available, otherwise label **long tasks**; neither = `Unsupported`; never sum both feeds or fabricate LoAF fields                                  |
| JS heap / Interval          | `HeapMemory { usedBytes, totalBytes, limitBytes }` from `performance.memory`, normally every 1000ms             | Chromium capability, approximate/non-standard shared JS heap; absent = `Unsupported`; strip label **JS heap**, not total application memory                                                                              |
| App memory / Event          | Explicit opted-in `probe` calls to `performance.measureUserAgentSpecificMemory`, yielding `AppMemory { bytes }` | Detail panel only; require supported API, secure context, and `crossOriginIsolated`; missing isolation = `NotIsolated`; permission/security failure = explicit unavailable; no COOP/COEP mutation; never substitute heap |
| Child fibers / Interval     | `Fibers { activeChildFibers }` from Effect runtime gauge `child_fibers_active`, normally every 250ms            | Host supplies enablement evidence and metric context; false/unknown enablement = `NotConfigured`, never dormant zero; label **active child fibers**, not all fibers                                                      |
| Spans / Event               | Completion duration/status/rate plus lifetime completion/error totals at existing tracer/SpanRing seam          | Host must supply seam; absent = `NotConfigured`; exact totals come from completion callbacks, not retained span count; no exporter starts                                                                                |
| App counters/gauges / Event | Declared typed instrument changes; explicit interval readers allowed                                            | Platform-independent; missing configuration = unavailable; declared zero is real; no destructive reads                                                                                                                   |
| React commits / Event       | `ReactCommit` per Profiler callback, phase/durations/commit time and monotonic per-id count                     | Only actual dev/profiling callbacks; unsupported build or unmounted instrumentation = `NotConfigured`; zero is real only with installed/configured Profiler                                                              |
| Generic host status / Event | `StatusValue` from a supplied existing connection/sync adapter                                                  | No adapter = `NotConfigured`; socket open is not sync completion; no diagnostic socket and no `navigator.onLine` proxy for health                                                                                        |
| RPC / Event, external       | Integration-owned typed in-flight/latency/error series                                                          | Supplied by [rpc-devtools](../04-rpc-devtools/spec.md), not implemented or imported by meters; no observation scope = `NotConfigured`                                                                                    |

Representative payloads and factory signatures:

```ts
type LongFrameValue =
  | {
      readonly _tag: 'LoAF'
      readonly startedAtMs: number
      readonly durationMs: number
      readonly blockingDurationMs: number
      readonly renderStartMs: number
    }
  | { readonly _tag: 'LongTask'; readonly startedAtMs: number; readonly durationMs: number }
interface HeapMemory {
  readonly _tag: 'HeapMemory'
  readonly usedBytes: number
  readonly totalBytes: number
  readonly limitBytes: number
}
interface AppMemory {
  readonly _tag: 'AppMemory'
  readonly bytes: number
}
interface Fibers {
  readonly _tag: 'Fibers'
  readonly activeChildFibers: number
}
interface SpanSummary {
  readonly _tag: 'SpanSummary'
  readonly durationMs: number
  readonly status: 'Success' | 'Error'
  readonly completions: number
  readonly errors: number
}
interface ReactCommit {
  readonly _tag: 'ReactCommit'
  readonly id: string
  readonly phase: 'mount' | 'update' | 'nested-update'
  readonly actualDurationMs: number
  readonly baseDurationMs: number
  readonly commitTimeMs: number
  readonly commits: number
}
declare const longFramesSource: (options: {
  readonly id: string
  readonly series: Series<LongFrameValue>
}) => Source<LongFrameValue>
declare const heapSource: (options: {
  readonly id: string
  readonly series: Series<HeapMemory>
  readonly everyMs: number
}) => Source<HeapMemory>
interface AppMemoryProbe {
  readonly source: Source<AppMemory>
  readonly probe: Effect.Effect<Sample<AppMemory>, SourceError>
}
declare const appMemoryProbe: (options: {
  readonly id: string
  readonly series: Series<AppMemory>
}) => AppMemoryProbe
interface RuntimeMetricContext {
  readonly runtimeMetricsEnabled: () => boolean
  readonly readActiveChildFibers: () => number
}
declare const fibersSource: (options: {
  readonly id: string
  readonly series: Series<Fibers>
  readonly everyMs: number
  readonly metricContext: RuntimeMetricContext
}) => Source<Fibers>
interface SpanCompletion {
  readonly atMs: number
  readonly durationMs: number
  readonly status: 'Success' | 'Error'
}
interface SpanCompletionFeed {
  readonly subscribe: (options: {
    readonly onComplete: (value: SpanCompletion) => void
  }) => Effect.Effect<void, SourceError, Scope.Scope>
}
declare const spansSource: (options: {
  readonly id: string
  readonly series: Series<SpanSummary>
  readonly feed: SpanCompletionFeed
}) => Source<SpanSummary>
declare const statusSource: (options: {
  readonly id: string
  readonly series: Series<StatusValue>
  readonly subscribe: (options: {
    readonly emit: (sample: Sample<StatusValue>) => void
  }) => Effect.Effect<void, SourceError, Scope.Scope>
}) => Source<StatusValue>
```

Long-frame collection reuses the scoped browser observation primitive extracted
from otel-browser LongFrames. Telemetry and meters can compose one collector
feed rather than install overlapping observers. Span aggregation reuses the
existing SpanRing/tracer seam, extended with a content-free completion listener
where required. Throttled retained-ring snapshots alone cannot provide exact
lifetime totals: old retained spans may seed visible history but never bracket
counter baselines. OTLP sampling does not change local completion counters, and
meters does not stack another tracer wrapper on an already instrumented host.

`appMemoryProbe` creates no automatic timer. `probe` requires its source's live
lease; concurrent invocations share one outstanding request. Unsupported or
non-isolated acquisition emits unavailable evidence without calling the API.
Closing the scope invalidates the in-flight result, even if the browser API
cannot cancel its Promise. Probe failure never looks like zero bytes.

The fiber context reads the actual Effect gauge with its upstream description
**The current count of active child fibers**. Host enablement comes from
`Metric.enableRuntimeMetrics` or its runtime-metrics layer around the observed
application program. Meters never enables it itself or replaces the runtime
metric service. Details describe shared/tagged registry scope and whether
diagnostic child fibers are included; no custom supervisor count is substituted
for this agreed gauge.

## Canvas and Independent Renderers

Trace: DT.MET-R03, R29–R32; parent Q1/Q7.

```text
SeriesStore -> CanvasBlock<T> closures -> one CanvasStrip
            -> labelled DOM outputs + focus targets + DOM tooltip
            -> separate bounded frozen view (optional)
```

```ts
interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
interface MeterTheme {
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly border: string
  readonly normal: string
  readonly warning: string
  readonly danger: string
  readonly gap: string
  readonly focus: string
  readonly font: string
}
interface DrawInput<TValue> {
  readonly ctx: CanvasRenderingContext2D
  readonly rect: Rect
  readonly history: SeriesView<TValue>
  readonly nowMs: number
  readonly historyMs: number
  readonly theme: MeterTheme
}
interface BlockReader {
  readonly revision: () => number
  readonly describe: () => string
  readonly draw: (input: Omit<DrawInput<never>, 'history'>) => void
  readonly snapshot: () => BlockReader
}
type MeterSession = Pick<Meters, 'store' | 'clock'>
interface StripView {
  readonly readers: readonly BlockReader[]
  readonly frozenAtMs: number | undefined
  readonly getSnapshot: () => readonly string[]
  readonly subscribe: (notify: () => void) => () => void
}
interface CanvasPlatform {
  readonly dpr: () => number
  readonly availableWidth: () => number | undefined // measured host slot width
  readonly observeChanges: (notify: () => void) => () => void
}
interface CanvasBlockSpec {
  readonly id: string
  readonly label: string // full label: accessible text and tooltip
  readonly shortLabel?: string // canvas-only fallback when the full label does not fit
  readonly widthPx: number // nominal width; shrinks only when the slot is too small
  readonly read: (store: SeriesStore) => BlockReader // opaque typed draw/describe/snapshot closures
}
declare const block: <TValue>(options: {
  readonly id: string
  readonly series: Series<TValue>
  readonly widthPx: number
  readonly draw: (input: DrawInput<TValue>) => void
  readonly describe: (history: SeriesView<TValue>) => string
}) => CanvasBlockSpec
declare const makeStripView: (options: {
  readonly store: SeriesStore
  readonly blocks: readonly CanvasBlockSpec[]
  readonly frozenAtMs?: number
}) => StripView
interface Renderer {
  readonly attach: Effect.Effect<void, never, Scope.Scope>
}
declare const makeCanvasStrip: (options: {
  readonly canvas: HTMLCanvasElement
  readonly meters: MeterSession // store and clock only; no acquisition capability
  readonly blocks: readonly CanvasBlockSpec[]
  readonly heightPx?: number
  readonly gapPx?: number
  readonly historyMs?: number
  readonly readTheme: () => MeterTheme
  readonly view?: StripView
  readonly platform?: CanvasPlatform
  readonly onLayout?: (layout: StripLayout) => void // DOM overlays share the canvas layout
}) => Renderer
```

Block construction closes over a typed series reader; draw receives no writer,
polling callback, or source acquisition capability. Provide frame, numeric,
stacked numeric, heap, fiber, jank, span, and commit block builders around this
contract; RPC integration supplies its block selection without protocol imports
in meters. Every block draws both current value and time-based history. Empty
lists draw no meters and do not acquire a default source.

For block `i`, `x[i] = sum(width[j] + gapPx, j < i)`; total width is the sum of
block widths plus `(n - 1) * gapPx` for nonempty strips, with no trailing gap.
Devbar sets height to 32 CSS px, typical width to approximately 150 CSS px, and
history horizon to approximately 10000ms. Standalone strips can choose other
sizes. The strip fills the slot it is given: each block takes its nominal width
when the measured slot allows it and all blocks shrink proportionally only when
the slot is too small; blocks never grow past the nominal width. The container,
not the canvas, is measured, so sizing the canvas cannot feed back. Backing
dimensions are `round(cssSize * actualDpr)`; use the actual fractional DPR and
CSS-coordinate transforms, not integer DPR truncation. Block header text is laid
out by measurement: the right-aligned value is reserved first, then the label
takes the remaining width as the full label, the `shortLabel`, an ellipsized
label, or nothing below a minimum width. Label and value never overlap, and text
is never squeezed through a `fillText` maximum width.
ResizeObserver and DPR change signals are acquired with the renderer scope;
sizing/theme resolution happens on changes, not per frame. Strip attachment
uses the session clock and never creates a per-grid engine.

History bins are based on timestamps: event counters aggregate per time bin,
gauges hold the last observation with age/staleness shown, and missed/hidden
intervals have explicit gap rendering. Unsupported values draw `n/a` with a
reason. DPR changes do not change the time horizon. Token resolution is a host
adapter; devbar maps StyleX tokens to `MeterTheme` or semantic CSS variables.
Meters imports no StyleX and does no per-frame `getComputedStyle`.

The canvas is decorative when equivalent labelled DOM outputs are present.
Text publication is not an aria-live event every frame. Each block has a DOM
focus target covering the same rectangle used for pointer hit testing. Focus
or click calls the detail-activation callback; the shell opens the corresponding
panel above the stationary bar. DOM tooltips are reachable by keyboard and
show label, unit, source, age, retained range, and unavailable reason. Hover may
also reveal a tooltip but never owns a unique behavior.

Freeze has a separate accessible control. It materializes a bounded renderer
snapshot and freezes canvas/text/tooltip evidence together; sources, clock,
other renderers, and brackets keep advancing. The view shows its frozen state
and observation time. Unfreeze returns to current shared evidence.

## Headless Snapshots and Measure Brackets

Trace: DT.MET-R17–R21; parent DT-R15 and Q11.

```text
beginMeasure -> capture cumulative baselines + register handle
  -> host work / automation
  -> endMeasure -> optional visible-frame settle -> validate evidence
                   +-- Complete: eligible measured bracket
                   +-- Incomplete: partial evidence + reasons, gate ineligible
```

```ts
interface Snapshot {
  readonly sessionId: string
  readonly generation: number
  readonly timeOriginMs: number
  readonly atMs: number
  readonly frames: Sample<FrameStats>
  readonly retention: readonly { readonly id: string; readonly range: Retention }[]
  readonly counters: Readonly<Record<string, number>>
}
interface MeasureHandle {
  readonly _tag: 'MeasureHandle'
  readonly sessionId: string
  readonly generation: number
  readonly id: number
  readonly startedAtMs: number
}
interface CompleteData {
  readonly durationMs: number
  readonly framesCaptured: number
  readonly frameDrops: number
  readonly averageFps: number
  readonly counterDelta: Readonly<Record<string, number>>
}
interface PartialData {
  readonly durationMs: number
  readonly framesCaptured: number
  readonly frameDrops: Sample<NumberValue>
  readonly averageFps: Sample<NumberValue>
  readonly counterDelta: Readonly<Record<string, number>>
}
type IncompleteReason =
  | 'Hidden'
  | 'CalibrationInvalid'
  | 'Stopped'
  | 'NoSamples'
  | 'NotConfigured'
  | 'HistoryLost'
  | 'ObservationLost'
type MeasureResult =
  | { readonly _tag: 'Complete'; readonly eligible: true; readonly data: CompleteData }
  | {
      readonly _tag: 'Incomplete'
      readonly eligible: false
      readonly reasons: readonly [IncompleteReason, ...IncompleteReason[]]
      readonly data: PartialData
    }
interface MeasureError {
  readonly _tag: 'MeasureError'
  readonly reason:
    | 'NotRunning'
    | 'WrongSession'
    | 'StaleGeneration'
    | 'AlreadyEnded'
    | 'InvalidHandle'
    | 'InvalidOptions'
}
interface Headless {
  readonly snapshot: () => Snapshot
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly beginMeasure: Effect.Effect<MeasureHandle, MeasureError>
  readonly endMeasure: (options: {
    readonly handle: MeasureHandle
    readonly settleFrames?: number
  }) => Effect.Effect<MeasureResult, MeasureError>
  readonly measureWindow: <TValue, TError, TEnv>(options: {
    readonly work: Effect.Effect<TValue, TError, TEnv>
    readonly settleFrames?: number
  }) => Effect.Effect<
    { readonly result: TValue; readonly measurement: MeasureResult },
    TError | MeasureError,
    TEnv
  >
}
```

Custom series use typed `snapshotSeries`, not an untyped catch-all serialized
payload union. Snapshot identity is stable until its relevant revision changes;
explicit reads capture `atMs` at that revision. Source acquisition/visibility
changes also publish revisions, so unavailable state is not hidden by caching.

A session-owned active-handle registry stores immutable before-totals,
visibility/calibration validity markers, and optional source loss markers.
The returned handle contains only its serializable identity and time;
JSON round trips preserve it. Validate every returned field against the
registry, consume exactly once, reject modified/cross-session/stale-generation
handles, and do not trust caller-supplied baseline counters.

| Operation       | Default settlement | Semantics                                                                                                                                                        |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginMeasure`  | None               | Requires a running lease; records baselines even if frame calibration is currently pending, making that bracket ineligible unless all bracket evidence was valid |
| `endMeasure`    | 0 frames           | Claims the handle once, then settles and captures after-totals; settlement extends the measured interval                                                         |
| `measureWindow` | 30 frames          | Begins, runs Effect work, ends; failure/interruption closes the handle in a finalizer and preserves the original cause                                           |

Settlement count is a finite nonnegative integer. No implicit timeout or wall
clock delay replaces actual frame settlement. Hidden/stopped settlement returns
`Incomplete` promptly; last-lease release settles pending measurements before
closing resources. Calling `endMeasure` for an existing handle after collection
stopped yields incomplete partial evidence rather than an apparently complete
measurement. Beginning a new bracket while stopped is `NotRunning`.

For an eligible bracket, `durationMs = endMs - startMs`, captured/skipped frames
are cumulative deltas, and `averageFps = round(framesCaptured * 1000 / durationMs)`.
A zero-duration/no-frame bracket is `Incomplete(NoSamples)`, not a passing zero
or infinity. Never use the source's trailing average or p50/p99 for a bracket;
percentiles remain snapshot-only. Any hidden interval, pending/unsupported
calibration, stopped collection, missing frame source, or relevant observation
loss anywhere inside the bracket keeps it incomplete even if the page resumes
or calibration becomes valid before its end. Preserve the full reason set.

Counter deltas are cumulative, include counters created during the bracket, and
omit unchanged zero deltas. Gauges are not differenced. Ring eviction alone does
not invalidate exact cumulative counters; if a calculation depends on evicted
samples, it reports `HistoryLost`. RPC correlation overflow is integration-owned
`ObservationLost`, not manufactured zero errors or latency. Source-specific
availability/loss must also be checked before gates over that source; frame
completeness does not prove that heap, fibers, or RPC were configured.

```ts
const measurement = yield * meters.headless.endMeasure({ handle, settleFrames: 5 })
if (measurement._tag !== 'Complete') {
  // Fail/skip the gate explicitly with measurement.reasons; never pass it.
} else {
  // Apply thresholds to measurement.data only after source eligibility checks.
}
```

An optional scoped automation bridge exposes Promise wrappers around the same
snapshot/begin/end APIs. The host chooses its key, access boundary, and readiness
handshake. Registration is direct and release removes it; no polling decorator,
implicit `__metersEngine`, or counter transport global exists. The bridge is
absent outside its explicitly enabled test scope.

## React Bindings

Trace: DT.MET-R03, R08, R14, R27, R30–R31.

```text
host Effect/React runtime
  -> MetersProvider (scoped session lease)
       +-- useSeries / accessible output (cached external-store selection)
       +-- MeterStrip (renderer attachment only)
       +-- RenderProfiler (host-selected commit instrumentation)
```

```tsx
interface MetersProviderProps<TEnv> {
  readonly meters: Meters<TEnv>
  readonly children: React.ReactNode
}
declare const MetersProvider: <TEnv>(props: MetersProviderProps<TEnv>) => React.ReactNode
declare const useMeters: () => MeterSession
declare const useSeries: <TValue>(series: Series<TValue>) => Sample<TValue>
declare const useSeriesSnapshot: <TValue>(series: Series<TValue>) => SeriesSnapshot<TValue>
interface MeterStripProps {
  readonly meters: MeterSession
  readonly blocks: readonly CanvasBlockSpec[]
  readonly theme: MeterTheme
  readonly frozen: boolean
  readonly onFrozenChange: (frozen: boolean) => void
  readonly onOpenDetail: (selection: { readonly id: string }) => void
  readonly heightPx?: number
  readonly gapPx?: number
  readonly historyMs?: number
  readonly platform?: CanvasPlatform
}
declare const MeterStrip: (props: MeterStripProps) => React.ReactNode
interface RenderProfilerProps {
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
  readonly id: string
  readonly children: React.ReactNode
  readonly onCommit?: (commit: ReactCommit) => void
}
declare const RenderProfiler: (props: RenderProfilerProps) => React.ReactNode
declare const reactCommitsSource: (options: {
  readonly id: string
  readonly series: Series<ReactCommit>
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
}) => Source<ReactCommit>
```

The provider acquires the stable session's `start` through effect-react
mount/runtime primitives and keeps the lease scope alive. Required source
environment is supplied by the host runtime. Definitions and session construction
are outside React render; neither `useMemo` nor a canvas callback owns source
start/stop. StrictMode release/reacquisition uses the serialized session lease;
React remount does not wipe totals. Renderer callback refs acquire only their
attachment and release it on detach. `useSeries` uses the existing Effect/React
external-store binding with revision-cached selectors and returns an unavailable
`NoSamples` sample before evidence exists, not an ambiguous zero.

`MeterStrip` supplies DOM equivalents, focus targets, tooltips, and a separate
compact freeze control (a 24px icon button named "Freeze meters"/"Resume
meters" with `aria-pressed`) around its one canvas. The strip root grows into
the host slot with a zero minimum width. Defaults for presentation dimensions are
32px height, 2px gap, and 10000ms history; these are not defaults for source or
meter selection. Focus shows the keyboard tooltip without opening a panel.
Click and Enter/Space delegate `onOpenDetail({ id })` to the host/devbar;
Escape dismisses the tooltip. Frozen state is controlled independently of the
session and snapshots only that renderer's bounded histories.

`RenderProfiler` wraps `React.Profiler`, increments the supplied monotonic
counter exactly once per commit, and publishes commit fields to the same
instrumentation feed consumed by `reactCommitsSource`. Its optional `onCommit`
is an external fan-out callback, not required for that source to receive data.
The token and profiler ID association is registered explicitly; duplicate
inconsistent associations fail. Registration marks callback capability only
when the host uses a supported dev/profiling build and the Profiler is mounted;
missing instrumentation/build support yields `NotConfigured`, not a guaranteed
zero. Counts describe subtree commits, never every component function invocation
or scheduler priorities. No Profiler mounts through a disabled enabling boundary.

## Clean Migration

Trace: DT.MET-R33; parent DT-R24.

| Legacy API/behavior                                                                                                | Replacement and required caller change                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppVitals({ blocks, exposeGlobally, engineRef })`                                                                 | Host enabling boundary + explicit `MetersProvider`/`MeterStrip`; direct session reference and optional scoped automation bridge; separate freeze action               |
| `MeterGrid` owns engine and per-grid history                                                                       | `MeterStrip` reads session-owned SeriesStore and attaches a renderer; multiple strips share one clock; standalone use remains supported                               |
| `MeterBlockFn` combines `getFrameValue`, sentinels, and drawing                                                    | `Source` + opaque typed `Series` + render-only `block`; sampling never depends on draw sizing or placeholder factory arguments                                        |
| `makeFpsMeterBlock` / `makeFiberBlock`                                                                             | `frameSource` / `fibersSource` plus matching render blocks; host enables runtime metrics and supplies context explicitly                                              |
| `makeCounterBlock`                                                                                                 | Declared counter/gauge source or explicitly cadenced reader plus numeric threshold block; semantic theme roles replace literal threshold colors                       |
| `makeValueMeterBlock` / `makePolyValueMeterBlock`                                                                  | Typed series plus single/stacked renderer; tagged unavailable/gaps replace `FRAME_MISS` and uninitialized numeric sentinels; time bins replace FPS-sized arrays       |
| `makeReactRenderBlock`                                                                                             | Actual Profiler commit source; any host scheduler-priority events are a separately explicit source, never inferred from Profiler                                      |
| `RenderProfiler` / `makeRenderProfilerBlock`                                                                       | `/react` Profiler receives injected instrumentation/token; commit source and bracket read the same monotonic counter                                                  |
| `DebugBag`, augmentation, `getDebug`, `setDebug`, `incrDebug`, `resetDebug`, `snapshotDebug`, `globalThis.__debug` | Explicit typed instrumentation service with distinct `counter.add` and `gauge.set`; no global transport, declaration merging, reset-on-read, or compatibility aliases |
| `createMetersEngine`, `MetersEngine.start/stop/reset/dispose`, old `/headless` engine                              | `makeMeters` + scoped lease; fresh session is reset boundary; retain bracket names with Effect/named arguments; Promise conversion only at automation boundary        |
| `MeasurementResult.debugDelta`                                                                                     | `counterDelta`; tagged Complete/Incomplete and eligibility checks; bracket totals never use trailing-window quantiles                                                 |
| `exposeGlobally`, `METERS_ENGINE_GLOBAL_KEY`, polling `withEngineTap`                                              | Explicit scoped host-selected test bridge and direct readiness registration; no automatically published handle                                                        |
| Hover-only pause                                                                                                   | Separate controlled freeze of a bounded renderer snapshot with keyboard/pointer parity                                                                                |
| Devbar independent `FpsMeter`, `persist`, `storageKey`                                                             | Shared frame source/store; controlled `openPanel`/`onOpenPanelChange`; host owns storage and dynamic-import policy                                                    |
| Meters RPC/explorer adapter idea                                                                                   | `@overeng/rpc-devtools/core`; meters core and source entrypoints import no RPC packages                                                                               |

Migration replaces all affected callers, examples, tests, and old exports in one
clean contract cutover. There are no deprecated re-exports or global shims.
The package README distinguishes the current legacy implementation from this
target contract until implementation cutover; this documentation change does
not claim those code exports already changed. Old package-local VRS files are
removed to avoid two normative meter designs.

## Conformance

Trace: DT.MET-R34 and [parent verification](../spec.md#conformance-evidence).

| Test family       | Required observations                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injected platform | Deterministic ticks, cancellation, source-before-draw order, no factory/import work                                                                                                           |
| Frame calibration | 60/120/144/160/240, strict tolerance, unsupported/pending, refresh change rebasing, hidden gaps and no hidden missed-frame burst                                                              |
| Storage           | O(1) bounded append, overflow/range metadata, independent readers, immutable snapshot identity, custom payload typing                                                                         |
| Lifecycle         | One collector per source/one clock across multiple readers, last-release cleanup, single-flight probes, discarded late results, serialized StrictMode reacquisition                           |
| Brackets          | Cumulative deltas, defaults 0/30 settlement, JSON handle validation, duplicate/modified/cross-session rejection, original work failure preserved, incomplete hidden/calibration/loss outcomes |
| Built-ins         | Capability detection, distinct LoAF/fallback, heap versus app-memory, disabled metric n/a, exact completion/commit counters beyond ring capacity, no RPC imports or diagnostic sockets        |
| Renderers         | Fractional DPR, sizing changes, timestamp history, value/text parity, semantic themes, keyboard tooltips/detail action, bounded freeze without collection pause                               |
| Disabled host     | No loader/module/runtime/rAF/timer/observer/listener/hook/metric starts and no diagnostic production graph, as defined by the parent                                                          |

## Open Design Questions

None. Capability uncertainty is represented by the sample/result contracts,
not unresolved implementation behavior.
