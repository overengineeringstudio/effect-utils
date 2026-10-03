import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from 'effect'

/**
 * Export path against a real OTLP/HTTP receiver (Bun.serve standing in for the gateway relay):
 * the page posts same-origin, so the receiver's origin is the page origin.
 */
import { ServiceIdentity } from '@overeng/otel-contract'
import { Vitest } from '@overeng/utils-dev/node-vitest'

const { describe, expect, it } = Vitest

import type { BrowserPlatform } from './BrowserPlatform.ts'
import * as BrowserTelemetry from './BrowserTelemetry.ts'
import * as Sampler from './Sampler.ts'
import { makeTestPlatform } from './test-platform.ts'
import * as Interactions from './ui/Interactions.ts'
import * as WebVitals from './ui/WebVitals.ts'

interface Received {
  readonly path: string
  readonly contentType: string | null
  readonly body: OtlpPayload
}

interface KeyValue {
  readonly key: string
  readonly value: Record<string, unknown>
}
interface OtlpPayload {
  readonly resourceSpans?: ReadonlyArray<{
    readonly resource: { readonly attributes: ReadonlyArray<KeyValue> }
    readonly scopeSpans: ReadonlyArray<{
      readonly spans: ReadonlyArray<{ readonly name: string; readonly traceId: string }>
    }>
  }>
  readonly resourceMetrics?: ReadonlyArray<{
    readonly resource: { readonly attributes: ReadonlyArray<KeyValue> }
    readonly scopeMetrics: ReadonlyArray<{
      readonly metrics: ReadonlyArray<{ readonly name: string }>
    }>
  }>
}

const otlpReceiver = Effect.acquireRelease(
  Effect.sync(() => {
    const received: Received[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get('content-type'),
          body: (await request.json()) as OtlpPayload,
        })
        return new Response(null, { status: 200 })
      },
    })
    return { origin: server.url.origin, received, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
)

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'example-web',
  namespace: 'example-app',
  version: '0.1.0+abc123',
})

const spanNames = (received: ReadonlyArray<Received>) =>
  received.flatMap((entry) =>
    (entry.body.resourceSpans ?? []).flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
    ),
  )

const resourceOf = (entry: Received | undefined) =>
  Object.fromEntries(
    (
      entry?.body.resourceSpans?.[0]?.resource.attributes ??
      entry?.body.resourceMetrics?.[0]?.resource.attributes ??
      []
    ).map(({ key, value }) => [key, Object.values(value)[0]]),
  )

const telemetryLayer = (
  platform: Layer.Layer<BrowserPlatform>,
  overrides?: Partial<BrowserTelemetry.Options>,
) =>
  BrowserTelemetry.layer({
    identity,
    environment: 'dev',
    endpoint: '/otlp',
    // An hour: nothing leaves on a timer, so every POST below is a flush under test.
    exportInterval: '1 hour',
    metrics: { exportInterval: '1 hour' },
    ...overrides,
  }).pipe(Layer.provide(platform))

describe('OTLP export', () => {
  it.live('scope close flushes buffered spans to the same-origin path', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(telemetryLayer(platform.layer), scope)
      yield* Effect.void.pipe(
        Effect.withSpan('example.action', { attributes: { 'span.label': 'open' } }),
        Effect.provide(context),
      )
      expect(receiver.received).toEqual([])
      yield* Scope.close(scope, Exit.void)
      const traces = receiver.received.filter((entry) => entry.path === '/otlp/v1/traces')
      expect(spanNames(traces)).toEqual(['example.action'])
      expect(traces[0]?.contentType).toBe('application/json')
    }).pipe(Effect.scoped),
  )

  it.live('interrupting the program still delivers spans ended before the interrupt', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const ended = yield* Deferred.make<void>()
      const fiber = yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan('before-interrupt'))
        yield* Deferred.succeed(ended, undefined)
        return yield* Effect.never
      }).pipe(Effect.provide(telemetryLayer(platform.layer)), Effect.forkChild)
      yield* Deferred.await(ended)
      yield* Fiber.interrupt(fiber)
      expect(spanNames(receiver.received)).toEqual(['before-interrupt'])
    }).pipe(Effect.scoped),
  )

  it.live('the resource is browser-owned: identity, session, no host keys, env ignored', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const previous = process.env.OTEL_RESOURCE_ATTRIBUTES
      process.env.OTEL_RESOURCE_ATTRIBUTES =
        'host.name=collector,service.version=collector%2B123,deployment.environment.name=prod'
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
          else process.env.OTEL_RESOURCE_ATTRIBUTES = previous
        }),
      )
      yield* Effect.void.pipe(
        Effect.withSpan('example.action'),
        Effect.provide(
          telemetryLayer(platform.layer, { resourceAttributes: { 'app.build.flavor': 'preview' } }),
        ),
      )
      const resource = resourceOf(
        receiver.received.find((entry) => entry.path === '/otlp/v1/traces'),
      )
      expect(resource).toMatchObject({
        'service.name': 'example-web',
        'service.namespace': 'example-app',
        'service.version': '0.1.0+abc123',
        'deployment.environment.name': 'dev',
        'telemetry.sdk.language': 'webjs',
        'user_agent.original': 'test-agent/1.0',
        'app.build.flavor': 'preview',
      })
      expect(resource['session.id']).toBeTypeOf('string')
      expect(resource['service.instance.id']).not.toBe(resource['session.id'])
      expect(Object.keys(resource).filter((key) => key.startsWith('host.'))).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('caller attributes cannot claim owned or host identity keys', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      for (const key of ['host.name', 'service.version', 'session.id']) {
        const exit = yield* Effect.void.pipe(
          Effect.provide(telemetryLayer(platform.layer, { resourceAttributes: { [key]: 'x' } })),
          Effect.exit,
        )
        expect(Exit.isFailure(exit) && String(exit.cause).includes(key)).toBe(true)
      }
    }),
  )

  it.live('a cross-origin endpoint is refused at construction', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      const exit = yield* Effect.void.pipe(
        Effect.provide(
          telemetryLayer(platform.layer, { endpoint: 'https://collector.example/otlp' }),
        ),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    'page hide beacons final vitals and pending spans synchronously, before the handler returns',
    () =>
      Effect.gen(function* () {
        const receiver = yield* otlpReceiver
        const platform = makeTestPlatform({ origin: receiver.origin })
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          WebVitals.layer.pipe(
            Layer.provideMerge(telemetryLayer(platform.layer)),
            Layer.provide(platform.layer),
          ),
          scope,
        )
        yield* Effect.void.pipe(Effect.withSpan('example.action'), Effect.provide(context))
        platform.emitEntries({ type: 'largest-contentful-paint', entries: [{ startTime: 640 }] })
        platform.setNow(5_000)
        // No yield between dispatch and the assertion: the beacon must already be queued.
        platform.setHidden(true)
        const queuedSynchronously = platform.beacons.map((beacon) => new URL(beacon.url).pathname)
        expect(queuedSynchronously).toContain('/otlp/v1/traces')
        const traceBeacon = platform.beacons.find((beacon) => beacon.url.endsWith('/v1/traces'))!
        const payload = (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Effect.promise(() => traceBeacon.data.text()),
        )) as OtlpPayload
        expect(traceBeacon.data.type).toMatch(/^application\/json/)
        expect(spanNames([{ path: '', contentType: null, body: payload }]).sort()).toEqual([
          'browser.page.vitals',
          'example.action',
        ])
        // A second hide (pagehide after visibilitychange) neither re-sends spans nor re-reports vitals.
        platform.dispatch({ target: 'window', type: 'pagehide', event: new Event('pagehide') })
        expect(platform.beacons.filter((beacon) => beacon.url.endsWith('/v1/traces')).length).toBe(
          1,
        )
        yield* Scope.close(scope, Exit.void)
        expect(receiver.received.filter((entry) => entry.path === '/otlp/v1/traces')).toEqual([])
      }).pipe(Effect.scoped),
  )

  it.live('offline batches are dropped without retry or exporter self-disable', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        telemetryLayer(platform.layer, { metrics: false }),
        scope,
      )
      const telemetry = Context.get(context, BrowserTelemetry.BrowserTelemetry)
      platform.setOnline(false)
      yield* Effect.void.pipe(Effect.withSpan('offline-span'), Effect.provide(context))
      yield* telemetry.flush
      platform.setOnline(true)
      yield* Effect.void.pipe(Effect.withSpan('online-span'), Effect.provide(context))
      yield* Scope.close(scope, Exit.void)
      expect(telemetry.transportStats()).toMatchObject({ droppedOffline: 1, sent: 1 })
      // Back online the exporter is still enabled: the next span arrives, the offline one is gone.
      expect(spanNames(receiver.received)).toEqual(['online-span'])
    }).pipe(Effect.scoped),
  )

  it.live('batches above the relay limit are dropped, not posted', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        telemetryLayer(platform.layer, { metrics: false, transport: { maxBodyBytes: 256 } }),
        scope,
      )
      yield* Effect.void.pipe(Effect.withSpan('too-big'), Effect.provide(context))
      yield* Scope.close(scope, Exit.void)
      expect(
        Context.get(context, BrowserTelemetry.BrowserTelemetry).transportStats(),
      ).toMatchObject({ droppedOversize: 1 })
      expect(receiver.received).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('unsampled sessions stay in the ring but are never exported', () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver
      const platform = makeTestPlatform({ origin: receiver.origin })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        telemetryLayer(platform.layer, { metrics: false, sampler: Sampler.ratio({ value: 0 }) }),
        scope,
      )
      yield* Effect.void.pipe(Effect.withSpan('example.action'), Effect.provide(context))
      yield* Scope.close(scope, Exit.void)
      const ring = Context.get(context, BrowserTelemetry.BrowserTelemetry).ring.getSnapshot().spans
      expect(ring.map((span) => [span.name, span.sampled])).toEqual([['example.action', false]])
      expect(receiver.received).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live(
    'an interaction open at teardown is ended and its histogram reaches /v1/metrics with the browser resource',
    () =>
      Effect.gen(function* () {
        const receiver = yield* otlpReceiver
        const platform = makeTestPlatform({ origin: receiver.origin })
        const scope = yield* Scope.make()
        yield* Layer.buildWithScope(
          Interactions.layer().pipe(
            Layer.provideMerge(telemetryLayer(platform.layer)),
            Layer.provide(platform.layer),
          ),
          scope,
        )
        platform.input({ type: 'pointerdown', timeStamp: 10 })
        platform.paint(26)
        // Closing mid-interaction: teardown ends it, so it still makes the final flush.
        yield* Scope.close(scope, Exit.void)
        const metrics = receiver.received.find((entry) => entry.path === '/otlp/v1/metrics')
        const names = metrics?.body.resourceMetrics?.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.name)),
        )
        expect(names).toContain('browser_interaction_duration_seconds')
        expect(resourceOf(metrics)).toMatchObject({
          'service.name': 'example-web',
          'deployment.environment.name': 'dev',
        })
        expect(spanNames(receiver.received)).toEqual(['browser.interaction'])
      }).pipe(Effect.scoped),
  )
})
