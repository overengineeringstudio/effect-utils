# Meters Spec

This document specifies `@overeng/meters`. It builds on
[requirements.md](./requirements.md).

Status: **Draft**.

## Scope

This spec defines sources, cadence, typed series/history, session acquisition,
frame bookkeeping, instrumentation, renderers, React bindings, headless gates,
and public surface invariants. Package composition and common identifier rules belong to
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
  +-- /react                 provider/hooks/strip/tile/text/tooltips/panel/Profiler
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
declare const bucketSeries: <TValue>(options: {
  readonly history: SeriesView<TValue>
  readonly endMs: number
  readonly bucketMs: number
  readonly buckets: number
  readonly mode: 'Gauge' | 'Event' | 'Counter'
  readonly value: (value: TValue) => number
}) => readonly (number | undefined)[]
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

Trace: DT.MET-R03, R29–R32, R35; parent Q1/Q7.

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
type BlockAggregation =
  | { readonly _tag: 'Latest' }
  | {
      readonly _tag: 'Bucket'
      readonly mode: 'Gauge' | 'Event' | 'Counter'
      readonly bucketMs: number
      readonly buckets: number
      readonly unit: Unit
    }
type BlockAggregationEvidence =
  | { readonly _tag: 'Latest' }
  | (Extract<BlockAggregation, { readonly _tag: 'Bucket' }> & { readonly endMs: number })
declare const resolveBlockAggregation: (options: {
  readonly aggregation?: BlockAggregation
  readonly nowMs: number
}) => BlockAggregationEvidence
interface BlockEvidence {
  readonly label: string
  readonly unit: Unit
  readonly text: string
  readonly evaluatedAtMs: number
  readonly revision: number
  readonly latest:
    | { readonly _tag: 'Value'; readonly atMs: number }
    | {
        readonly _tag: 'Unavailable'
        readonly atMs: number
        readonly reason: UnavailableReason
      }
    | {
        readonly _tag: 'Gap'
        readonly atMs: number
        readonly durationMs: number
        readonly reason: Extract<Sample<never>, { readonly _tag: 'Gap' }>['reason']
      }
    | undefined
  readonly retention: Retention
  readonly aggregation: BlockAggregationEvidence
  readonly range?: BlockEvidenceRange // only blocks that reduce a window and have a value in it
}
interface BlockEvidenceRange {
  readonly windowMs: number
  readonly endMs: number
  readonly minimum: number
  readonly maximum: number
}
interface BlockReader {
  readonly revision: () => number
  readonly describe: (options: { readonly nowMs: number }) => string
  readonly evidence: (options: { readonly nowMs: number }) => BlockEvidence
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
  readonly label: string // full label: accessible description, output, and tooltip
  readonly shortLabel?: string // compact canvas fallback and accessible-name prefix
  readonly widthPx: number // nominal width; shrinks only when the slot is too small
  readonly read: (store: SeriesStore) => BlockReader // opaque typed draw/describe/snapshot closures
}
declare const block: <TValue>(options: {
  readonly id: string
  readonly series: Series<TValue>
  readonly widthPx: number
  readonly aggregation?: BlockAggregation
  readonly draw: (input: DrawInput<TValue>) => void
  readonly describe: (input: {
    readonly history: SeriesView<TValue>
    readonly nowMs: number
  }) => string
  readonly range?: (input: {
    readonly history: SeriesView<TValue>
    readonly nowMs: number
  }) => BlockEvidenceRange | undefined // on-demand evidence only, never drawn
}) => CanvasBlockSpec
declare const makeStripView: (options: {
  readonly store: SeriesStore
  readonly blocks: readonly CanvasBlockSpec[]
  readonly now: () => number
  readonly frozenAtMs?: number
}) => StripView
interface MeterFreeze {
  readonly atMs: number
  readonly view: (id: string) => StripView | undefined // single-block frozen view
}
declare const freezeMeters: (options: {
  readonly meters: MeterSession
  readonly blocks: readonly CanvasBlockSpec[]
}) => MeterFreeze
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
out by measurement, in this order: full label + full value, `shortLabel` + full
value, full value alone, compact value alone (rounded to an integer in the same
displayed unit, without the unit separator), then that integer without its unit.
Only after none of these fits may the value be ellipsized, down to an ellipsis
alone if necessary. Labels are never truncated or restored beside compact
values. The value stays right-aligned; label and value never overlap, and text is
never squeezed through a `fillText` maximum width. Full labels and unabridged
values remain available through accessible outputs and tooltips.
ResizeObserver and DPR change signals are acquired with the renderer scope;
sizing/theme resolution happens on changes, not per frame. Strip attachment
uses the session clock and never creates a per-grid engine.

History bins are based on timestamps: event counters aggregate per time bin,
gauges hold the last observation with age/staleness shown, and missed/hidden
intervals have explicit gap rendering. Unsupported values draw `n/a` with a
reason. DPR changes do not change the time horizon. Token resolution is a host
adapter; devbar maps StyleX tokens to `MeterTheme` or semantic CSS variables.
Meters imports no StyleX and does no per-frame `getComputedStyle`.

The pure core `bucketSeries` accepts live or frozen `SeriesView` inputs. Its
chronological bins end at `start + ((bin + 1) * span) / buckets`. Gauge holds
the latest observation; Event sums observations in `(end - bucketMs, end]`;
Counter sums positive deltas with zero for the first value and resets after
non-values. Aggregates saturate at finite extrema. A missing observation or a
latest Gap/Unavailable yields `undefined`; an observed empty Event/Counter bin
yields zero. Partial bins use actual observations, never fabricated history
before the retained range. Invalid finite-window/duration/count arguments throw
`TypeError`, including non-finite derived starts or the endpoint formula's
multiplication intermediate. The helper allocates only its result array; canvas shares the
internal streaming scan without materializing bin arrays. Existing omitted-range
canvas scaling and unsaturated aggregation remain unchanged.

`BlockReader.evidence({ nowMs })` evaluates the bound reader's unabridged
`describe({ nowMs })` text, output unit, typed latest metadata and retention.
`evaluatedAtMs` is exactly the supplied evaluation time. `latest.atMs` is the
timestamp of the latest typed evidence, which may be a synthetic state
transition rather than a measurement; it must not be interpreted as measurement age.
Metadata projects only declared tag/timestamp/reason/gap duration, never extra
payload fields. Evidence performs no store lookup, subscription or caching.

Aggregation defaults to `Latest` with the series unit. An optional `Bucket`
policy specifies mode, duration, count and explicit output unit. The pure
`resolveBlockAggregation` derives its completed endpoint as
`floor(nowMs / bucketMs) * bucketMs` on the session clock and validates finite
positive dimensions and representable derived endpoints. Its horizon is
`buckets * bucketMs`, independent of strip `historyMs`. It allocates no bucket
array. Future block descriptions/drawers and evidence share this endpoint
calculation; actual bin reduction remains the shared internal scan. There is
no implicit rate normalization: a 1000ms Event bucket with `value: () => 1`
counts frame observations, rather than summing raw FPS. `bucketSeries` itself
continues to honor its explicit endpoint without alignment.

**BREAKING CHANGE:** Custom `block.describe` now accepts `{ history, nowMs }`,
bound `reader.describe` requires `{ nowMs }`, and `makeStripView` requires
`now: meters.clock.now`. Numeric strings and MeterStrip accessible names are
unchanged. Strip snapshots recompute text at the existing 250ms presentation
publication even without a new sample, retaining the old array when every
string is equal. Subscribed reads return the last published array;
unsubscribed reads evaluate against the injected clock. No new timer or
subscription chain is introduced.

`reader.snapshot()` still copies only bounded history, not time. Every reader
method honors its supplied `nowMs`. A frozen StripView evaluates descriptions
with `frozenAtMs ?? now()`; canvas drawing uses `frozenAtMs ?? tick.atMs`.
A consumer evaluating evidence for that view must pass the same view time.
Actual capture time and frozen-view metadata belong to that consumer, not to
the bound reader.

### Shared numeric plot domains

`@overeng/meters/canvas` exports `PlotRange = { readonly lo: number; readonly hi: number }`,
`plotRange({ history, nominalMax, mode, minSpanRatio? })`, and
`formatRange({ range, unit })`. History is `readonly (number | undefined)[]`;
missing and nonfinite observations do not participate in the range. Both scale
options must be finite and positive (`minSpanRatio` defaults to `0.1`).
Invalid scale options or custom bounds throw `TypeError`, consistently with
the other pure canvas helpers.

| Mode / input                    | Domain                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Empty or no finite observations | `[0, ceil(nominalMax)]`                                                                           |
| `fixed`                         | `[min(0, minimum), ceil(max(nominalMax, maximum))]`                                               |
| `auto`, finite observations     | Span `max(maximum - minimum, nominalMax * minSpanRatio) * 1.15`, centered on the extrema midpoint |
| Nonnegative auto history        | Clamp the lower endpoint to zero, then add the span                                               |
| Negative or mixed auto history  | Retain both extrema without a zero clamp                                                          |

The fixed upper bound rounds to a whole value in the input unit, not a
second nice-step scheme. Padding arithmetic saturates at finite numeric limits;
extrema always remain included. At large constant values where padding rounds
away, use the zero-inclusive domain instead. Bounds remain finite and strictly
increasing even for opposite `Number.MAX_VALUE` extrema or subnormal scales.
`formatRange` validates finite increasing bounds and joins the independently
`formatMeterValue`-formatted endpoints with an en dash, including each endpoint's
unit (for example `0 ms–302 ms` or `0 B–1.0 KiB`).

All numeric block builders accept `range?: 'auto' | 'fixed' | PlotRange`,
`nominalMax?: number` (default `1`, in series units), `minSpanRatio?: number`,
and `marks?: readonly number[]`. Omitted `range` preserves the original
zero-baseline scale and default rendering. Explicit policies use the shared
range calculation on the values drawn in the current time window (held gauge
values or timestamp-bin event/counter aggregates); they do not rescale the
formatted current reading. Aggregate overflow saturates at finite limits for
explicit policies. Custom bounds must be finite with `hi > lo`; out-of-domain
bars are clipped to the chart, never into its header. Explicit-domain drawing
normalizes endpoints before subtraction to avoid overflowing the span.

Marks use the same original series units and domain as bars, not formatted
display units. Only finite marks within the inclusive plotted domain draw:
one CSS-pixel horizontal line in `theme.border`, with no label or acquisition
behavior. Hosts use the same helper/domain for captions and axes; custom bounds
can be passed unchanged to both `formatRange` and a block.

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

### Tile blocks

Trace: DT.MET-R35; parent DT-R02, DT-R14.

```ts
type TileAggregation = Extract<BlockAggregation, { readonly _tag: 'Bucket' }>
declare const tileBlock: <TValue>(
  options: PlotOptions & {
    readonly id: string
    readonly series: Series<TValue>
    readonly shortLabel?: string
    readonly widthPx: number
    readonly aggregation: TileAggregation
    readonly value: (value: TValue) => number
  },
) => CanvasBlockSpec
```

`tileBlock` is the canvas half of a Tile: an ordinary `CanvasBlockSpec`, so a
tile reuses `makeStripView`, `makeCanvasStrip`, the session clock, and frozen
snapshots with a single block. Its required `Bucket` policy is validated at
construction before any buffer is sized. Draw and describe reduce the bound
history with the shared internal scan at the supplied time, with exactly the
`bucketSeries` semantics: the horizon is `buckets * bucketMs`, independent of
strip `historyMs`, ending at the newest completed bucket. The full value text
formats the newest bucket in the policy unit; an undefined newest bucket reads
`n/a (NoSamples)`, `n/a (<reason>)`, `n/a (<reason> gap)` from the newest
observation it covers, or `n/a (MeasurementFailed)` for a non-finite value.
Compact and number forms of an undefined bucket are a bare `n/a`, so the canvas
shows `n/a` and the reason stays in the description and evidence. Evidence adds
`range`: the minimum and maximum of the defined buckets over `windowMs =
buckets * bucketMs` ending at the completed `endMs`, absent when none is defined.

The chart uses the numeric block geometry and the shared plot-range policy,
marks and `theme.border` baseline. History is a `theme.normal` 1.5px polyline
through bucket centers; undefined buckets break the line and an isolated
bucket draws a 2px dot. Reduction writes into one `Float64Array` per bound
history, allocated on first read and reused for every later frame: live readers
of a definition share the store's live view scratch, and each frozen snapshot
owns its own. A value callback that reads the reader being reduced throws
`TypeError` rather than overwriting bins mid-scan.

The drawn label is `shortLabel ?? label` and is the tile's static accessible
name, so it outranks the value: the value then tries full, compact and number
forms, and is ellipsized last. `widthPx` must fit the label plus 8px padding; a
narrower rect draws an ellipsized prefix of the name and no value, never a
clipped or `fillText`-squeezed label. The unabridged value remains available
through on-demand evidence.

## Headless Snapshots and Measure Brackets

Trace: DT.MET-R17–R21; parent DT-R15 and Q11.

```text
caller Scope -> detachable measurement child Scope -> cumulative baselines
  -> host work / automation
  -> Measurement.end -> atomic claim -> optional visible-frame settle
       +-- Complete: eligible measured bracket
       +-- Incomplete: partial evidence + reasons, gate ineligible
  -> Scope closure: abandon unended resource and cancel pending settlement
```

```ts
import { Effect, Schema, Scope } from 'effect'

interface Snapshot {
  readonly sessionId: string
  readonly generation: number
  readonly timeOriginMs: number
  readonly atMs: number
  readonly frames: Sample<FrameStats>
  readonly retention: readonly { readonly id: string; readonly range: Retention }[]
  readonly counters: Readonly<Record<string, number>>
}
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const SettlementFrames = Schema.Natural.annotate({ identifier: 'Meters.SettlementFrames' })
const UnavailableReason = Schema.Literals([
  'Unsupported',
  'NotConfigured',
  'NotIsolated',
  'PermissionDenied',
  'MeasurementFailed',
  'NoSamples',
  'Hidden',
  'HistoryLost',
  'CalibrationInvalid',
  'Stopped',
])
const NumberValue = Schema.TaggedStruct('Number', { value: Schema.Finite })
const NumberSample = Schema.Union([
  Schema.TaggedStruct('Value', { atMs: Schema.Finite, value: NumberValue }),
  Schema.TaggedStruct('Unavailable', { atMs: Schema.Finite, reason: UnavailableReason }),
  Schema.TaggedStruct('Gap', {
    atMs: Schema.Finite,
    durationMs: NonNegativeFinite,
    reason: Schema.Literals(['MissedFrame', 'Hidden', 'Overflow']),
  }),
])
const CounterDelta = Schema.Record(Schema.String, NonNegativeFinite)
const CompleteData = Schema.Struct({
  durationMs: NonNegativeFinite,
  framesCaptured: Schema.Natural,
  frameDrops: Schema.Natural,
  averageFps: Schema.Natural,
  counterDelta: CounterDelta,
}).annotate({ identifier: 'Meters.CompleteData' })
type CompleteData = typeof CompleteData.Type
const PartialData = Schema.Struct({
  durationMs: NonNegativeFinite,
  framesCaptured: Schema.Natural,
  frameDrops: NumberSample,
  averageFps: NumberSample,
  counterDelta: CounterDelta,
}).annotate({ identifier: 'Meters.PartialData' })
type PartialData = typeof PartialData.Type
const IncompleteReason = Schema.Literals([
  'Hidden',
  'CalibrationInvalid',
  'Stopped',
  'NoSamples',
  'NotConfigured',
  'HistoryLost',
  'ObservationLost',
]).annotate({ identifier: 'Meters.IncompleteReason' })
type IncompleteReason = typeof IncompleteReason.Type
const MeasureResult = Schema.Union([
  Schema.TaggedStruct('Complete', {
    eligible: Schema.Literal(true),
    data: CompleteData,
  }),
  Schema.TaggedStruct('Incomplete', {
    eligible: Schema.Literal(false),
    reasons: Schema.NonEmptyArray(IncompleteReason),
    data: PartialData,
  }),
]).annotate({ identifier: 'Meters.MeasureResult' })
type MeasureResult = typeof MeasureResult.Type

class MeasureError extends Schema.TaggedError<MeasureError>()(
  'MeasureError',
  {
    reason: Schema.Literals([
      'NotRunning',
      'StaleGeneration',
      'AlreadyEnded',
      'ScopeClosed',
      'InvalidOptions',
    ]),
    message: Schema.String,
  },
  { identifier: 'Meters.MeasureError' },
) {}

interface Measurement {
  readonly end: (options?: {
    readonly settleFrames?: number
  }) => Effect.Effect<MeasureResult, MeasureError>
}
interface Headless {
  readonly snapshot: () => Snapshot
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly measurement: Effect.Effect<Measurement, MeasureError, Scope.Scope>
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

`Measurement` is an executable, scope-owned capability bound to its acquiring
session, not serializable identity data. Each acquisition captures cumulative
before-totals and visibility/calibration/source-loss markers in a detachable child
scope forked from the caller's scope. Its state is atomically claimed:

```text
Open -> Settling -> Ended
Open -> ScopeClosed
Open -> StaleGeneration (session restart)
Settling -> Ended (success, incomplete result, or end interruption)
Settling -> consumed + pending caller fails ScopeClosed (owning scope closes)
```

Only one valid `end` claims a resource. Concurrent and subsequent calls fail
`AlreadyEnded`, including calls while settlement is pending or after interrupted
end. Validate settlement before claiming; `InvalidOptions` leaves an open
resource available for retry. An unended resource escaped from a closed scope
fails `ScopeClosed`; restart invalidates still-open prior-generation resources
with `StaleGeneration`. A capability always observes its acquiring session, even
when passed to code that also owns another session. No caller-supplied baseline or
session identity participates in its authority.

The session tracks only live open/settling controls. Explicit end, abandonment,
and invalidation clear retained baseline/frozen evidence, unregister the control,
and close/detach the child scope. Completed results belong to callers, not a
completed-result registry or resource closure. Sequential measurements inside a
long-lived parent scope must not accumulate child scopes, finalizers, clock
waiters, or evidence. Retention is proportional to currently owned live resources
and their baseline counter count, plus the existing bounded source rings.

| Operation         | Default settlement | Semantics                                                                                                                                                                         |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measurement`     | None               | Requires a running lease; captures baselines even during pending calibration, preserving that incompleteness                                                                      |
| `Measurement.end` | 0 frames           | Validates options, claims once, settles, and captures after-totals; settlement extends the measured interval                                                                      |
| `measureWindow`   | 30 frames          | Validates options before acquiring or executing work; scopes acquisition, work, and end; failure/defect/interruption abandons without settlement and preserves the original Cause |

Settlement count is a finite nonnegative integer. Actual visible frames, not a
timeout or wall-clock delay, determine settlement. Hidden/stopped settlement
returns `Incomplete` promptly. Scope closure actively wakes/cancels pending end
with `ScopeClosed`; end interruption cancels its clock waiter and consumes the
resource. Cleanup is non-waiting and cannot mask the original work failure.

Measurements do not acquire an extra session lease or prolong collection.
On last-lease release, deactivate collection and record stopped evidence, then
freeze every live resource's endpoint/counter totals before releasing collector
sources. Pending end returns `Incomplete(Stopped)` from that frozen endpoint;
an open resource remains endable with partial evidence until end, scope closure,
or restart. Releasing a non-last lease does not affect measurements. Acquiring
while stopped fails `NotRunning`. A new first lease invalidates still-open
prior-generation resources before new collection starts; check generation at
claim and before any unfrozen post-settlement capture. Results already delivered
or terminalized at stop remain valid immutable evidence of that generation.

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
const gate = Effect.gen(function* () {
  const bracket = yield* meters.headless.measurement
  yield* hostWork
  const measurement = yield* bracket.end({ settleFrames: 5 })
  if (measurement._tag !== 'Complete') {
    return { eligible: false, reasons: measurement.reasons }
  }
  return applyThresholdsAfterSourceEligibilityChecks(measurement.data)
}).pipe(Effect.scoped)
```

The `/headless` entrypoint exports `CompleteData`, `PartialData`,
`IncompleteReason`, `SettlementFrames`, and `MeasureResult` value schemas with
their derived types, and the `MeasureError` tagged-error schema/class with a
structured reason and contextual message. Durations and counter deltas are
finite and nonnegative; captured/dropped frame counts and complete average FPS
are natural numbers. Partial number values and sample timestamps are finite;
tagged unavailable/gap observations preserve their declared reasons.
The result union fixes `Complete.eligible` to `true` and `Incomplete.eligible`
to `false`; incomplete reasons are nonempty. Schemas reject tag/eligibility
disagreement, invalid numeric evidence, and unknown reason/tag values rather
than repairing them. Settlement decoding uses `SettlementFrames` and maps
schema failure to `InvalidOptions`, without silently clamping values. Schema annotations
use the repository-local `Meters.*` namespace. Encode with
`Schema.encodeEffect(MeasureResult)` and decode untrusted transport data with
`Schema.decodeUnknownEffect(MeasureResult)` using the pinned Effect 4 APIs;
the same boundary rule applies to `MeasureError`. `Measurement` has no wire schema.

An optional scoped automation bridge owns browser-local scopes and resources.
`acquireMeasurement(): Promise<string>` creates a resource and registers it under
a bridge-issued opaque token. `finishMeasurement({ token, settleFrames? })`
resolves that browser-local entry, invokes `Measurement.end`, encodes its result,
and closes the resource scope after a claimed end. Invalid options leave the
token/resource retryable. Tokens are bridge-local lookup keys, not serialized core
capabilities; unknown or consumed tokens fail explicitly and cannot designate
another bridge's resource. The host may perform locator interactions between
acquisition and finish; no serialized callback protocol is required. Snapshot
wrappers use the same session. The host chooses the access boundary and readiness
handshake. Registration is direct; release unregisters the bridge, abandons all
open resources, cancels pending settlement, and prevents late publication.
No polling decorator, implicit browser global, or counter transport is installed;
the bridge is absent outside its explicitly enabled test scope.

## React Bindings

Trace: DT.MET-R03, R08, R14, R27, R30–R31, R35–R36.

```text
host Effect/React runtime
  -> MetersProvider (scoped session lease)
       +-- useSeries / accessible output (cached external-store selection)
       +-- MeterStrip (renderer attachment only)
       +-- MeterTile (one canvas per block + captured MeterEvidence card)
       +-- MeterFreezeButton (host-owned shared MeterFreeze)
       +-- MetersPanel (controlled meter list + host-rendered detail; no lease)
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
interface MetersPanelProps {
  readonly blocks: readonly CanvasBlockSpec[]
  readonly theme: MeterTheme
  readonly selected: string | undefined
  readonly onSelect: (selection: { readonly id: string }) => void
  readonly renderDetail: (block: CanvasBlockSpec) => React.ReactNode
}
declare const MetersPanel: (props: MetersPanelProps) => React.ReactNode
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
type MeterEvidenceTrigger = 'Focus' | 'Hover' | 'Activation' | 'Refresh'
interface MeterEvidenceProps {
  readonly id: string
  readonly evidence: BlockEvidence
  readonly trigger: MeterEvidenceTrigger
  readonly frozen: boolean
  readonly theme: MeterTheme
  readonly style?: React.CSSProperties
}
declare const MeterEvidence: (props: MeterEvidenceProps) => React.ReactNode
interface MeterTileProps {
  readonly meters: MeterSession
  readonly block: CanvasBlockSpec // usually a tileBlock
  readonly theme: MeterTheme
  readonly frozen?: MeterFreeze // absent: live
  readonly heightPx?: number // default 32
  readonly platform?: CanvasPlatform
}
declare const MeterTile: (props: MeterTileProps) => React.ReactNode
interface MeterFreezeButtonProps {
  readonly frozenAtMs: number | undefined
  readonly onToggle: () => void
  readonly theme: MeterTheme
  readonly compact?: boolean // icon only; the accessible name is unchanged
}
declare const MeterFreezeButton: (props: MeterFreezeButtonProps) => React.ReactNode
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

Each meter button's accessible name is `${shortLabel ?? label} ${text}`, beginning
with the visible label and the same formatted value as the canvas. A persistent,
visually hidden description with a strip-unique generated ID is referenced by
`aria-describedby`; it carries the full series label, unabridged value (including
availability reasons), configured history span, and detail action. The description
is separate from the hover/focus tooltip and remains associated when the tooltip
is absent or dismissed. Full-label DOM outputs remain available independently.

`MeterTile` renders one block as a native `<button>` wrapping one canvas,
attached with `makeCanvasStrip` to a single-block view, so every tile draws in
the session clock's shared Draw phase and no tile owns a frame loop (R35). Its
accessible name is the drawn label `shortLabel ?? label` and its title is the
full `label`; neither ever contains a value. A sample causes no DOM write and no
React commit: the tile does not subscribe to the store. One `captured` state
(`{ trigger, evidence }`) is the only per-tile state. Focus, hover, activation
(click, Enter, Space) and `R` capture `reader.evidence({ nowMs })` at the session
clock, or at `MeterFreeze.atMs` when frozen; activation is the explicit refresh
and opens no panel. The captured snapshot feeds `MeterEvidence`, rendered in a
manual popover (top layer, so host scrollports do not clip it) placed above the
tile and referenced by `aria-describedby` while shown. Blur, leaving hover
without focus, and Escape dismiss it; the first Escape is consumed, the next
reaches the host. Evidence is never published live or through `aria-live`
(R36).

`MeterEvidence` is pure: its lines derive only from its props. It shows the
full label and value text (or unavailable reason), the newest observation as an
age before evaluation (`latest sample 1.5 s before evaluation`, `unavailable
(<reason>) …`, `gap (<reason>, <duration>) ending …`, or `no sample before
evaluation`), for bucket blocks the evidence `range` as `range over the <window>
before evaluation: min <a> / max <b>` (or `no values`), `evaluated at session
clock <t> · revision <n>` with `(frozen)` for a frozen view, and the capturing
action. Ages are measured from the evaluation instant; the card never says
"ago", "now" or "current".

`freezeMeters` snapshots every given block synchronously at one clock instant;
tiles, their canvases and their cards then read that one `MeterFreeze` while
sources and the clock keep running. A tile's view changes on freeze or unfreeze,
which drops any card captured from the previous view. `MeterFreezeButton` is
the host's single toggle: its accessible name stays "Freeze meters", state is
`aria-pressed`, the title names the frozen clock instant, and `compact` hides the
visible text for narrow hosts.

`MetersPanel` is the shared renderer-only list/detail composition exported from
`/react`. It lists every supplied block in order as a native keyboard-operable
button, exposes the selected button with `aria-pressed`, and associates buttons
with the generated detail container through `aria-controls`. Only the block
matching `selected` is passed to `renderDetail`; clicking a button proposes
`onSelect({ id })` without changing controlled selection. Unknown/absent selection
shows a selection prompt, and an empty list shows "No meters configured."
The host reconciles IDs absent from the current block list, persists selection, and supplies domain-specific
detail content. List and detail scroll independently inside the available panel
slot and use the supplied meter theme. No source lease, canvas attachment,
storage access, RPC routing, or default meter selection is introduced.

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

## Public Surface Invariants

Trace: DT.MET-R33; parent DT-R24.

Sources own acquisition and cadence; blocks own rendering only. A fresh session
is the explicit reset boundary. Instrumentation is injected and distinguishes
monotonic counters from gauges, with non-destructive readers and no global
transport or declaration-merging bag. The public surface has one contract per
operation, with no deprecated aliases or compatibility shims. Automation adapts
Effect at an explicit scoped boundary. Shell state and persistence belong to the
host; meters owns neither RPC domain semantics nor shell storage.

## Conformance

Trace: DT.MET-R34 and [parent verification](../spec.md#conformance-evidence).

| Test family       | Required observations                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injected platform | Deterministic ticks, cancellation, source-before-draw order, no factory/import work                                                                                                                                                                                                                                                                                                                                                                 |
| Frame calibration | 60/120/144/160/240, strict tolerance, unsupported/pending, refresh change rebasing, hidden gaps and no hidden missed-frame burst                                                                                                                                                                                                                                                                                                                    |
| Storage           | O(1) bounded append, overflow/range metadata, independent readers, immutable snapshot identity, custom payload typing                                                                                                                                                                                                                                                                                                                               |
| Lifecycle         | One collector per source/one clock across multiple readers, last-release cleanup, single-flight probes, discarded late results, serialized StrictMode reacquisition                                                                                                                                                                                                                                                                                 |
| Brackets          | Cumulative deltas; defaults 0/30; atomic concurrent/duplicate end; retry after invalid options; escaped scope and restart rejection; original work Cause preserved; hidden/calibration/loss reasons; stop endpoint frozen before source teardown; no live registry/finalizer growth after sequential end; schema round trips and malformed evidence rejection; browser-local bridge token/scope cleanup                                             |
| Built-ins         | Capability detection, distinct LoAF/fallback, heap versus app-memory, disabled metric n/a, exact completion/commit counters beyond ring capacity, no RPC imports or diagnostic sockets                                                                                                                                                                                                                                                              |
| Renderers         | Fractional DPR, sizing changes, timestamp history, value/text parity, semantic themes, keyboard tooltips/detail action, bounded freeze without collection pause, tile draw/describe/`bucketSeries` parity, broken undefined buckets, label-first fitting, tile evidence range, static tile names, zero commits and DOM writes across samples, captured (not live) evidence cards, one shared tile freeze, sub-0.5 ms added frame cost for six tiles |
| Disabled host     | No loader/module/runtime/rAF/timer/observer/listener/hook/metric starts and no diagnostic production graph, as defined by the parent                                                                                                                                                                                                                                                                                                                |

## Open Design Questions

None. Capability uncertainty is represented by the sample/result contracts,
not unresolved implementation behavior.
