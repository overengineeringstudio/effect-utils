import { Effect } from 'effect'

import { browserEnvironment, type BrowserEnvironment } from '../../platform/browser.ts'
import type { Series } from '../../series/index.ts'
import { makeSource, type Source, type SourceError } from '../../session/source.ts'

/** LoAF evidence and long-task fallback are deliberately different payloads. */
export type LongFrameValue =
  | {
      readonly _tag: 'LoAF'
      readonly startedAtMs: number
      readonly durationMs: number
      readonly blockingDurationMs: number
      readonly renderStartMs: number
    }
  | { readonly _tag: 'LongTask'; readonly startedAtMs: number; readonly durationMs: number }

/** Observe LoAF when supported, otherwise only long tasks, for the source lease. */
export const longFramesSource = (options: {
  readonly id: string
  readonly series: Series<LongFrameValue>
  readonly browser?: () => BrowserEnvironment
}): Source<LongFrameValue> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    start: ({ sink, clock }) =>
      Effect.gen(function* () {
        const browser = (options.browser ?? browserEnvironment)()
        const Observer = browser.PerformanceObserver
        const type =
          Observer?.supportedEntryTypes.includes('long-animation-frame') === true
            ? 'long-animation-frame'
            : Observer?.supportedEntryTypes.includes('longtask') === true
              ? 'longtask'
              : undefined
        if (Observer === undefined || type === undefined || browser.performance === undefined) {
          sink.append({ sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'Unsupported' } })
          return
        }
        const performance = browser.performance
        let active = true
        const observer = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new Observer((list) => {
                if (active === false) return
                const atMs = clock.now()
                const offset = atMs - performance.now()
                for (const entry of list.getEntries()) {
                  if (entry.entryType !== type) continue
                  const startedAtMs = entry.startTime + offset
                  if (
                    Number.isFinite(startedAtMs) === false ||
                    Number.isFinite(entry.duration) === false ||
                    entry.duration < 0
                  ) {
                    sink.append({
                      sample: { _tag: 'Unavailable', atMs, reason: 'MeasurementFailed' },
                    })
                    continue
                  }
                  if (type === 'long-animation-frame') {
                    if (
                      entry.blockingDuration === undefined ||
                      entry.renderStart === undefined ||
                      Number.isFinite(entry.blockingDuration) === false ||
                      Number.isFinite(entry.renderStart) === false
                    ) {
                      sink.append({
                        sample: { _tag: 'Unavailable', atMs, reason: 'MeasurementFailed' },
                      })
                      continue
                    }
                    sink.append({
                      sample: {
                        _tag: 'Value',
                        atMs,
                        value: {
                          _tag: 'LoAF',
                          startedAtMs,
                          durationMs: entry.duration,
                          blockingDurationMs: entry.blockingDuration,
                          renderStartMs: entry.renderStart === 0 ? 0 : entry.renderStart + offset,
                        },
                      },
                    })
                  } else {
                    sink.append({
                      sample: {
                        _tag: 'Value',
                        atMs,
                        value: {
                          _tag: 'LongTask',
                          startedAtMs,
                          durationMs: entry.duration,
                        },
                      },
                    })
                  }
                }
              }),
            catch: (cause): SourceError => ({
              _tag: 'SourceError',
              sourceId: options.id,
              reason: 'AcquisitionFailed',
              cause: cause instanceof Error ? cause : new Error(String(cause)),
            }),
          }),
          (acquiredObserver) =>
            Effect.sync(() => {
              active = false
              acquiredObserver.disconnect()
            }),
        )
        yield* Effect.try({
          try: () => observer.observe({ type, buffered: true }),
          catch: (cause): SourceError => ({
            _tag: 'SourceError',
            sourceId: options.id,
            reason: 'AcquisitionFailed',
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
        })
      }),
  })
