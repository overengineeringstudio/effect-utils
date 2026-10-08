/**
 * Browser telemetry front door: one Layer that installs the Effect `Tracer` (sampled, teed into the
 * span ring) and, with an `endpoint`, OTLP/HTTP export of traces + metrics to a same-origin path.
 *
 * Lifecycle, all owned by the layer's Scope:
 * - Effect's OTLP exporters batch and retry; the browser transport adds keepalive, offline drop and
 *   size policy (see `OtlpTransport`).
 * - `visibilitychange → hidden` and `pagehide` run the registered hide hooks (final vitals), then
 *   flush every exporter synchronously through `navigator.sendBeacon`.
 * - Scope close (SPA teardown, HMR dispose, tests) flushes via `fetch` and is interruption-safe:
 *   the exporter's finalizer runs uninterruptibly up to `shutdownTimeout`.
 *
 * The resource is built only from options + the page (see `BrowserResource`); `OTEL_*` env from
 * a bundler's `process.env` shim is ignored on purpose.
 */
import {
  Cause,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Tracer,
} from 'effect'
import type { Metric, Scope } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as OtlpExporter from 'effect/observability/OtlpExporter'
import * as OtlpMetrics from 'effect/observability/OtlpMetrics'
import * as OtlpSerialization from 'effect/observability/OtlpSerialization'
import * as OtlpTracer from 'effect/observability/OtlpTracer'

import { BrowserPlatform, listenScoped } from './BrowserPlatform.ts'
import * as BrowserResource from './BrowserResource.ts'
import * as OtlpTransport from './OtlpTransport.ts'
import * as Sampler from './Sampler.ts'
import * as SpanRing from './SpanRing.ts'

/** Browser resource, sampling, buffering, and same-origin export configuration. */
export interface Options extends BrowserResource.ResourceOptions {
  /**
   * Same-origin OTLP base path, e.g. `/otlp` (posts `/otlp/v1/traces` and `/otlp/v1/metrics`).
   * `undefined` keeps telemetry in-process: spans still reach the ring, nothing is exported.
   */
  readonly endpoint: string | undefined
  readonly sampler?: Sampler.Sampler | undefined
  /** @default '2 seconds' */
  readonly exportInterval?: Duration.Input | undefined
  /** Spans per POST; a full batch exports immediately. @default 256 */
  readonly maxBatchSize?: number | undefined
  /** OTLP metrics export; `false` disables it (derive metrics from spans collector-side). @default { exportInterval: '30 seconds' } */
  readonly metrics?: false | { readonly exportInterval?: Duration.Input | undefined } | undefined
  /** Ceiling for the scope-close flush. @default '2 seconds' */
  readonly shutdownTimeout?: Duration.Input | undefined
  /** @default 'json' */
  readonly serialization?: 'json' | 'protobuf' | undefined
  readonly transport?: OtlpTransport.TransportOptions | undefined
  readonly ring?: SpanRing.RingOptions | undefined
}

/** Browser-clock span timing, context, and attributes. */
export interface SpanInput {
  /** ms since `performance.timeOrigin` (e.g. `event.timeStamp`, `entry.startTime`). */
  readonly startMs: number
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly parent?: Tracer.AnySpan | undefined
  readonly kind?: Tracer.SpanKind | undefined
}

/** Page-scoped tracing, metric updates, and exporter lifecycle. */
export interface BrowserTelemetryShape {
  readonly resource: BrowserResource.BrowserResource
  readonly ring: SpanRing.SpanRing
  /** Opens a live span at a browser timestamp; end it with {@link BrowserTelemetryShape.endSpan}. */
  readonly startSpan: (input: SpanInput & { readonly name: string }) => Tracer.Span
  readonly endSpan: (input: {
    readonly span: Tracer.Span
    readonly endMs: number
    readonly exit?: Exit.Exit<unknown, unknown>
  }) => void
  /** Records a span that already happened (browser-measured start and end). */
  readonly recordSpan: (
    input: SpanInput & { readonly name: string; readonly endMs: number },
  ) => void
  /** Updates a metric from a DOM callback, in the context the metrics exporter reads. */
  readonly updateMetric: <TInput, TState>(options: {
    readonly metric: Metric.Metric<TInput, TState>
    readonly input: TInput
  }) => void
  /** Registers work that runs right before the hide flush (e.g. emitting final vitals). */
  readonly onHide: (hook: () => void) => Effect.Effect<void, never, Scope.Scope>
  /** Drains every exporter now (fetch/keepalive). */
  readonly flush: Effect.Effect<void>
  /** Transport counters; `undefined` without an endpoint. */
  readonly transportStats: () => OtlpTransport.TransportStats | undefined
}

/** Effect service for telemetry owned by the current page scope. */
export class BrowserTelemetry extends Context.Service<BrowserTelemetry, BrowserTelemetryShape>()(
  '@overeng/otel-browser/BrowserTelemetry',
) {}

const statusOf = (exit: Exit.Exit<unknown, unknown>): SpanRing.RingSpan['status'] =>
  Exit.isSuccess(exit) === true
    ? 'ok'
    : Cause.hasInterruptsOnly(exit.cause) === true
      ? 'interrupted'
      : 'error'

/**
 * Wraps a tracer: applies the head sampler to local roots and pushes every ended span (sampled or
 * not) into the ring.
 */
const instrumentTracer = (options: {
  readonly inner: Tracer.Tracer
  readonly sampler: Sampler.Sampler
  readonly sessionId: string
  readonly ring: SpanRing.SpanRing
  /** `performance.timeOrigin` in epoch nanoseconds; ring times are relative to it. */
  readonly timeOriginNanos: bigint
}): Tracer.Tracer =>
  Tracer.make({
    span(spanOptions) {
      const sampled =
        spanOptions.sampled &&
        (Option.isSome(spanOptions.parent) ||
          options.sampler({ name: spanOptions.name, sessionId: options.sessionId }))
      const span = options.inner.span({ ...spanOptions, sampled })
      const end = span.end.bind(span)
      span.end = (...args: Parameters<Tracer.Span['end']>) => {
        const [endTime, exit] = args
        end(endTime, exit)
        options.ring.push({
          name: span.name,
          label: String(span.attributes.get('span.label') ?? ''),
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: Option.getOrUndefined(span.parent)?.spanId,
          startMs: Number(spanOptions.startTime - options.timeOriginNanos) / 1_000_000,
          durationMs: Number(endTime - spanOptions.startTime) / 1_000_000,
          status: statusOf(exit),
          sampled: span.sampled,
          attributes: Object.fromEntries(span.attributes),
        })
      }
      return span
    },
    ...(options.inner.context === undefined ? {} : { context: options.inner.context }),
  })

/** Resolves `endpoint` against the page origin; anything that leaves the origin is a defect. */
const resolveEndpoint = ({
  endpoint,
  origin,
}: {
  readonly endpoint: string
  readonly origin: string
}) => {
  const url = new URL(endpoint.replace(/\/+$/, ''), origin)
  return url.origin === origin
    ? Effect.succeed(url.toString())
    : Effect.die(
        new Error(`otel-browser endpoint must be same-origin (${origin}), got ${url.origin}`),
      )
}

const make = Effect.fnUntraced(function* (options: Options) {
  const platform = yield* BrowserPlatform
  const resource = yield* BrowserResource.make(options)
  const ring = SpanRing.make(options.ring)
  const context = yield* Effect.context<never>()
  const otlpResource = {
    serviceName: resource.serviceName,
    serviceVersion: resource.serviceVersion,
    attributes: resource.attributes,
  }
  const shutdownTimeout = options.shutdownTimeout ?? Duration.seconds(2)

  let inner: Tracer.Tracer = Tracer.nativeTracer
  let flush: Effect.Effect<void> = Effect.void
  let transport: OtlpTransport.Transport | undefined
  if (options.endpoint !== undefined) {
    const baseUrl = yield* resolveEndpoint({ endpoint: options.endpoint, origin: platform.origin })
    transport = yield* OtlpTransport.make(options.transport)
    const exportServices = yield* Layer.build(
      Layer.mergeAll(
        OtlpExporter.layerFlusher,
        options.serialization === 'protobuf'
          ? OtlpSerialization.layerProtobuf
          : OtlpSerialization.layerJson,
        Layer.succeed(HttpClient.HttpClient, transport.client),
        // The resource is owned by the page: never merge `OTEL_RESOURCE_ATTRIBUTES` from a shim.
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    )
    inner = yield* OtlpTracer.make({
      url: `${baseUrl}/v1/traces`,
      resource: otlpResource,
      exportInterval: options.exportInterval ?? Duration.seconds(2),
      maxBatchSize: options.maxBatchSize ?? 256,
      shutdownTimeout,
    }).pipe(Effect.provide(exportServices))
    if (options.metrics !== false) {
      yield* OtlpMetrics.make({
        url: `${baseUrl}/v1/metrics`,
        resource: otlpResource,
        exportInterval: options.metrics?.exportInterval ?? Duration.seconds(30),
        shutdownTimeout,
      }).pipe(Effect.provide(exportServices))
    }
    flush = Context.get(exportServices, OtlpExporter.Flusher).flush
  }

  // Epoch-ms floats lose sub-µs precision around 1.8e12; keep the origin in bigint nanoseconds.
  const timeOriginNanos = BigInt(Math.round(platform.timeOrigin * 1_000_000))
  const tracer = instrumentTracer({
    inner,
    sampler: options.sampler ?? Sampler.alwaysOn,
    sessionId: resource.sessionId,
    ring,
    timeOriginNanos,
  })
  const toNanos = (ms: number) => timeOriginNanos + BigInt(Math.round(ms * 1_000_000))

  const startSpan = (input: SpanInput & { readonly name: string }) => {
    const parent = Option.fromUndefinedOr(input.parent)
    const span = tracer.span({
      name: input.name,
      parent,
      annotations: Context.empty(),
      links: [],
      startTime: toNanos(input.startMs),
      kind: input.kind ?? 'internal',
      root: Option.isNone(parent),
      sampled: input.parent?.sampled ?? true,
    })
    for (const [key, value] of Object.entries(input.attributes ?? {})) span.attribute(key, value)
    return span
  }
  const endSpan = ({
    span,
    endMs,
    exit = Exit.void,
  }: {
    readonly span: Tracer.Span
    readonly endMs: number
    readonly exit?: Exit.Exit<unknown, unknown>
  }) => span.end(toNanos(endMs), exit)

  const hideHooks = new Set<() => void>()
  const flushOnHide = () => {
    transport?.setHiding(true)
    for (const hook of hideHooks) hook()
    // Sync scheduler: every exporter reaches `sendBeacon` before this handler returns. The exit
    // is `AsyncFiberError` once the exporter awaits the synthetic response; that tail is moot.
    Effect.runSyncExit(flush)
  }
  yield* listenScoped({
    target: 'document',
    type: 'visibilitychange',
    handler: () => {
      if (platform.isHidden() === true) flushOnHide()
      else transport?.setHiding(false)
    },
  })
  yield* listenScoped({ target: 'window', type: 'pagehide', handler: flushOnHide })

  const service: BrowserTelemetryShape = {
    resource,
    ring,
    startSpan,
    endSpan,
    recordSpan: (input) => endSpan({ span: startSpan(input), endMs: input.endMs }),
    updateMetric: ({ metric, input }) => metric.updateUnsafe(input, context),
    onHide: (hook) =>
      Effect.acquireRelease(
        Effect.sync(() => hideHooks.add(hook)),
        () => Effect.sync(() => hideHooks.delete(hook)),
      ),
    flush,
    transportStats: () => transport?.stats(),
  }
  return Context.make(BrowserTelemetry, service).pipe(Context.add(Tracer.Tracer, tracer))
})

/**
 * Provides `BrowserTelemetry` and the instrumented `Tracer`. Requires `BrowserPlatform`
 * (`BrowserPlatform.layerWindow` in a page).
 */
export const layer = (options: Options): Layer.Layer<BrowserTelemetry, never, BrowserPlatform> =>
  Layer.effectContext(make(options))
