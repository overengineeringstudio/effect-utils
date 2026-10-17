import { Effect } from 'effect'

import { browserEnvironment, type BrowserEnvironment } from '../../platform/browser.ts'
import type { Series } from '../../series/index.ts'
import { makeSource, type Source, type SourceError } from '../../session/source.ts'

/** One observed User Timing measure, in session-clock milliseconds. */
export interface UserTimingValue {
  readonly _tag: 'UserTiming'
  readonly name: string
  readonly startedAtMs: number
  readonly durationMs: number
}

/** Which measures a source records: exact names, or every name with a prefix. */
export type UserTimingFilter =
  | { readonly _tag: 'Names'; readonly names: readonly string[] }
  | { readonly _tag: 'Prefix'; readonly prefix: string }

/**
 * Observe `performance.measure()` entries matching `filter` as event samples for the source
 * lease. Buffered measures from before acquisition count once. Each sample is dated at the
 * measure's end mapped onto the session clock, never before the newest recorded sample, so
 * bucket p50/p95 tiles reduce the measured durations. Without `measure` support the series
 * reads `Unsupported`, never a zero duration.
 */
export const userTimingSource = (options: {
  readonly id: string
  readonly series: Series<UserTimingValue>
  readonly filter: UserTimingFilter
  readonly browser?: () => BrowserEnvironment
}): Source<UserTimingValue> => {
  const filter = options.filter
  if (filter._tag === 'Prefix' && filter.prefix.length === 0)
    throw new TypeError('User Timing prefix must be non-empty')
  if (filter._tag === 'Names' && filter.names.length === 0)
    throw new TypeError('User Timing names must be non-empty')
  const names = filter._tag === 'Names' ? new Set(filter.names) : undefined
  const prefix = filter._tag === 'Prefix' ? filter.prefix : ''
  // Shared across leases: a restarted observer replays the whole buffer, so measures ending at
  // or before the previous lease's newest are not recorded again, and timestamps never regress.
  let newestAtMs = 0
  let recordedUntilPerfMs = -Infinity
  return makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    start: ({ sink, clock }) =>
      Effect.gen(function* () {
        const browser = (options.browser ?? browserEnvironment)()
        const Observer = browser.PerformanceObserver
        if (
          Observer === undefined ||
          browser.performance === undefined ||
          Observer.supportedEntryTypes.includes('measure') === false
        ) {
          sink.append({ sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'Unsupported' } })
          return
        }
        const performance = browser.performance
        const acquisitionFailed = (cause: unknown): SourceError => ({
          _tag: 'SourceError',
          sourceId: options.id,
          reason: 'AcquisitionFailed',
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        })
        let active = true
        const replayedUntilPerfMs = recordedUntilPerfMs
        const observer = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new Observer((list) => {
                if (active === false) return
                const nowMs = clock.now()
                const offset = nowMs - performance.now()
                for (const entry of list.getEntries()) {
                  if (entry.entryType !== 'measure' || entry.name === undefined) continue
                  if (
                    names === undefined
                      ? entry.name.startsWith(prefix) === false
                      : names.has(entry.name) === false
                  )
                    continue
                  const endPerfMs = entry.startTime + entry.duration
                  if (endPerfMs <= replayedUntilPerfMs) continue
                  recordedUntilPerfMs = Math.max(recordedUntilPerfMs, endPerfMs)
                  const startedAtMs = entry.startTime + offset
                  // A measure ends no later than its delivery; keep the series nondecreasing.
                  const atMs = Math.max(newestAtMs, Math.min(nowMs, startedAtMs + entry.duration))
                  if (
                    Number.isFinite(startedAtMs) === false ||
                    Number.isFinite(entry.duration) === false ||
                    entry.duration < 0
                  ) {
                    newestAtMs = Math.max(newestAtMs, nowMs)
                    sink.append({
                      sample: {
                        _tag: 'Unavailable',
                        atMs: newestAtMs,
                        reason: 'MeasurementFailed',
                      },
                    })
                    continue
                  }
                  newestAtMs = atMs
                  sink.append({
                    sample: {
                      _tag: 'Value',
                      atMs,
                      value: {
                        _tag: 'UserTiming',
                        name: entry.name,
                        startedAtMs,
                        durationMs: entry.duration,
                      },
                    },
                  })
                }
              }),
            catch: acquisitionFailed,
          }),
          (acquiredObserver) =>
            Effect.sync(() => {
              active = false
              acquiredObserver.disconnect()
            }),
        )
        yield* Effect.try({
          try: () => observer.observe({ type: 'measure', buffered: true }),
          catch: acquisitionFailed,
        })
      }),
  })
}
