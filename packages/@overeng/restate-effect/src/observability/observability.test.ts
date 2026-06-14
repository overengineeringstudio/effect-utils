/**
 * Server-free observability test (docs/vrs/08-observability/spec.md, decision 0014): span ATTRIBUTES + the
 * replay-aware METRICS path, proving the package is operable from Grafana.
 *
 * 1. Span attributes — drive the real `openTelemetryHook` + the `./otel`
 *    `boundaryObserver` by hand (the hook sets the attempt span active; the
 *    observer stamps it). Assert the attempt span carries
 *    `restate.service`/`restate.handler`/`restate.object.key`, and on a FAILURE
 *    outcome `restate.error.tag` + `restate.error.class`.
 *
 * 2. Metrics — bind Effect's `Metric` to a real OTel `MeterProvider` via
 *    `RestateOtel.layer` over an in-memory `MetricReader`, run the auto baseline
 *    emit helpers with a fake `ctx`, collect the reader, and assert the counters /
 *    histograms carry the right labels.
 *
 * 3. Exactly-once on replay — emit the SAME metric with the `ctx.isProcessing()`
 *    gate returning `true` (real execution) vs `false` (replay); assert the replay
 *    emission does NOT increment (no double-count across attempts).
 */
import * as Resource from '@effect/opentelemetry/Resource'
import * as EffectTracer from '@effect/opentelemetry/Tracer'
import { context, trace } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { Context as RestateRawContext } from '@restatedev/restate-sdk'
import { openTelemetryHook } from '@restatedev/restate-sdk-opentelemetry'
import { Effect, Layer, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Restate } from '../schema/Annotations.ts'
import { BoundaryAttemptAttrs, BoundaryOutcomeAttrs, RestateMetrics } from './contract.ts'
import {
  annotateSpanFrom,
  emitAttempt,
  emitAwakeableWait,
  emitDurableStep,
  emitInvocationMetrics,
  emitPollLoopCycle,
} from './Metrics.ts'
import { RestateOtel } from './otel.ts'

/* ── span-attribute test scaffolding (mirrors otel.test.ts) ────────────────── */

const IS_PROCESSING = Symbol.for('@restatedev/restate-sdk/hooks.isProcessing')
const PARENT_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const PARENT_SPAN_ID = 'b7ad6b7169203331'
const traceparent = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`

const makeHookCtx = (target: string) => {
  const request = {
    id: 'inv_test',
    target,
    attemptHeaders: new Map<string, string>([['traceparent', traceparent]]),
  }
  const hookCtx: Record<PropertyKey, unknown> = { request }
  Object.defineProperty(hookCtx, IS_PROCESSING, { value: () => true })
  return hookCtx as never
}

/* A fake raw `restate.Context` exposing only the `isProcessing()` gate the metric
 * helpers read (the rest of the context is never touched on this path). */
const fakeCtx = (isProcessing: boolean): RestateRawContext =>
  ({ isProcessing: () => isProcessing }) as unknown as RestateRawContext

describe('schema-first observability contracts', () => {
  it('encodes hook-owned attempt attrs and omits absent optional identity fields', () => {
    expect(
      BoundaryAttemptAttrs.encodeSync({
        service: 'Counter',
        handler: 'bump',
        objectKey: 'user-42',
      }),
    ).toEqual({
      'restate.service': 'Counter',
      'restate.handler': 'bump',
      'restate.object.key': 'user-42',
    })
  })

  it('encodes boundary outcome attrs from the same terminal/retryable/cancelled domain', () => {
    expect(
      BoundaryOutcomeAttrs.encodeSync({
        errorClass: 'retryable',
        errorTag: 'RateLimited',
      }),
    ).toEqual({
      'restate.error.class': 'retryable',
      'restate.error.tag': 'RateLimited',
    })
  })

  it('declares low-cardinality metric-label contracts for baseline metrics', () => {
    expect(RestateMetrics.invocationsTotal.metadata.labelKeys).toEqual([
      'service',
      'handler',
      'outcome',
    ])
    expect(
      RestateMetrics.invocationsTotal.encodeLabelsSync({
        service: 'Counter',
        handler: 'bump',
        outcome: 'success',
      }),
    ).toEqual({
      service: 'Counter',
      handler: 'bump',
      outcome: 'success',
    })
  })

  it('declares every baseline metric through the schema-first metric contract', () => {
    const contracts = [
      RestateMetrics.invocationsTotal,
      RestateMetrics.invocationDurationMs,
      RestateMetrics.attemptsTotal,
      RestateMetrics.durableStepsTotal,
      RestateMetrics.awakeableWaitMs,
      RestateMetrics.pollLoopCyclesTotal,
    ]
    expect(contracts.map((contract) => contract.name)).toEqual([
      'restate_invocations_total',
      'restate_invocation_duration_ms',
      'restate_attempts_total',
      'restate_durable_steps_total',
      'restate_awakeable_wait_ms',
      'restate_poll_loop_cycles_total',
    ])
    expect(contracts.every((contract) => (contract.description ?? '').length > 0)).toBe(true)
  })
})

describe('span attributes (server-free)', () => {
  let provider: NodeTracerProvider
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    provider.register()
  })
  afterEach(async () => {
    await provider.shutdown()
    trace.disable()
    context.disable()
  })

  it('stamps identity + error class/tag on the attempt span on failure', async () => {
    const hook = openTelemetryHook({ tracer: trace.getTracer('@overeng/restate-effect') })
    const interceptor = hook(makeHookCtx('Counter/bump')).interceptor!

    await interceptor.handler!(async () => {
      /* The boundary opens the observation with the construct/handler/key, then
       * closes it with a terminal domain failure. */
      const onOutcome = RestateOtel.boundaryObserver({
        service: 'Counter',
        handler: 'bump',
        key: 'user-42',
        workflowId: undefined,
        idempotencyKey: undefined,
      })
      onOutcome({
        _tag: 'terminal',
        errorTag: 'OverdraftError',
        thrown: new Error('over limit'),
      })
    })

    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'attempt Counter/bump')!
    expect(attempt).toBeDefined()
    expect(attempt.attributes['restate.service']).toBe('Counter')
    expect(attempt.attributes['restate.handler']).toBe('bump')
    expect(attempt.attributes['restate.object.key']).toBe('user-42')
    expect(attempt.attributes['restate.error.class']).toBe('terminal')
    expect(attempt.attributes['restate.error.tag']).toBe('OverdraftError')
  })

  it('omits object.key for a plain service success (no error attrs)', async () => {
    const hook = openTelemetryHook({ tracer: trace.getTracer('@overeng/restate-effect') })
    const interceptor = hook(makeHookCtx('Greeter/greet')).interceptor!

    await interceptor.handler!(async () => {
      const onOutcome = RestateOtel.boundaryObserver({
        service: 'Greeter',
        handler: 'greet',
        key: undefined,
        workflowId: undefined,
        idempotencyKey: undefined,
      })
      onOutcome({ _tag: 'success' })
    })

    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'attempt Greeter/greet')!
    expect(attempt.attributes['restate.service']).toBe('Greeter')
    expect(attempt.attributes['restate.handler']).toBe('greet')
    expect(attempt.attributes['restate.object.key']).toBeUndefined()
    expect(attempt.attributes['restate.workflow.id']).toBeUndefined()
    expect(attempt.attributes['restate.idempotency.key']).toBeUndefined()
    expect(attempt.attributes['restate.error.class']).toBeUndefined()
    expect(attempt.attributes['restate.error.tag']).toBeUndefined()
  })

  it('auto-stamps workflow.id + idempotency.key on the attempt span (#5)', async () => {
    const hook = openTelemetryHook({ tracer: trace.getTracer('@overeng/restate-effect') })
    const interceptor = hook(makeHookCtx('Approval/run')).interceptor!

    await interceptor.handler!(async () => {
      /* A Workflow `run`: its `key` is the workflow id, and the original
       * invocation carried an idempotency key — both auto-stamped by the boundary. */
      const onOutcome = RestateOtel.boundaryObserver({
        service: 'Approval',
        handler: 'run',
        key: 'wf-deliver-42',
        workflowId: 'wf-deliver-42',
        idempotencyKey: 'intent-7f3a',
      })
      onOutcome({ _tag: 'success' })
    })

    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'attempt Approval/run')!
    expect(attempt).toBeDefined()
    expect(attempt.attributes['restate.workflow.id']).toBe('wf-deliver-42')
    expect(attempt.attributes['restate.idempotency.key']).toBe('intent-7f3a')
    /* The Workflow key still rides as object.key too (Workflows are keyed). */
    expect(attempt.attributes['restate.object.key']).toBe('wf-deliver-42')
  })
})

/* ── annotateSpanFrom redaction (decision 0014, #4) ────────────────────────── */

describe('annotateSpanFrom strips sensitive fields (server-free)', () => {
  let provider: NodeTracerProvider
  let exporter: InMemorySpanExporter
  let tracerLayer: Layer.Layer<never>

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    provider.register()
    tracerLayer = EffectTracer.layer.pipe(
      Layer.provide(Layer.succeed(EffectTracer.OtelTracerProvider, provider)),
      Layer.provide(Resource.layer({ serviceName: 'annotate-test' })),
    )
  })
  afterEach(async () => {
    await provider.shutdown()
    trace.disable()
    context.disable()
  })

  /* A decoded input whose `apiToken` is `Restate.sensitive` (encrypted in the serde),
   * alongside non-secret identity fields the operator legitimately slices on. */
  const Input = Schema.Struct({
    dataSourceId: Schema.String,
    pageCount: Schema.Number,
    apiToken: Restate.sensitive(Schema.String),
  })
  const value = { dataSourceId: 'ds-42', pageCount: 7, apiToken: 'secret-xyz' }

  const runAndRead = async (program: Effect.Effect<void>): Promise<Record<string, unknown>> => {
    await Effect.runPromise(Effect.withSpan('work')(program).pipe(Effect.provide(tracerLayer)))
    return exporter.getFinishedSpans().find((s) => s.name === 'work')!.attributes
  }

  it('stamps non-sensitive fields but NEVER the sensitive one (default projection)', async () => {
    const attrs = await runAndRead(annotateSpanFrom(Input, value))
    expect(attrs['dataSourceId']).toBe('ds-42')
    expect(attrs['pageCount']).toBe(7)
    /* The redacted field is NEVER stamped — the leak path is closed by default. */
    expect(attrs['apiToken']).toBeUndefined()
  })

  it('refuses to stamp a sensitive field even when explicitly picked (rule wins)', async () => {
    const attrs = await runAndRead(annotateSpanFrom(Input, value, ['dataSourceId', 'apiToken']))
    expect(attrs['dataSourceId']).toBe('ds-42')
    expect(attrs['apiToken']).toBeUndefined()
    /* A field NOT picked is simply absent (not stamped), distinct from being stripped. */
    expect(attrs['pageCount']).toBeUndefined()
  })
})

/* ── metrics test scaffolding ──────────────────────────────────────────────── */

/* Find a metric's data points by name across all scope metrics of a collection.
 * Effect's metric registry is a process-global singleton, so a metric may carry
 * data points from sibling tests; assertions filter by the test's own labels via
 * `pointFor`. */
const dataPointsOf = (metrics: ReadonlyArray<MetricData>, name: string) =>
  metrics.find((m) => m.descriptor.name === name)?.dataPoints ?? []

/* The single data point whose attributes include the given label subset. */
const pointFor = (
  metrics: ReadonlyArray<MetricData>,
  name: string,
  labels: Readonly<Record<string, string>>,
) =>
  dataPointsOf(metrics, name).find((p) =>
    Object.entries(labels).every(([k, v]) => p.attributes[k] === v),
  )

describe('replay-aware baseline metrics', () => {
  let reader: PeriodicExportingMetricReader

  /* Build the shared-resource Layer with an in-memory span exporter + the metric
   * reader. The Layer registers the reader against an OTel MeterProvider sharing
   * the resource and binds Effect's `Metric` to it. We keep the reader handle to
   * `collect()` the snapshot synchronously (no export-interval wait). */
  const withOtelLayer = <A>(use: () => Promise<A>): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          reader = new PeriodicExportingMetricReader({
            exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
            /* A long interval — we drive collection ourselves via `collect()`. */
            exportIntervalMillis: 600_000,
          })
          yield* Layer.build(
            RestateOtel.layer({
              resource: { serviceName: 'metrics-test' },
              exporter: new InMemorySpanExporter(),
              metricReader: reader,
            }),
          )
          return yield* Effect.promise(() => use())
        }),
      ),
    )

  afterEach(() => {
    trace.disable()
    context.disable()
  })

  it('emits invocation + step counters with the right labels', async () => {
    const result = await withOtelLayer(async () => {
      const ctx = fakeCtx(true)
      await Effect.runPromise(
        Effect.all([
          emitAttempt(ctx, {
            service: 'Counter',
            handler: 'bump',
          }),
          emitInvocationMetrics(ctx, {
            service: 'Counter',
            handler: 'bump',
            outcome: 'success',
            durationMs: 12,
          }),
          emitDurableStep(ctx, 'charge'),
          emitAwakeableWait(ctx, 42),
          emitPollLoopCycle(ctx, { name: 'invoice-poller', outcome: 'ok' }),
        ]),
      )
      return reader.collect()
    })

    const metrics = result.resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)

    const invocation = pointFor(metrics, 'restate_invocations_total', {
      service: 'Counter',
      handler: 'bump',
      outcome: 'success',
    })
    expect(invocation?.value).toBe(1)

    const step = pointFor(metrics, 'restate_durable_steps_total', { step: 'charge' })
    expect(step?.value).toBe(1)

    const attempt = pointFor(metrics, 'restate_attempts_total', {
      service: 'Counter',
      handler: 'bump',
    })
    expect(attempt?.value).toBe(1)

    const awakeable = pointFor(metrics, 'restate_awakeable_wait_ms', {})
    expect(awakeable).toBeDefined()
    expect((awakeable!.value as { count: number }).count).toBeGreaterThanOrEqual(1)

    const pollLoop = pointFor(metrics, 'restate_poll_loop_cycles_total', {
      name: 'invoice-poller',
      outcome: 'ok',
    })
    expect(pollLoop?.value).toBe(1)

    /* The duration histogram recorded one sample for this label set. */
    const duration = pointFor(metrics, 'restate_invocation_duration_ms', {
      service: 'Counter',
      handler: 'bump',
      outcome: 'success',
    })
    expect(duration).toBeDefined()
    expect((duration!.value as { count: number }).count).toBe(1)
  })

  it('does NOT double-count on replay (exactly-once)', async () => {
    /* A step name unique to this test so the global registry from sibling tests
     * cannot bleed in. */
    const step = 'replay-only'
    const result = await withOtelLayer(async () => {
      /* One REAL execution + two REPLAYS of the same durable step: only the real
       * one counts (the gate suppresses the replays), so the counter reads 1. */
      await Effect.runPromise(emitDurableStep(fakeCtx(true), step))
      await Effect.runPromise(emitDurableStep(fakeCtx(false), step))
      await Effect.runPromise(emitDurableStep(fakeCtx(false), step))
      return reader.collect()
    })

    const metrics = result.resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)
    const point = pointFor(metrics, 'restate_durable_steps_total', { step })
    expect(point?.value).toBe(1)
  })
})
