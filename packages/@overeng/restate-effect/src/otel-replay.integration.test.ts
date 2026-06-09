/**
 * Integration gap: OTel exactly-once per-invocation metrics + attempt-span
 * reparenting under REAL replay against a native server (decision 0014, §10). This
 * was only UNIT-asserted (a fabricated hook context) before. Here the real server
 * runs a handler under `alwaysReplay` (every suspension forces a replay), with the
 * OTel hook + inbound bridge + boundary observer wired through the harness and a
 * shared in-memory provider/meter, proving:
 *
 * 1. EXACTLY-ONCE: the per-invocation `restate_invocations_total` counter sums to ONE
 *    for the invocation even though the handler replayed multiple times (the metric is
 *    gated on the SDK's non-replay signal, NOT emitted per attempt).
 * 2. REPARENTING: the handler's Effect span (`restate.run`) is a child of the
 *    `attempt` span the hook opened, in ONE trace (shared `traceId`).
 */
import { it } from '@effect/vitest'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateObject, State } from './mod.ts'
import { RestateOtel } from './otel.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from './testing.ts'

/* A keyed Object whose `bump` runs a journaled `Restate.run` step + a State write —
 * so `alwaysReplay` exercises a real suspension/replay around the journaled work. */
const CounterState = { count: Schema.Number } as const
const Counter = State.for(CounterState)

const CounterObj = RestateObject.contract('otel-replay-counter', {
  state: CounterState,
  handlers: {
    bump: { input: Schema.Void, success: Schema.Number },
  },
})

const CounterLive = RestateObject.implement<typeof CounterObj>(CounterObj, {
  bump: () =>
    Effect.gen(function* () {
      const delta = yield* Restate.run('delta', Effect.succeed(1)).pipe(Effect.orDie)
      const next = ((yield* Counter.get('count')) ?? 0) + delta
      yield* Counter.set('count', next)
      return next
    }).pipe(Effect.orDie),
})

/* Shared in-memory exporters (read after the invocation). */
const spanExporter = new InMemorySpanExporter()
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter })

const OtelLayer = RestateOtel.layer({
  resource: { serviceName: 'otel-replay-test' },
  exporter: spanExporter,
  metricReader,
})

/* The harness: the OTel layer is the appLayer; the hook/bridge/observer are wired
 * via the harness opts. `alwaysReplay` forces a replay at every suspension. */
const HarnessLayer = RestateTestHarness.layer({
  services: [CounterLive],
  appLayer: OtelLayer,
  alwaysReplay: true,
  disableRetries: true,
  hooks: [RestateOtel.hook()],
  inboundBridge: RestateOtel.inboundBridge,
  boundaryObserver: RestateOtel.boundaryObserver,
})

/**
 * Sum a counter metric's data points for this service across exports. The metric
 * LABELS are `service`/`handler` (the metric label convention), distinct from the
 * SPAN attributes `restate.service`/`restate.handler`.
 */
const counterSumFor = (metricName: string, service: string): number => {
  let sum = 0
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name !== metricName) continue
        for (const dp of m.dataPoints) {
          if ((dp.attributes as Record<string, unknown>)['service'] === service) {
            sum += dp.value as number
          }
        }
      }
    }
  }
  return sum
}

describe.skipIf(!serverAvailable)('OTel exactly-once + reparenting under real replay', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('alwaysReplay', (it) => {
    it.effect('per-invocation metric fires once; the Effect span reparents the attempt', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const result = yield* harness.ingress.objectCall(CounterObj, 'k1', 'bump', undefined)
        expect(result).toBe(1)

        /* Let the spans flush + the metric reader export the in-memory points (the
         * span exporter uses a `SimpleSpanProcessor`, so spans are flushed on end). */
        yield* liveSleep(300)
        yield* Effect.promise(() => metricReader.forceFlush())

        /* 1. EXACTLY-ONCE: one invocation → the per-invocation outcome counter AND the
         * per-attempt counter each sum to 1, despite the handler replaying multiple
         * times (the metrics are gated on the SDK's non-replay signal). */
        expect(counterSumFor('restate_invocations_total', 'otel-replay-counter')).toBe(1)
        expect(counterSumFor('restate_attempts_total', 'otel-replay-counter')).toBe(1)

        /* 2. REPARENTING: the `restate.run` Effect span is a child of an `attempt`
         * span (the hook's), in ONE trace — even under replay. Match the `restate.run`
         * span to the `attempt` span that is its actual parent. */
        const spans = spanExporter.getFinishedSpans()
        const attemptSpans = spans.filter((s) => s.name.startsWith('attempt '))
        expect(attemptSpans.length).toBeGreaterThan(0)

        /* The inbound bridge reparents the OUTERMOST handler Effect span
         * (`restate.attemptInterruption`) under the hook's `attempt` span. Find a
         * handler-root Effect span whose parent IS an `attempt` span (the reparenting),
         * in ONE trace; the durable `restate.run` span is then a DESCENDANT in that
         * same trace (parented under the reparented handler-root). */
        const handlerRoots = spans.filter((s) => s.name === 'restate.attemptInterruption')
        const reparented = handlerRoots.find((root) =>
          attemptSpans.some(
            (a) =>
              a.spanContext().spanId === root.parentSpanContext?.spanId &&
              a.spanContext().traceId === root.spanContext().traceId,
          ),
        )
        expect(reparented).toBeDefined()
        /* The durable `restate.run` span lives in the SAME reparented trace. */
        const runInTrace = spans.find(
          (s) =>
            s.name === 'restate.run' &&
            s.spanContext().traceId === reparented!.spanContext().traceId,
        )
        expect(runInTrace).toBeDefined()
      }),
    )
  })
})
