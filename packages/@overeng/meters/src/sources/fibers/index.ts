import { Context, Effect, Metric } from 'effect'

import type { Series } from '../../series/index.ts'
import { makeSource, runInterval, type Source } from '../../session/index.ts'

/** Actual Effect runtime child-fiber gauge, not a count of all fibers. */
export interface Fibers {
  readonly _tag: 'Fibers'
  readonly activeChildFibers: number
}
/** Host-owned metric registry, attributes, and enablement evidence. */
export interface RuntimeMetricContext {
  readonly runtimeMetricsEnabled: () => boolean
  readonly readActiveChildFibers: () => number
}
/** Capture the host registry and metric attributes without enabling runtime metrics.
 * The shared/tagged gauge includes diagnostic child fibers using this context.
 */
export const runtimeMetricContext: Effect.Effect<RuntimeMetricContext> = Effect.gen(function* () {
  const context = yield* Effect.context<never>()
  const gauge = Metric.gauge('child_fibers_active', {
    description: 'The current count of active child fibers',
  })
  return {
    runtimeMetricsEnabled: () =>
      Context.get(context, Metric.FiberRuntimeMetrics) === Metric.FiberRuntimeMetricsImpl,
    readActiveChildFibers: () => gauge.valueUnsafe(context).value,
  }
})

/** Observe only host-enabled runtime metrics; dormant gauges are unavailable, not zero. */
export const fibersSource = (options: {
  readonly id: string
  readonly series: Series<Fibers>
  readonly everyMs: number
  readonly metricContext?: RuntimeMetricContext
}): Source<Fibers> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Interval', everyMs: options.everyMs },
    start: ({ sink, clock }) =>
      runInterval({
        clock,
        everyMs: options.everyMs,
        observe: Effect.sync(() => {
          const context = options.metricContext
          if (context === undefined || context.runtimeMetricsEnabled() !== true) {
            sink.append({
              sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'NotConfigured' },
            })
            return
          }
          sink.append({
            sample: {
              _tag: 'Value',
              atMs: clock.now(),
              value: { _tag: 'Fibers', activeChildFibers: context.readActiveChildFibers() },
            },
          })
        }),
      }),
  })
