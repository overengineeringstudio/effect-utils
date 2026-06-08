/**
 * Server-free contract-layer test of the OTel bridge (spec §10, §11.3, decision
 * 0007). Uses an in-memory `SpanExporter` and drives the real
 * `openTelemetryHook` + the real inbound bridge by hand (no native server),
 * proving:
 *
 * 1. The global registration (`provider.register()`, the load-bearing fix) makes
 *    the hook's `trace.getActiveSpan()` resolve — and the inbound bridge
 *    reparents the Effect span under the `attempt` span, so the external parent
 *    → attempt → Effect spans form ONE trace (shared `traceId`, correct
 *    `parentSpanId` chain).
 * 2. Exactly-once on replay: a journaled `ctx.run` (driven through the hook's
 *    `run` interceptor) emits its `run (<name>)` span only on REAL execution, and
 *    span events added during replay are suppressed — replaying does not
 *    double-emit.
 *
 * The Effect tracer is bound to the SAME registered provider as the hook (via
 * `@effect/opentelemetry`'s `Tracer.layer` over the provider Tag), so
 * `Effect.withSpan` and the hook emit into the one in-memory exporter.
 */
import * as Resource from '@effect/opentelemetry/Resource'
import * as EffectTracer from '@effect/opentelemetry/Tracer'
import { context, type SpanContext, trace } from '@opentelemetry/api'
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  openTelemetryHook,
  type OpenTelemetryHookContext,
} from '@restatedev/restate-sdk-opentelemetry'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RestateOtel } from './otel.ts'

/* The internal replay-suppression symbol the hook reads off the hook context to
 * decide whether the invocation is really processing (vs replaying). */
const IS_PROCESSING = Symbol.for('@restatedev/restate-sdk/hooks.isProcessing')

/* A W3C `traceparent` for a fabricated external parent span (the inbound edge). */
const PARENT_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const PARENT_SPAN_ID = 'b7ad6b7169203331'
const traceparent = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`

/* Build a fake hook/handler context with the minimal `request` the hook reads,
 * plus the `isProcessing` symbol controlling the replay gate. */
const makeHookCtx = (isProcessing: boolean) => {
  const request = {
    id: 'inv_test',
    target: 'Greeter/greet',
    attemptHeaders: new Map<string, string>([['traceparent', traceparent]]),
  }
  const hookCtx: Record<PropertyKey, unknown> = { request }
  Object.defineProperty(hookCtx, IS_PROCESSING, { value: () => isProcessing })
  /* Only the fields the hook reads (`request.{id,target,attemptHeaders}`) plus
   * the replay symbol are populated; cast to the full hook-context shape. */
  return hookCtx as unknown as OpenTelemetryHookContext
}

let provider: NodeTracerProvider
let exporter: InMemorySpanExporter
/* The Effect tracer layer bound to the registered provider (built per test). */
let tracerLayer: Layer.Layer<never>

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  /* The load-bearing global registration (provider + AsyncLocalStorageContextManager). */
  provider.register()
  tracerLayer = EffectTracer.layer.pipe(
    Layer.provide(Layer.succeed(EffectTracer.OtelTracerProvider, provider)),
    Layer.provide(Resource.layer({ serviceName: 'greeter-test' })),
  )
})

afterEach(async () => {
  await provider.shutdown()
  trace.disable()
  context.disable()
})

const byName = (spans: ReadonlyArray<ReadableSpan>, name: string) =>
  spans.find((s) => s.name === name)

describe('OTel bridge (server-free)', () => {
  it('parents the Effect span under the attempt span in one trace', async () => {
    const hook = openTelemetryHook({ tracer: trace.getTracer('@overeng/restate-effect') })
    const interceptor = hook(makeHookCtx(true)).interceptor!

    let activeSpanInHandler: SpanContext | undefined

    /* The SDK calls `interceptor.handler(next)` with the handler body as `next`,
     * inside `context.with(attemptContext, ...)`. We mirror that: `next` reads the
     * active span (the attempt span) and runs an Effect program through the
     * inbound bridge that opens its own `Effect.withSpan`. */
    await interceptor.handler!(async () => {
      activeSpanInHandler = trace.getActiveSpan()?.spanContext()
      await Effect.runPromise(
        Effect.withSpan('work')(Effect.void).pipe(
          RestateOtel.inboundBridge,
          Effect.provide(tracerLayer),
        ),
      )
    })

    /* The hook's global active span resolved (global registration worked). */
    expect(activeSpanInHandler).toBeDefined()
    expect(activeSpanInHandler!.traceId).toBe(PARENT_TRACE_ID)

    const spans = exporter.getFinishedSpans()
    const attemptSpan = byName(spans, 'attempt Greeter/greet')
    const workSpan = byName(spans, 'work')

    expect(attemptSpan).toBeDefined()
    expect(workSpan).toBeDefined()

    /* One trace: external parent → attempt → work all share the trace id. */
    expect(attemptSpan!.spanContext().traceId).toBe(PARENT_TRACE_ID)
    expect(workSpan!.spanContext().traceId).toBe(PARENT_TRACE_ID)

    /* The attempt span is a child of the external W3C parent. */
    expect(attemptSpan!.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID)
    /* The Effect `work` span is a child of the attempt span (the inbound bridge). */
    expect(workSpan!.parentSpanContext?.spanId).toBe(attemptSpan!.spanContext().spanId)
  })

  it('emits the run span exactly once and suppresses replay events', async () => {
    const hook = openTelemetryHook({ tracer: trace.getTracer('@overeng/restate-effect') })

    /* Real execution: the run closure runs, a run span + its event are emitted. */
    const processingInterceptor = hook(makeHookCtx(true)).interceptor!
    await processingInterceptor.handler!(async () => {
      await processingInterceptor.run!('charge', async () => {
        trace.getActiveSpan()?.addEvent('charged')
      })
    })

    /* Replay: the SDK SKIPS the run interceptor for journaled runs (it only fires
     * on real execution), and attempt-span events are suppressed while replaying.
     * We model replay by NOT invoking `run` (journaled) and adding an event that
     * must be dropped. */
    const replayInterceptor = hook(makeHookCtx(false)).interceptor!
    await replayInterceptor.handler!(async () => {
      /* This event lands on the attempt span's replay-suppressing wrapper. */
      trace.getActiveSpan()?.addEvent('should-be-suppressed')
    })

    const spans = exporter.getFinishedSpans()
    const runSpans = spans.filter((s) => s.name === 'run (charge)')
    /* Exactly one run span across the real execution + the replay. */
    expect(runSpans).toHaveLength(1)
    expect(runSpans[0]!.events.map((e) => e.name)).toContain('charged')

    /* Two attempt spans (one real, one replay); the replay one recorded NO
     * suppressed event. */
    const attemptSpans = spans.filter((s) => s.name === 'attempt Greeter/greet')
    expect(attemptSpans).toHaveLength(2)
    const replayAttempt = attemptSpans.find((s) => s.events.every((e) => e.name !== 'charged'))!
    expect(replayAttempt.events.map((e) => e.name)).not.toContain('should-be-suppressed')
  })
})
