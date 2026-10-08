import { Effect } from 'effect'

import { browserEnvironment, type BrowserEnvironment } from '../../platform/browser.ts'
import type { Sample, Series, SeriesWriter } from '../../series/index.ts'
import { runInterval, type FrameClock } from '../../session/clock.ts'
import { makeSource, type Source, type SourceError } from '../../session/source.ts'

/** Approximate, non-standard shared JS heap; not total application memory. */
export interface HeapMemory {
  readonly _tag: 'HeapMemory'
  readonly usedBytes: number
  readonly totalBytes: number
  readonly limitBytes: number
  readonly approximate: true
}
/** User-agent-specific application memory, available only through explicit probes. */
export interface AppMemory {
  readonly _tag: 'AppMemory'
  readonly bytes: number
}
/** Explicit detail-panel probe; acquisition itself never measures app memory. */
export interface AppMemoryProbe {
  readonly source: Source<AppMemory>
  readonly probe: Effect.Effect<Sample<AppMemory>, SourceError>
}

/** Sample approximate JS heap on a scoped, visible single-flight interval. */
export const heapSource = (options: {
  readonly id: string
  readonly series: Series<HeapMemory>
  readonly everyMs: number
  readonly browser?: () => BrowserEnvironment
}): Source<HeapMemory> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Interval', everyMs: options.everyMs },
    start: ({ sink, clock }) =>
      Effect.gen(function* () {
        const browser = (options.browser ?? browserEnvironment)()
        if (browser.performance?.memory === undefined) {
          sink.append({ sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'Unsupported' } })
          return
        }
        yield* runInterval({
          clock,
          everyMs: options.everyMs,
          observe: Effect.sync(() => {
            const memory = browser.performance?.memory
            const atMs = clock.now()
            if (memory === undefined) {
              sink.append({ sample: { _tag: 'Unavailable', atMs, reason: 'Unsupported' } })
            } else if (
              Number.isFinite(memory.usedJSHeapSize) === false ||
              memory.usedJSHeapSize < 0 ||
              Number.isFinite(memory.totalJSHeapSize) === false ||
              memory.totalJSHeapSize < 0 ||
              Number.isFinite(memory.jsHeapSizeLimit) === false ||
              memory.jsHeapSizeLimit < 0
            ) {
              sink.append({ sample: { _tag: 'Unavailable', atMs, reason: 'MeasurementFailed' } })
            } else {
              sink.append({
                sample: {
                  _tag: 'Value',
                  atMs,
                  value: {
                    _tag: 'HeapMemory',
                    approximate: true,
                    usedBytes: memory.usedJSHeapSize,
                    totalBytes: memory.totalJSHeapSize,
                    limitBytes: memory.jsHeapSizeLimit,
                  },
                },
              })
            }
          }),
        })
      }),
  })

/** Create an opt-in, single-flight app-memory probe without changing isolation headers. */
export const appMemoryProbe = (options: {
  readonly id: string
  readonly series: Series<AppMemory>
  readonly browser?: () => BrowserEnvironment
}): AppMemoryProbe => {
  type Lease = {
    readonly sink: SeriesWriter<AppMemory>
    readonly clock: FrameClock
    active: boolean
  }
  type Result = { readonly sample: Sample<AppMemory>; readonly cause?: Error }
  let lease: Lease | undefined
  let flight:
    | { readonly lease: Lease; readonly promise: Promise<Result>; published: boolean }
    | undefined
  const source = makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    start: ({ sink, clock }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const acquired: Lease = { sink, clock, active: true }
          const browser = (options.browser ?? browserEnvironment)()
          const reason =
            browser.crossOriginIsolated !== true
              ? 'NotIsolated'
              : browser.isSecureContext !== true ||
                  browser.performance?.measureUserAgentSpecificMemory === undefined
                ? 'Unsupported'
                : undefined
          if (reason !== undefined)
            sink.append({ sample: { _tag: 'Unavailable', atMs: clock.now(), reason } })
          lease = acquired
          return acquired
        }),
        (acquired) =>
          Effect.sync(() => {
            acquired.active = false
            if (lease === acquired) lease = undefined
          }),
      ).pipe(Effect.asVoid),
  })
  const probe: AppMemoryProbe['probe'] = Effect.suspend(() => {
    const current = lease
    if (current === undefined)
      return Effect.succeed({ _tag: 'Unavailable', atMs: 0, reason: 'NotConfigured' } as const)
    const existing = flight
    if (existing !== undefined && existing.lease !== current) {
      return Effect.promise(() => existing.promise).pipe(Effect.flatMap(() => probe))
    }
    const browser = (options.browser ?? browserEnvironment)()
    const performance = browser.performance
    const unavailable =
      browser.crossOriginIsolated !== true
        ? 'NotIsolated'
        : browser.isSecureContext !== true ||
            performance?.measureUserAgentSpecificMemory === undefined
          ? 'Unsupported'
          : undefined
    if (
      unavailable !== undefined ||
      performance === undefined ||
      performance.measureUserAgentSpecificMemory === undefined
    ) {
      const sample: Sample<AppMemory> = {
        _tag: 'Unavailable',
        atMs: current.clock.now(),
        reason: unavailable ?? 'Unsupported',
      }
      current.sink.append({ sample })
      return Effect.succeed(sample)
    }
    let running = existing
    if (running === undefined) {
      const promise: Promise<Result> = Promise.resolve()
        .then(() => performance.measureUserAgentSpecificMemory?.())
        .then(
          (measurement): Result => ({
            sample:
              measurement !== undefined &&
              Number.isFinite(measurement.bytes) === true &&
              measurement.bytes >= 0
                ? {
                    _tag: 'Value',
                    atMs: current.clock.now(),
                    value: { _tag: 'AppMemory', bytes: measurement.bytes },
                  }
                : { _tag: 'Unavailable', atMs: current.clock.now(), reason: 'MeasurementFailed' },
          }),
          (cause: unknown): Result => {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            return {
              cause: error,
              sample: {
                _tag: 'Unavailable',
                atMs: current.clock.now(),
                reason:
                  error.name === 'SecurityError' || error.name === 'NotAllowedError'
                    ? 'PermissionDenied'
                    : 'MeasurementFailed',
              },
            }
          },
        )
      running = { lease: current, promise, published: false }
      flight = running
      // A browser probe cannot be cancelled; retain single-flight ownership until it settles.
      void promise.then(() => {
        if (flight?.promise === promise) flight = undefined
      })
    }
    const acquiredFlight = running
    return Effect.promise(() => acquiredFlight.promise).pipe(
      Effect.tap((result) =>
        result.cause === undefined
          ? Effect.void
          : Effect.logError('App memory probe failed', result.cause),
      ),
      Effect.map((result) => {
        if (current.active === true && acquiredFlight.published === false) {
          acquiredFlight.published = true
          current.sink.append({ sample: result.sample })
        }
        return result.sample
      }),
    )
  })
  return { source, probe }
}
