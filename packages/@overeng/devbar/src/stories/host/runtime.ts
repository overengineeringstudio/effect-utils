import { Duration, Effect, Queue, Schema, Stream, SubscriptionRef } from 'effect'
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from 'effect/rpc'
import type { RpcMessage } from 'effect/rpc'

import {
  defaultNormalizationBounds,
  CaptureChannels,
  ExplorerTelemetryNormalizationOutcomes,
  type ExplorerRetainedGaugeRegistration,
} from '@overeng/effect-rpc-explorer'
import {
  counterSource,
  counterToken,
  makeInstrumentation,
  makeMeters,
  makeSeries,
  type FpsValue,
  type NumberValue,
} from '@overeng/meters'
import {
  commitBlock,
  counterBlock,
  fiberBlock,
  frameBlock,
  heapBlock,
  jankBlock,
  numericBlock,
} from '@overeng/meters/canvas'
import { makeBrowserPlatform } from '@overeng/meters/platform/browser'
import { reactCommitsSource, type ReactCommit } from '@overeng/meters/react'
import { fibersSource, runtimeMetricContext, type Fibers } from '@overeng/meters/sources/fibers'
import { frameSource } from '@overeng/meters/sources/frame'
import { longFramesSource, type LongFrameValue } from '@overeng/meters/sources/long-frames'
import { heapSource, type HeapMemory } from '@overeng/meters/sources/memory'
import { OtelMetric } from '@overeng/otel-contract'
import { makeRpcDevtools } from '@overeng/rpc-devtools/core'

/** Acquire the app transport, diagnostics and host stream in one caller-owned scope. */
export const makeHostRuntime = Effect.gen(function* () {
  const context = yield* Effect.context<never>()
  const metricContext = yield* runtimeMetricContext
  const platform = makeBrowserPlatform()
  let retained: ExplorerRetainedGaugeRegistration | undefined
  const tools = yield* makeRpcDevtools({
    group: AppRpc,
    side: 'client',
    meters: {
      id: 'rpc',
      metrics: ['inFlight', 'durationP95', 'errorsPerSecond'],
      windowMillis: 10_000,
      maxCompletions: 512,
      historyCapacity: 2048,
    },
    config: {
      instanceId: 'host-composition',
      bounds: {
        active: { maxCount: 128, maxAge: Duration.minutes(5) },
        completed: { maxCount: 128, maxAge: Duration.minutes(5) },
        deltas: { maxCount: 256, maxAge: Duration.minutes(5) },
        streamValuesPerRecord: 16,
        subscriberQueue: 32,
        normalized: defaultNormalizationBounds,
      },
      telemetry: {
        registerRetainedGauge: (registration) => {
          retained = registration
          return () => {
            retained = undefined
          }
        },
        registerNormalizationHistogram: (registration) => {
          const histogram = OtelMetric.effect.histogram(
            OtelMetric.histogram({
              name: registration.name,
              description: registration.description,
              boundaries: registration.boundaries,
              unit: registration.unit,
              labels: Schema.Struct({
                'rpc.explorer.normalization.outcome': Schema.Literals(
                  ExplorerTelemetryNormalizationOutcomes,
                ),
                'rpc.explorer.capture.channel': Schema.Literals(CaptureChannels),
              }),
            }),
          )
          const record = Effect.runSyncWith(context)
          return (measurement) =>
            record(
              histogram.trustedRecord({
                labels: measurement.attributes,
                value: measurement.value,
              }),
            )
        },
      },
    },
  })

  // Same in-process encoded protocol seam as explorer-react's live-core fixture.
  let deliverToServer: (
    clientId: number,
    message: RpcMessage.FromClientEncoded,
  ) => Effect.Effect<void> = discardBeforeProtocolStarts
  let deliverToClient: (
    clientId: number,
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void> = discardBeforeProtocolStarts
  const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) => {
    deliverToServer = writeRequest
    return Effect.map(Queue.make<number>(), (disconnects) => ({
      disconnects,
      clientIds: Effect.succeed(new Set([0])),
      initialMessage: Effect.succeedNone,
      // oxlint-disable-next-line overeng/named-args -- Effect protocol callback shape.
      send: (clientId, message) => deliverToClient(clientId, message),
      end: () => Effect.void,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: RpcSerialization.json.codecFor,
    }))
  })
  const rawClientProtocol = yield* RpcClient.Protocol.make((writeResponse) => {
    deliverToClient = writeResponse
    return Effect.succeed({
      // oxlint-disable-next-line overeng/named-args -- Effect protocol callback shape.
      send: (clientId, message) => deliverToServer(clientId, message),
      supportsAck: true,
      supportsTransferables: false,
      codecFor: RpcSerialization.json.codecFor,
    })
  })
  yield* RpcServer.make(AppRpc).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol),
    Effect.provide(
      AppRpc.toLayer({
        'Host.LoadProject': ({ projectId }) =>
          Effect.sleep('150 millis').pipe(Effect.as({ projectId, title: 'Shared workspace' })),
      }),
    ),
    Effect.forkScoped,
  )
  const client = yield* RpcClient.make(AppRpc).pipe(
    Effect.provideService(RpcClient.Protocol, tools.decorateClientProtocol(rawClientProtocol)),
  )

  const frames = makeSeries<FpsValue>({
    id: 'frames',
    label: 'Frame rate',
    unit: 'fps',
    capacity: 2048,
  })
  const longFrames = makeSeries<LongFrameValue>({
    id: 'longFrames',
    label: 'Long frames / tasks',
    unit: 'ms',
    capacity: 256,
  })
  const heap = makeSeries<HeapMemory>({
    id: 'heap',
    label: 'Approximate JS heap',
    unit: 'bytes',
    capacity: 256,
  })
  const fibers = makeSeries<Fibers>({
    id: 'fibers',
    label: 'Active child fibers',
    unit: 'count',
    capacity: 256,
  })
  const requests = makeSeries<NumberValue>({
    id: 'host.requests',
    label: 'Host requests sent',
    unit: 'count',
    capacity: 256,
  })
  const commits = makeSeries<ReactCommit>({
    id: 'host.commits',
    label: 'React commits',
    unit: 'ms',
    capacity: 256,
  })
  const requestToken = counterToken({ id: 'host.requests' })
  const commitToken = counterToken({ id: 'host.commits' })
  const instrumentation = makeInstrumentation({ counters: [requestToken, commitToken], gauges: [] })
  const meters = makeMeters({
    platform,
    sources: [
      frameSource({ id: 'frames', series: frames }),
      longFramesSource({ id: 'longFrames', series: longFrames }),
      heapSource({ id: 'heap', series: heap, everyMs: 1000 }),
      fibersSource({ id: 'fibers', series: fibers, everyMs: 250, metricContext }),
      counterSource({
        id: 'host.requests',
        series: requests,
        instrumentation,
        token: requestToken,
      }),
      reactCommitsSource({
        id: 'host.commits',
        series: commits,
        instrumentation,
        counter: commitToken,
      }),
      ...tools.sources,
    ],
  })
  // Bootstrap owns the sole lease; the UI deliberately does not mount MetersProvider.
  yield* meters.start
  const blocks = [
    frameBlock({ id: 'frames', series: frames }),
    jankBlock({ id: 'longFrames', series: longFrames }),
    heapBlock({ id: 'heap', series: heap }),
    fiberBlock({ id: 'fibers', series: fibers }),
    counterBlock({ id: 'host.requests', series: requests }),
    commitBlock({ id: 'host.commits', series: commits }),
    ...tools.sources.map((source) =>
      numericBlock({
        id: source.series.id,
        series: source.series,
        values: (value) => value,
      }),
    ),
  ]

  // This stream is host-supplied status, not a connection owned by the tools.
  const statusRef = yield* SubscriptionRef.make<'Connected' | 'Reconnecting'>('Connected')
  let status: 'Connected' | 'Reconnecting' = 'Connected'
  const listeners = new Set<() => void>()
  yield* Stream.runForEach(SubscriptionRef.changes(statusRef), (value) =>
    Effect.sync(() => {
      status = value
      for (const listener of listeners) listener()
    }),
  ).pipe(Effect.forkScoped)
  return {
    tools,
    meters,
    blocks,
    instrumentation,
    commitToken,
    status: {
      getSnapshot: () => status,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    toggleStatus: Effect.suspend(() =>
      SubscriptionRef.set(statusRef, status === 'Connected' ? 'Reconnecting' : 'Connected'),
    ),
    request: Effect.gen(function* () {
      instrumentation.counter({ token: requestToken }).add({ by: 1 })
      return yield* client['Host.LoadProject']({ projectId: 'shared-workspace' })
    }),
    readRetained: () => retained?.observe() ?? [],
  }
})

/** One enabled host runtime; its transport and tools share the enclosing lifetime. */
export type HostRuntime = Effect.Success<typeof makeHostRuntime>

/** Exact acquisition-error union inferred from the real transport and diagnostic services. */
export type HostRuntimeError = Effect.Error<typeof makeHostRuntime>

const AppRpc = RpcGroup.make(
  Rpc.make('Host.LoadProject', {
    payload: Schema.Struct({ projectId: Schema.String }),
    success: Schema.Struct({ projectId: Schema.String, title: Schema.String }),
  }),
)

// The mutable delivery slots stay per runtime; only their inert initializer is shared.
const discardBeforeProtocolStarts = (): Effect.Effect<void> => Effect.void
