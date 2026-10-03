/**
 * Long frames as spans: Long Animation Frames (Chromium; blocking time, render phase, top script)
 * with a `longtask` fallback elsewhere. Each becomes a retroactive `browser.long_frame` span, a
 * histogram sample, and a count/max in the ring vitals. The observer lives for the layer's Scope.
 */
import { Effect, Layer, Schema } from 'effect'

import { OtelMetric } from '@overeng/otel-contract'

import { type BrowserPlatform, observeScoped } from '../BrowserPlatform.ts'
import { BrowserTelemetry } from '../BrowserTelemetry.ts'

/** Long Animation Frames entry; not in TypeScript's DOM lib yet. */
interface LongAnimationFrameEntry extends PerformanceEntry {
  readonly blockingDuration: number
  readonly renderStart: number
  readonly scripts: ReadonlyArray<{
    readonly invoker: string
    readonly duration: number
    readonly sourceFunctionName: string
  }>
}

/** Schema-first main-thread frame duration contract. */
export const durationContract = OtelMetric.histogram({
  name: 'browser_long_frame_duration_seconds',
  description: 'Main-thread frames of 50 ms or longer (long-animation-frame, else longtask)',
  unit: 's',
  boundaries: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  labels: Schema.Struct({}),
})

/** Effect histogram for main-thread frames lasting at least 50 ms. */
export const durationSeconds = OtelMetric.effect.histogram(durationContract).metric

const isLoaf = (entry: PerformanceEntry): entry is LongAnimationFrameEntry =>
  entry.entryType === 'long-animation-frame'

/** Keeps `top_script` a bounded label: the longest script's function or invoker, ≤ 80 chars. */
const topScript = (entry: LongAnimationFrameEntry) => {
  const top = entry.scripts.reduce<LongAnimationFrameEntry['scripts'][number] | undefined>(
    (best, script) => (best === undefined || script.duration > best.duration ? script : best),
    undefined,
  )
  return top === undefined
    ? undefined
    : (top.sourceFunctionName.length > 0 ? top.sourceFunctionName : top.invoker).slice(0, 80)
}

const make = Effect.gen(function* () {
  const telemetry = yield* BrowserTelemetry
  let count = 0
  let maxMs = 0
  const onEntries = (entries: ReadonlyArray<PerformanceEntry>) => {
    for (const entry of entries) {
      count += 1
      maxMs = Math.max(maxMs, entry.duration)
      const script = isLoaf(entry) === true ? topScript(entry) : undefined
      telemetry.recordSpan({
        name: 'browser.long_frame',
        startMs: entry.startTime,
        endMs: entry.startTime + entry.duration,
        attributes: {
          'span.label': `${Math.round(entry.duration)}ms`,
          'browser.long_frame.source': entry.entryType,
          ...(isLoaf(entry) === true
            ? {
                'browser.long_frame.blocking_ms': entry.blockingDuration,
                'browser.long_frame.render_ms':
                  entry.startTime + entry.duration - entry.renderStart,
              }
            : {}),
          ...(script === undefined ? {} : { 'browser.long_frame.top_script': script }),
        },
      })
      telemetry.updateMetric({ metric: durationSeconds, input: entry.duration / 1000 })
    }
    telemetry.ring.updateVitals({ longFrames: count, longFrameMaxMs: maxMs })
  }
  const observed = yield* observeScoped({
    types: ['long-animation-frame'],
    options: { buffered: true },
    callback: onEntries,
  })
  if (observed === false) {
    yield* observeScoped({ types: ['longtask'], options: { buffered: true }, callback: onEntries })
  }
})

/** Observes long frames for the lifetime of the consuming scope. */
export const layer: Layer.Layer<never, never, BrowserTelemetry | BrowserPlatform> =
  Layer.effectDiscard(make)
