/**
 * Core Web Vitals from `PerformanceObserver`: INP (Event Timing, p98 of interactions), LCP (last
 * candidate), CLS (largest session window: gaps < 1 s, windows ≤ 5 s). Live values go to the ring
 * vitals for perf panels; on the first page hide they are reported once as a `browser.page.vitals`
 * span and histogram samples, just before the hide flush beacons them out.
 */
import { Effect, Layer, Schema } from 'effect'

import { OtelMetric } from '@overeng/otel-contract'

import { BrowserPlatform, observeScoped } from '../BrowserPlatform.ts'
import { BrowserTelemetry } from '../BrowserTelemetry.ts'

interface EventTimingEntry extends PerformanceEntry {
  readonly interactionId: number
}

interface LayoutShiftEntry extends PerformanceEntry {
  readonly value: number
  readonly hadRecentInput: boolean
}

const secondsBoundaries = [0.1, 0.2, 0.5, 1, 2, 2.5, 4, 8]

/** Schema-first Interaction to Next Paint contract. */
export const inpContract = OtelMetric.histogram({
  name: 'browser_web_vital_inp_seconds',
  description: 'Interaction to Next Paint per page view',
  unit: 's',
  boundaries: secondsBoundaries,
  labels: Schema.Struct({}),
})

/** Schema-first Largest Contentful Paint contract. */
export const lcpContract = OtelMetric.histogram({
  name: 'browser_web_vital_lcp_seconds',
  description: 'Largest Contentful Paint per page view',
  unit: 's',
  boundaries: secondsBoundaries,
  labels: Schema.Struct({}),
})

/** Schema-first Cumulative Layout Shift contract. */
export const clsContract = OtelMetric.histogram({
  name: 'browser_web_vital_cls',
  description: 'Cumulative Layout Shift per page view',
  boundaries: [0.05, 0.1, 0.25, 0.5, 1],
  labels: Schema.Struct({}),
})

/** Effect histogram for per-page Interaction to Next Paint in seconds. */
export const inpSeconds = OtelMetric.effect.histogram(inpContract).metric
/** Effect histogram for per-page Largest Contentful Paint in seconds. */
export const lcpSeconds = OtelMetric.effect.histogram(lcpContract).metric
/** Effect histogram for per-page Cumulative Layout Shift. */
export const cls = OtelMetric.effect.histogram(clsContract).metric

/** INP: worst interaction, skipping one per 50 interactions (the spec's p98 approximation). */
export const inpOf = (durations: ReadonlyArray<number>): number | undefined => {
  if (durations.length === 0) return undefined
  const sorted = durations.toSorted((a, b) => b - a)
  return sorted[Math.min(Math.floor(durations.length / 50), sorted.length - 1)]
}

const make = Effect.gen(function* () {
  const telemetry = yield* BrowserTelemetry
  const platform = yield* BrowserPlatform
  const interactionDurations = new Map<number, number>()
  let lcpMs: number | undefined
  let clsValue = 0
  let windowValue = 0
  let windowStart = 0
  let lastShift = 0

  yield* observeScoped({
    types: ['event'],
    options: { buffered: true, durationThreshold: 16 },
    callback: (entries) => {
      for (const entry of entries as ReadonlyArray<EventTimingEntry>) {
        if (entry.interactionId === 0) continue
        const previous = interactionDurations.get(entry.interactionId) ?? 0
        interactionDurations.set(entry.interactionId, Math.max(previous, entry.duration))
      }
      telemetry.ring.updateVitals({ inpMs: inpOf([...interactionDurations.values()]) })
    },
  })

  yield* observeScoped({
    types: ['largest-contentful-paint'],
    options: { buffered: true },
    callback: (entries) => {
      const last = entries.at(-1)
      if (last === undefined) return
      lcpMs = last.startTime
      telemetry.ring.updateVitals({ lcpMs })
    },
  })

  yield* observeScoped({
    types: ['layout-shift'],
    options: { buffered: true },
    callback: (entries) => {
      for (const entry of entries as ReadonlyArray<LayoutShiftEntry>) {
        if (entry.hadRecentInput === true) continue
        const continues =
          windowValue > 0 &&
          entry.startTime - lastShift < 1000 &&
          entry.startTime - windowStart < 5000
        windowValue = continues === true ? windowValue + entry.value : entry.value
        if (continues === false) windowStart = entry.startTime
        lastShift = entry.startTime
        clsValue = Math.max(clsValue, windowValue)
      }
      telemetry.ring.updateVitals({ cls: clsValue })
    },
  })

  let reported = false
  yield* telemetry.onHide(() => {
    if (reported === true) return
    reported = true
    const inpMs = inpOf([...interactionDurations.values()])
    telemetry.recordSpan({
      name: 'browser.page.vitals',
      startMs: 0,
      endMs: platform.now(),
      attributes: {
        'span.label': 'vitals',
        'browser.vitals.cls': clsValue,
        'browser.vitals.interactions': interactionDurations.size,
        ...(inpMs === undefined ? {} : { 'browser.vitals.inp_ms': inpMs }),
        ...(lcpMs === undefined ? {} : { 'browser.vitals.lcp_ms': lcpMs }),
      },
    })
    telemetry.updateMetric({ metric: cls, input: clsValue })
    if (inpMs !== undefined) telemetry.updateMetric({ metric: inpSeconds, input: inpMs / 1000 })
    if (lcpMs !== undefined) telemetry.updateMetric({ metric: lcpSeconds, input: lcpMs / 1000 })
  })
})

/** Observes live page vitals and reports their final values on the first page hide. */
export const layer: Layer.Layer<never, never, BrowserTelemetry | BrowserPlatform> =
  Layer.effectDiscard(make)
