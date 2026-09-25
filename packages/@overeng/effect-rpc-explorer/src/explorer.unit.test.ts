import { Duration, Effect, Layer, Metric, Queue, Schema, Tracer } from 'effect'
import { Headers } from 'effect/unstable/http'
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcMessage,
  RpcSerialization,
  RpcServer,
} from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { RpcExplorerCapture } from './descriptor.ts'
import { makeExplorer } from './explorer.ts'
import { ClearHistory, GetSnapshot, Watch } from './inspector.ts'
import type { ExplorerBounds, Timestamp } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import type {
  ExplorerNormalizationHistogramMeasurement,
  ExplorerNormalizationHistogramRegistration,
  ExplorerRetainedGaugeRegistration,
} from './telemetry.ts'

const bounds: ExplorerBounds = {
  active: { maxCount: 16, maxAge: Duration.seconds(10) },
  completed: { maxCount: 16, maxAge: Duration.seconds(10) },
  streamValuesPerRecord: 16,
  normalized: defaultNormalizationBounds,
  deltas: { maxCount: 32, maxAge: Duration.seconds(10) },
  subscriberQueue: 16,
}

const makeClock = (): (() => Timestamp) => {
  let value = 0
  return () => {
    value += 1
    return { monotonicNanos: String(value), wallClockMillis: value }
  }
}

const SecretEcho = Rpc.make('SecretEcho', {
  payload: Schema.String,
  success: Schema.String,
})
const Application = RpcGroup.make(SecretEcho)
const HostApi = RpcGroup.make(SecretEcho, GetSnapshot, Watch, ClearHistory)

const applicationHandlers = Application.toLayer(
  Effect.succeed(
    Application.of({
      SecretEcho: (payload) => Effect.succeed(`reply:${payload}`),
    }),
  ),
)

describe('explorer composition', () => {
  it('observes a real RPC, redacts content, excludes inspector traffic, and cleans up metrics', async () => {
    let retainedGauge: ExplorerRetainedGaugeRegistration | undefined
    let histogram: ExplorerNormalizationHistogramRegistration | undefined
    const normalizationMeasurements: Array<ExplorerNormalizationHistogramMeasurement> = []
    let unregisterCount = 0
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })

    const result = await Effect.gen(function* () {
      const timestamp = makeClock()
      const explorer = yield* makeExplorer({
        group: Application,
        config: {
          instanceId: 'composition-test',
          bounds,
          capture: {
            requestPayload: { _tag: 'redact', transform: () => '[request-redacted]' },
            success: { _tag: 'redact', transform: () => '[success-redacted]' },
          },
          clock: { now: timestamp },
          connectionId: ({ observerSide, clientId }) => `${observerSide}-${clientId}`,
          telemetry: {
            registerRetainedGauge: (registration) => {
              retainedGauge = registration
              return () => {
                unregisterCount += 1
              }
            },
            registerNormalizationHistogram: (registration) => {
              histogram = registration
              return (measurement) => {
                normalizationMeasurements.push(measurement)
              }
            },
          },
        },
      })

      let deliverToServer: (
        clientId: number,
        message: RpcMessage.FromClientEncoded,
      ) => Effect.Effect<void> = () => Effect.void
      let deliverToClient: (
        clientId: number,
        message: RpcMessage.FromServerEncoded,
      ) => Effect.Effect<void> = () => Effect.void

      const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) => {
        deliverToServer = writeRequest
        return Effect.map(Queue.make<number>(), (disconnects) => ({
          disconnects,
          send: (clientId, message) => deliverToClient(clientId, message),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set<number>()),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: RpcSerialization.json.codecFor,
        }))
      })
      const clientProtocol = yield* RpcClient.Protocol.make((writeResponse) => {
        deliverToClient = writeResponse
        return Effect.succeed({
          send: (clientId, message) => deliverToServer(clientId, message),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
        })
      })
      const serverStringDecoder = Schema.decodeUnknownOption(serverProtocol.codecFor(Schema.String))
      const clientStringDecoder = Schema.decodeUnknownOption(clientProtocol.codecFor(Schema.String))
      const observedServer = explorer.decorateServerProtocol({
        protocol: serverProtocol,
        encodedDecodersByTag: new Map([
          [
            'SecretEcho',
            {
              requestPayload: serverStringDecoder,
              success: serverStringDecoder,
            },
          ],
        ]),
      })
      const observedClient = explorer.decorateClientProtocol({
        protocol: clientProtocol,
        encodedDecodersByTag: new Map([
          [
            'SecretEcho',
            {
              requestPayload: clientStringDecoder,
              success: clientStringDecoder,
            },
          ],
        ]),
      })
      const handlers = Layer.merge(applicationHandlers, explorer.inspector.layer)

      yield* RpcServer.make(HostApi).pipe(
        Effect.provideService(RpcServer.Protocol, observedServer),
        Effect.provide(handlers),
        Effect.forkScoped,
      )
      const client = yield* RpcClient.make(HostApi).pipe(
        Effect.provideService(RpcClient.Protocol, observedClient),
      )

      const echo = yield* client.SecretEcho('raw-request-secret')
      const remoteSnapshot = yield* client['RpcExplorer.GetSnapshot']({})
      const afterRemoteInspector = explorer.store.snapshot()

      yield* explorer
        .middleware(Effect.die('excluded-inspector-handler'), {
          client: new Rpc.ServerClient(77),
          requestId: RpcMessage.RequestId('separately-bound-inspector'),
          rpc: GetSnapshot,
          payload: {},
          headers: Headers.empty,
        })
        .pipe(Effect.exit)
      const afterSeparateMiddleware = explorer.store.snapshot()

      return {
        echo,
        remoteSnapshot,
        afterRemoteInspector,
        afterSeparateMiddleware,
        descriptors: explorer.descriptors,
        gauge: retainedGauge?.observe(),
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.runPromise,
    )

    expect(result.echo).toBe('reply:raw-request-secret')
    expect(result.descriptors.map((descriptor) => descriptor.tag)).toEqual(['SecretEcho'])
    expect(result.remoteSnapshot.descriptors.map((descriptor) => descriptor.tag)).toEqual([
      'SecretEcho',
    ])
    expect(result.afterRemoteInspector.revision).toBe(result.remoteSnapshot.revision)
    expect(result.afterSeparateMiddleware.revision).toBe(result.remoteSnapshot.revision)
    expect(result.afterRemoteInspector.completed).toHaveLength(2)

    const retained = JSON.stringify(result.afterRemoteInspector)
    expect(retained).toContain('[request-redacted]')
    expect(retained).toContain('[success-redacted]')
    expect(retained).not.toContain('raw-request-secret')
    expect(retained).not.toContain('reply:raw-request-secret')
    expect(retained).not.toContain('RpcExplorer.GetSnapshot')
    expect(result.gauge).toEqual([
      {
        value: 0,
        attributes: { 'rpc.explorer.record.kind': 'active' },
      },
      {
        value: 2,
        attributes: { 'rpc.explorer.record.kind': 'completed' },
      },
    ])
    expect(retainedGauge?.name).toBe('rpc.explorer.retained')
    expect(histogram?.name).toBe('rpc.explorer.normalization.duration')
    expect(normalizationMeasurements).toHaveLength(4)
    expect(
      normalizationMeasurements
        .map((measurement) => measurement.attributes)
        .toSorted((left, right) =>
          left['rpc.explorer.capture.channel'].localeCompare(right['rpc.explorer.capture.channel']),
        ),
    ).toEqual([
      {
        'rpc.explorer.capture.channel': 'requestPayload',
        'rpc.explorer.normalization.outcome': 'success',
      },
      {
        'rpc.explorer.capture.channel': 'requestPayload',
        'rpc.explorer.normalization.outcome': 'success',
      },
      {
        'rpc.explorer.capture.channel': 'success',
        'rpc.explorer.normalization.outcome': 'success',
      },
      {
        'rpc.explorer.capture.channel': 'success',
        'rpc.explorer.normalization.outcome': 'success',
      },
    ])
    expect(JSON.stringify(normalizationMeasurements)).not.toContain('raw-request-secret')
    expect(unregisterCount).toBe(1)
    expect(spans.some((span) => span.name === 'rpc.explorer.pipeline.fault')).toBe(false)
  })

  it('resolves per-RPC host and annotation policies once for protocol and middleware observations', async () => {
    const hostOverride = Rpc.make('HostOverride', {
      payload: Schema.String,
      success: Schema.String,
    }).annotate(RpcExplorerCapture, {
      requestPayload: { _tag: 'reveal' },
      defect: { _tag: 'reveal' },
    })
    const rpcFallback = Rpc.make('RpcFallback', {
      payload: Schema.String,
      success: Schema.String,
    }).annotate(RpcExplorerCapture, { defect: { _tag: 'reveal' } })
    const unannotated = Rpc.make('Unannotated', {
      payload: Schema.String,
      success: Schema.String,
    })
    const selected: Array<string> = []
    const result = await Effect.gen(function* () {
      const explorer = yield* makeExplorer({
        group: RpcGroup.make(hostOverride, rpcFallback, unannotated),
        config: {
          instanceId: 'per-rpc-capture',
          bounds,
          capture: ({ tag, key, kind }) => {
            selected.push(tag)
            expect(key).toContain(tag)
            expect(kind).toBe(tag === 'RpcExplorer.Watch' ? 'stream' : 'unary')
            return tag === 'HostOverride'
              ? { requestPayload: { _tag: 'omit' }, defect: { _tag: 'omit' } }
              : tag === 'Unannotated'
                ? { requestPayload: { _tag: 'reveal' } }
                : tag === 'RpcFallback'
                  ? { requestPayload: { _tag: 'omit' } }
                  : undefined
          },
          telemetry: {
            registerRetainedGauge: () => () => {},
            registerNormalizationHistogram: () => () => {},
          },
        },
      })
      const protocol = explorer.decorateClientProtocol({
        protocol: {
          run: () => Effect.never,
          send: () => Effect.void,
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
        },
        encodedDecodersByTag: new Map([
          ['HostOverride', { requestPayload: Schema.decodeUnknownOption(Schema.String) }],
          ['Unannotated', { requestPayload: Schema.decodeUnknownOption(Schema.String) }],
        ]),
      })
      yield* protocol.send(1, {
        _tag: 'Request',
        id: 1,
        tag: 'HostOverride',
        payload: 'secret-host',
        headers: [],
      })
      yield* protocol.send(1, {
        _tag: 'Request',
        id: 2,
        tag: 'Unannotated',
        payload: 'visible-host',
        headers: [],
      })
      for (const [index, rpc] of [hostOverride, rpcFallback, unannotated].entries()) {
        yield* explorer
          .middleware(Effect.die(`reply-${rpc._tag}`), {
            client: new Rpc.ServerClient(7),
            requestId: RpcMessage.RequestId(`middleware-${index}`),
            rpc,
            payload: `payload-${rpc._tag}`,
            headers: Headers.empty,
          })
          .pipe(Effect.exit)
      }
      return explorer.store.snapshot()
    }).pipe(
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.runPromise,
    )

    const request = (tag: string, side: 'client' | 'server') =>
      result.events.find(
        (event) =>
          event._tag === 'RequestObserved' &&
          event.descriptorId.endsWith(`/Rpc/${tag}`) &&
          event.request.observerSide === side,
      )
    const terminal = (index: number) =>
      result.events.find(
        (event) =>
          event._tag === 'TerminalObserved' &&
          event.request.requestId.value === `middleware-${index}`,
      )
    expect(request('HostOverride', 'client')).toMatchObject({
      observations: expect.arrayContaining([
        { channel: 'requestPayload', outcome: { _tag: 'Omitted', source: 'host' } },
      ]),
    })
    expect(request('Unannotated', 'client')).toMatchObject({
      observations: expect.arrayContaining([
        {
          channel: 'requestPayload',
          outcome: { _tag: 'Captured', mode: 'reveal', source: 'host' },
          captured: { _tag: 'String', value: 'visible-host' },
        },
      ]),
    })
    expect(request('HostOverride', 'server')).toMatchObject({
      observations: expect.arrayContaining([
        { channel: 'requestPayload', outcome: { _tag: 'Omitted', source: 'host' } },
      ]),
    })
    expect(terminal(0)).toMatchObject({
      observations: expect.arrayContaining([
        { channel: 'defect', outcome: { _tag: 'Omitted', source: 'host' } },
      ]),
    })
    expect(terminal(1)).toMatchObject({
      observations: expect.arrayContaining([
        {
          channel: 'defect',
          outcome: { _tag: 'Captured', mode: 'reveal', source: 'rpc' },
          captured: { _tag: 'String', value: 'reply-RpcFallback' },
        },
      ]),
    })
    expect(terminal(2)).toMatchObject({
      observations: expect.arrayContaining([
        { channel: 'defect', outcome: { _tag: 'Omitted', source: 'default' } },
      ]),
    })
    expect(selected).toEqual([
      'HostOverride',
      'RpcFallback',
      'Unannotated',
      'RpcExplorer.GetSnapshot',
      'RpcExplorer.Watch',
      'RpcExplorer.ClearHistory',
    ])
    expect(JSON.stringify(result)).not.toContain('secret-host')
    expect(JSON.stringify(result)).not.toContain('reply-HostOverride')
  })
})
