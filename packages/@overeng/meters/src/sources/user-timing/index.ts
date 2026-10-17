import { Effect } from 'effect'

import {
  browserEnvironment,
  type BrowserEntry,
  type BrowserEnvironment,
} from '../../platform/browser.ts'
import type { Series } from '../../series/index.ts'
import { makeSource, type Source, type SourceError } from '../../session/source.ts'

/** One observed User Timing measure; its own times are on the session clock. */
export interface UserTimingValue {
  readonly _tag: 'UserTiming'
  readonly name: string
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly durationMs: number
}

/** Which measures a source records: exact names, or every name with a prefix. */
export type UserTimingFilter =
  | { readonly _tag: 'Names'; readonly names: readonly string[] }
  | { readonly _tag: 'Prefix'; readonly prefix: string }

const byCompletion = (left: BrowserEntry, right: BrowserEntry): number =>
  left.startTime + left.duration - (right.startTime + right.duration)

/**
 * Observe `performance.measure()` entries matching `filter` as event samples for the source
 * lease. Each sample is dated at delivery (the observer callback on the session clock), so
 * buckets aggregate measures by observation time, not completion time; the payload keeps the
 * measure's true start, end and duration. Entries of one delivery are recorded in completion
 * order. Buffered measures from before acquisition count once: every accepted entry is
 * remembered, so a later lease replaying the buffer records only new entries. Without
 * `measure` support the series reads `Unsupported`, never a zero duration.
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
  // Shared across leases: a restarted buffered observer replays every earlier entry object.
  const seen = new WeakSet<BrowserEntry>()
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
        const observer = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new Observer((list) => {
                if (active === false) return
                const atMs = clock.now()
                const offset = atMs - performance.now()
                const valid: BrowserEntry[] = []
                for (const entry of list.getEntries()) {
                  if (entry.entryType !== 'measure' || entry.name === undefined) continue
                  const matches =
                    names === undefined ? entry.name.startsWith(prefix) : names.has(entry.name)
                  if (matches === false) continue
                  if (seen.has(entry) === true) continue
                  seen.add(entry)
                  // Validate before trusting any time: an invalid measure is reported once.
                  if (
                    Number.isFinite(entry.startTime) === false ||
                    Number.isFinite(entry.duration) === false ||
                    Number.isFinite(entry.startTime + entry.duration) === false ||
                    entry.duration < 0
                  ) {
                    sink.append({
                      sample: { _tag: 'Unavailable', atMs, reason: 'MeasurementFailed' },
                    })
                    continue
                  }
                  valid.push(entry)
                }
                valid.sort(byCompletion)
                for (const entry of valid) {
                  const startedAtMs = entry.startTime + offset
                  sink.append({
                    sample: {
                      _tag: 'Value',
                      atMs,
                      value: {
                        _tag: 'UserTiming',
                        name: entry.name ?? '',
                        startedAtMs,
                        endedAtMs: startedAtMs + entry.duration,
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
