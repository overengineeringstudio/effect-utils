import { Cause, Duration, Effect, Option, Queue, Schema, Stream } from 'effect'
import {
  Rpc,
  RpcClient,
  RpcClientError,
  RpcGroup,
  type RpcMessage,
  RpcSerialization,
  RpcSchema,
  RpcServer,
} from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import type { ExplorerBounds, Timestamp } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import {
  decorateClientProtocol,
  decorateServerProtocol,
  makeProtocolObserver,
  protocolCoordinatorSize,
} from './protocol.ts'
import { makeExplorerStore } from './store.ts'

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
const decodeJsonString = Schema.decodeUnknownOption(RpcSerialization.json.codecFor(Schema.String))
const decodeJsonDefect = Schema.decodeUnknownOption(RpcSerialization.json.codecFor(Schema.Defect()))

const descriptorForTag = (tag: string) =>
  tag === 'Echo'
    ? {
        descriptorId: 'rpc:Echo',
        payloadSchema: Schema.String,
        successSchema: Schema.String,
        errorSchema: Schema.String,
        defectSchema: Schema.Defect(),
        encodedDecoders: {
          requestPayload: decodeJsonString,
          success: decodeJsonString,
          typedFailure: decodeJsonString,
          defect: decodeJsonDefect,
          streamElement: decodeJsonString,
          streamError: decodeJsonString,
        },
        policies: {
          requestPayload: { _tag: 'redact' as const, transform: () => '[redacted]' },
          success: { _tag: 'reveal' as const },
          typedFailure: { _tag: 'reveal' as const },
          defect: { _tag: 'redact' as const, transform: () => '[defect]' },
          streamElement: { _tag: 'reveal' as const },
        },
      }
    : undefined

const request: RpcMessage.RequestEncoded = {
  _tag: 'Request',
  id: 1,
  tag: 'Echo',
  payload: 'raw-secret',
  headers: [['authorization', 'raw-token']],
}

const makeClientProtocol = (
  send: RpcClient.Protocol['Service']['send'] = () => Effect.void,
): RpcClient.Protocol['Service'] => ({
  run: () => Effect.never,
  send,
  supportsAck: true,
  supportsTransferables: true,
  codecFor: RpcSerialization.json.codecFor,
})

describe('client protocol decorator', () => {
  it('normalizes before retention and preserves capabilities', async () => {
    const store = makeExplorerStore({ instanceId: 'client', bounds })
    const original = makeClientProtocol()
    const decorated = decorateClientProtocol(original, {
      store,
      descriptorForTag,
      connectionId: (clientId) => `client-${clientId}`,
      timestamp: makeClock(),
    })

    await Effect.runPromise(decorated.send(7, request))

    expect(decorated.supportsAck).toBe(original.supportsAck)
    expect(decorated.supportsTransferables).toBe(original.supportsTransferables)
    expect(decorated.codecFor).toBe(original.codecFor)
    expect(store.snapshot().active[0]).toMatchObject({
      descriptorId: 'rpc:Echo',
      send: 'sent',
    })
    const serialized = JSON.stringify(store.snapshot())
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toContain('raw-secret')
    expect(serialized).not.toContain('raw-token')
  })

  it('records send failure without replacing the transport error', async () => {
    const store = makeExplorerStore({ instanceId: 'client', bounds })
    const transportError = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: 'transport failed',
        cause: 'transport-cause',
      }),
    })
    const decorated = decorateClientProtocol(
      makeClientProtocol(() => Effect.fail(transportError)),
      {
        store,
        descriptorForTag,
        timestamp: makeClock(),
      },
    )

    const exit = await Effect.runPromiseExit(decorated.send(7, request))

    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(transportError)
    }
    expect(store.snapshot().completed[0]?.state).toBe('sendFailed')
    expect(JSON.stringify(store.snapshot())).not.toContain('transport-cause')
  })
})

const makeServerProtocol = (): RpcServer.Protocol['Service'] => ({
  run: (callback) => callback(3, request).pipe(Effect.andThen(Effect.never)),
  disconnects: Effect.runSync(Queue.make<number>()),
  send: () => Effect.void,
  end: () => Effect.void,
  clientIds: Effect.succeed(new Set([3])),
  initialMessage: Effect.succeedNone,
  supportsAck: true,
  supportsTransferables: true,
  supportsSpanPropagation: true,
  supportsNotifications: true,
  codecFor: RpcSerialization.json.codecFor,
})

describe('server protocol decorator', () => {
  it('captures chunk batches, terminal values, and disconnects while preserving capabilities', async () => {
    const store = makeExplorerStore({ instanceId: 'server', bounds })
    const original = makeServerProtocol()
    const decorated = decorateServerProtocol(original, {
      store,
      descriptorForTag,
      timestamp: makeClock(),
    })

    await Effect.runPromiseExit(decorated.run(() => Effect.die('stop')))
    await Effect.runPromise(decorated.send(3, { _tag: 'Chunk', requestId: 1, values: ['a', 'b'] }))
    await Effect.runPromise(
      decorated.send(3, {
        _tag: 'Exit',
        requestId: 1,
        exit: { _tag: 'Success', value: 'done' },
      }),
    )
    await Effect.runPromise(decorated.end(3))

    expect(decorated.supportsAck).toBe(original.supportsAck)
    expect(decorated.supportsTransferables).toBe(original.supportsTransferables)
    expect(decorated.supportsSpanPropagation).toBe(original.supportsSpanPropagation)
    expect(decorated.supportsNotifications).toBe(original.supportsNotifications)
    expect(decorated.codecFor).toBe(original.codecFor)
    expect(decorated.clientIds).toBe(original.clientIds)
    expect(decorated.initialMessage).toBe(original.initialMessage)
    expect(store.snapshot().completed[0]).toMatchObject({
      chunkEnvelopes: 1,
      streamValues: 2,
      state: 'succeeded',
    })
    expect(store.snapshot().events.some((event) => event._tag === 'ConnectionFault')).toBe(true)
    expect(JSON.stringify(store.snapshot())).not.toContain('raw-secret')
  })

  it('treats server-side EOF as a transport fact so in-flight terminals still land', async () => {
    const store = makeExplorerStore({ instanceId: 'server-eof', bounds })
    // Mirrors the HTTP protocol, which delivers EOF after every request batch
    // while responses are still pending.
    const original: RpcServer.Protocol['Service'] = {
      ...makeServerProtocol(),
      run: (callback) =>
        callback(3, request).pipe(
          Effect.andThen(callback(3, { _tag: 'Eof' })),
          Effect.andThen(Effect.never),
        ),
    }
    const decorated = decorateServerProtocol(original, {
      store,
      descriptorForTag,
      timestamp: makeClock(),
    })

    let runCalls = 0
    await Effect.runPromiseExit(
      decorated.run(() => (runCalls++ === 0 ? Effect.void : Effect.die('stop'))),
    )

    await Effect.runPromise(
      decorated.send(3, { _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: 'done' } }),
    )

    expect(store.snapshot().completed[0]).toMatchObject({ state: 'succeeded' })
    expect(store.snapshot().events.some((event) => event._tag === 'TerminalObserved')).toBe(true)
    expect(store.snapshot().events.some((event) => event._tag === 'ConnectionFault')).toBe(false)
  })
})

describe('server disconnect queue preservation', () => {
  it('keeps the original bounded queue identity without spawning a passive reader', async () => {
    const disconnects = Effect.runSync(Queue.bounded<number>(1))
    const original = { ...makeServerProtocol(), disconnects }
    const decorated = decorateServerProtocol(original, {
      store: makeExplorerStore({ instanceId: 'disconnect-identity', bounds }),
      descriptorForTag,
      timestamp: makeClock(),
    })

    expect(decorated.disconnects).toBe(disconnects)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(decorated.run(() => Effect.never))
          yield* Effect.yieldNow
          yield* Queue.offer(disconnects, 73)
          yield* Effect.yieldNow
          expect(yield* Queue.size(disconnects)).toBe(1)
          expect(yield* Queue.isFull(disconnects)).toBe(true)
        }),
      ),
    )
  })
})

describe('real in-memory RPC transport', () => {
  it('preserves unary and acknowledged stream behavior with both decorators active', async () => {
    const EchoRpc = Rpc.make('SmokeEcho', {
      payload: Schema.String,
      success: Schema.String,
    })
    const StreamNumbers = Rpc.make('SmokeNumbers', {
      payload: {},
      success: Schema.Finite,
      stream: true,
    })
    const Api = RpcGroup.make(EchoRpc, StreamNumbers)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          SmokeEcho: (payload) => Effect.succeed(`reply:${payload}`),
          SmokeNumbers: () => Stream.make(1, 2, 3),
        }),
      ),
    )
    const store = makeExplorerStore({ instanceId: 'in-memory', bounds })
    const timestamp = makeClock()
    const smokeDescriptorForTag = (tag: string) => {
      const rpc = Api.requests.get(tag)
      if (rpc === undefined) return undefined
      return {
        descriptorId: `rpc:${rpc._tag}`,
        payloadSchema: rpc.payloadSchema,
        successSchema: rpc.successSchema,
        errorSchema: rpc.errorSchema,
        defectSchema: rpc.defectSchema,
        policies: {
          success: { _tag: 'reveal' as const },
          streamElement: { _tag: 'reveal' as const },
        },
      }
    }

    const result = await Effect.gen(function* () {
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
      const observedServer = decorateServerProtocol(serverProtocol, {
        store,
        timestamp,
        descriptorForTag: smokeDescriptorForTag,
      })
      const observedClient = decorateClientProtocol(clientProtocol, {
        store,
        timestamp,
        descriptorForTag: smokeDescriptorForTag,
      })

      yield* RpcServer.make(Api).pipe(
        Effect.provideService(RpcServer.Protocol, observedServer),
        Effect.provide(handlers),
        Effect.forkScoped,
      )
      const client = yield* RpcClient.make(Api).pipe(
        Effect.provideService(RpcClient.Protocol, observedClient),
      )
      const unary = yield* client.SmokeEcho('hello')
      const streamed = yield* client.SmokeNumbers({}).pipe(Stream.runCollect)
      return { unary, streamed }
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(result.unary).toBe('reply:hello')
    expect(result.streamed).toEqual([1, 2, 3])
    const eventTags = store.snapshot().events.map((event) => event._tag)
    expect(eventTags).toContain('ChunkObserved')
    expect(eventTags).toContain('AckObserved')
    expect(eventTags).toContain('TerminalObserved')
  })
})

describe('protocol coordinator retention', () => {
  it('bounds terminal dedupe tombstones without losing immediate suppression or ID reuse', () => {
    const store = makeExplorerStore({ instanceId: 'bounded-coordinator', bounds })
    const observer = makeProtocolObserver(
      {
        store,
        timestamp: makeClock(),
        coordinatorCapacity: 2,
        descriptorForTag,
      },
      'client',
    )

    let newestIdentity: ReturnType<typeof observer.request> | undefined
    for (const id of [1, 2, 3]) {
      const identity = observer.request({
        clientId: 1,
        direction: 'clientToServer',
        message: { ...request, id },
      })
      observer.terminalValue({ identity, outcome: 'success', values: [] })
      newestIdentity = identity
    }

    expect(protocolCoordinatorSize(store)).toBe(2)
    expect(newestIdentity).toBeDefined()
    if (newestIdentity === undefined) return
    const eventsBeforeDuplicate = store.snapshot().events.length
    observer.terminalValue({ identity: newestIdentity, outcome: 'success', values: [] })
    expect(store.snapshot().events).toHaveLength(eventsBeforeDuplicate)

    const reusedIdentity = observer.request({
      clientId: 1,
      direction: 'clientToServer',
      message: { ...request, id: 3 },
    })
    observer.terminalValue({ identity: reusedIdentity, outcome: 'success', values: [] })
    expect(protocolCoordinatorSize(store)).toBe(2)
    expect(store.snapshot().completed.some((record) => record.key.requestId.value === 3)).toBe(true)
  })
})

describe('normalization telemetry', () => {
  it('reports captured channels without values and ignores omissions', () => {
    const store = makeExplorerStore({ instanceId: 'normalization-telemetry', bounds })
    const measurements: Array<{
      readonly channel: string
      readonly outcome: string
      readonly durationSeconds: number
    }> = []
    const observer = makeProtocolObserver(
      {
        store,
        timestamp: makeClock(),
        descriptorForTag: () => ({
          descriptorId: 'rpc:Measured',
          payloadSchema: Schema.String,
          successSchema: Schema.String,
          encodedDecoders: { requestPayload: decodeJsonString },
          policies: {
            requestPayload: { _tag: 'redact', transform: () => '[payload]' },
            headers: { _tag: 'redact', transform: () => '[headers]' },
          },
        }),
        onNormalization: (measurement) => {
          measurements.push(measurement)
          throw new Error('telemetry callback defects must not affect observation')
        },
      },
      'client',
    )

    const identity = observer.request({
      clientId: 1,
      direction: 'clientToServer',
      message: { ...request, tag: 'Measured' },
    })
    observer.terminalValue({
      identity,
      outcome: 'success',
      values: [{ channel: 'success', value: 'omitted-success' }],
    })

    expect(measurements).toHaveLength(2)
    expect(measurements.map(({ channel, outcome }) => ({ channel, outcome }))).toEqual([
      { channel: 'requestPayload', outcome: 'success' },
      { channel: 'headers', outcome: 'success' },
    ])
    expect(
      measurements.every(
        ({ durationSeconds }) => Number.isFinite(durationSeconds) === true && durationSeconds >= 0,
      ),
    ).toBe(true)
    expect(JSON.stringify(measurements)).not.toContain('raw-secret')
    expect(JSON.stringify(measurements)).not.toContain('raw-token')
    expect(JSON.stringify(measurements)).not.toContain('omitted-success')
  })
})

describe('unmapped descriptor safety', () => {
  it('never retains an arbitrary wire tag while preserving request identity', () => {
    const store = makeExplorerStore({ instanceId: 'unknown-descriptor', bounds })
    const subscription = store.watch()
    const observer = makeProtocolObserver(
      {
        store,
        timestamp: makeClock(),
        descriptorForTag: () => undefined,
      },
      'server',
    )
    const unknownTag = 'x'.repeat(1024 * 1024)

    observer.request({
      clientId: 17,
      direction: 'clientToServer',
      message: {
        _tag: 'Request',
        id: 'unknown-request',
        tag: unknownTag,
        payload: 'must-stay-omitted',
        headers: [['authorization', 'must-stay-omitted']],
      },
    })

    const snapshot = store.snapshot()
    const watchFrames = subscription.drain()
    subscription.close()
    expect(snapshot.active[0]).toMatchObject({
      descriptorId: 'unknown:unmapped',
      key: {
        connectionId: '17',
        requestId: { _tag: 'String', value: 'unknown-request' },
      },
    })
    expect(
      snapshot.events
        .filter((event) => event._tag === 'RequestObserved')
        .flatMap((event) => event.observations)
        .every((observation) => observation.outcome._tag === 'Omitted'),
    ).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(unknownTag)
    expect(JSON.stringify(watchFrames)).not.toContain(unknownTag)
    expect(JSON.stringify(snapshot)).not.toContain('must-stay-omitted')
    expect(JSON.stringify(watchFrames)).not.toContain('must-stay-omitted')
  })
})

describe('stream normalization bounds', () => {
  it('normalizes only the remaining retained values while counting the full chunk', () => {
    const store = makeExplorerStore({ instanceId: 'bounded-stream-normalization', bounds })
    let transformCalls = 0
    const transport = makeClientProtocol()
    const streamElementSchema = Schema.Finite
    const observer = makeProtocolObserver(
      {
        store,
        timestamp: makeClock(),
        streamValuesPerRecord: 3,
        descriptorForTag: () => ({
          descriptorId: 'rpc:LargeStream',
          successSchema: RpcSchema.Stream(streamElementSchema, Schema.String),
          encodedDecoders: {
            streamElement: Schema.decodeUnknownOption(transport.codecFor(streamElementSchema)),
          },
          policies: {
            streamElement: {
              _tag: 'redact',
              transform: () => {
                transformCalls += 1
                return '[stream-value]'
              },
            },
          },
        }),
      },
      'client',
    )
    const identity = observer.request({
      clientId: 3,
      direction: 'clientToServer',
      message: { ...request, tag: 'LargeStream' },
    })
    const values: [number, ...Array<number>] = [
      0,
      ...Array.from({ length: 9_999 }, (_, index) => index + 1),
    ]

    observer.chunk(3, 'clientToServer', {
      _tag: 'Chunk',
      requestId: identity.requestId.value,
      values,
    })

    expect(transformCalls).toBe(3)
    expect(store.snapshot().active[0]).toMatchObject({
      chunkEnvelopes: 1,
      streamValues: 10_000,
      retainedStreamValues: 3,
    })
    const chunkEvent = store.snapshot().events.find((event) => event._tag === 'ChunkObserved')
    expect(chunkEvent).toMatchObject({
      _tag: 'ChunkObserved',
      valueCount: 10_000,
      values: [{}, {}, {}],
    })
  })
})

describe('wire schema decoding', () => {
  it('restores nested Schema.Redacted wrappers before protocol request normalization', async () => {
    const store = makeExplorerStore({ instanceId: 'wire-redacted-schema', bounds })
    const transport = makeClientProtocol()
    const payloadSchema = Schema.Struct({
      visible: Schema.String,
      nested: Schema.Struct({
        credential: Schema.Redacted(Schema.String),
      }),
    })
    const protocol = decorateClientProtocol(transport, {
      store,
      timestamp: makeClock(),
      descriptorForTag: () => ({
        descriptorId: 'rpc:CredentialRequest',
        payloadSchema,
        encodedDecoders: {
          requestPayload: Schema.decodeUnknownOption(transport.codecFor(payloadSchema)),
        },
        policies: { requestPayload: { _tag: 'reveal' } },
      }),
    })

    await Effect.runPromise(
      protocol.send(1, {
        _tag: 'Request',
        id: 'credential-request',
        tag: 'CredentialRequest',
        payload: {
          visible: 'safe',
          nested: { credential: 'must-never-be-retained' },
        },
        headers: [],
      }),
    )

    const snapshot = store.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('must-never-be-retained')
    const requestEvent = snapshot.events.find((event) => event._tag === 'RequestObserved')
    const payloadObservation =
      requestEvent?._tag === 'RequestObserved'
        ? requestEvent.observations.find((observation) => observation.channel === 'requestPayload')
        : undefined
    expect(payloadObservation).toMatchObject({
      channel: 'requestPayload',
      outcome: {
        _tag: 'Captured',
      },
      captured: {
        _tag: 'Object',
        value: {
          nested: {
            _tag: 'Object',
            value: { credential: { _tag: 'Redacted' } },
          },
          visible: { _tag: 'String', value: 'safe' },
        },
      },
    })
  })
})

describe('terminal cause normalization bounds', () => {
  it('bounds captured causes while still classifying the complete Exit', () => {
    const store = makeExplorerStore({ instanceId: 'bounded-terminal-causes', bounds })
    let transformCalls = 0
    const observer = makeProtocolObserver(
      {
        store,
        timestamp: makeClock(),
        normalizationBounds: { ...defaultNormalizationBounds, maxEntries: 4 },
        descriptorForTag: () => ({
          descriptorId: 'rpc:LargeCause',
          errorSchema: Schema.String,
          defectSchema: Schema.String,
          encodedDecoders: {
            typedFailure: decodeJsonString,
            defect: decodeJsonString,
          },
          policies: {
            typedFailure: {
              _tag: 'redact',
              transform: () => {
                transformCalls += 1
                return '[failure]'
              },
            },
            defect: {
              _tag: 'redact',
              transform: () => {
                transformCalls += 1
                return '[defect]'
              },
            },
          },
        }),
      },
      'client',
    )
    const identity = observer.request({
      clientId: 5,
      direction: 'clientToServer',
      message: { ...request, id: 'large-cause', tag: 'LargeCause' },
    })

    observer.terminal(5, 'clientToServer', {
      _tag: 'Exit',
      requestId: identity.requestId.value,
      exit: {
        _tag: 'Failure',
        cause: [
          ...Array.from({ length: 10_000 }, (_, index) => ({
            _tag: 'Fail' as const,
            error: String(index),
          })),
          { _tag: 'Die', defect: 'last-defect' },
        ],
      },
    })

    expect(transformCalls).toBe(4)
    const terminalEvent = store.snapshot().events.find((event) => event._tag === 'TerminalObserved')
    expect(terminalEvent).toMatchObject({
      _tag: 'TerminalObserved',
      outcome: 'defect',
      observations: [{}, {}, {}, {}],
    })
  })
})
