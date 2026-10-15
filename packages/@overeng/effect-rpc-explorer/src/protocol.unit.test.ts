import { Cause, Duration, Effect, Option, Schema } from 'effect'
import { RpcClientError, RpcSchema, RpcSerialization } from 'effect/rpc'
import type { RpcClient, RpcMessage } from 'effect/rpc'
import { describe, expect, it } from 'vitest'

import { decorateClientProtocol, makeProtocolObserver } from '@overeng/effect-rpc-observer'
import type { CaptureSink, RequestIdentity, Timestamp } from '@overeng/effect-rpc-observer'

import type { ExplorerBounds } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import { makeCaptureSink } from './protocol.ts'
import type { MakeCaptureSinkOptions } from './protocol.ts'
import { makeExplorerStore } from './store.ts'

const bounds: ExplorerBounds = {
  active: { maxCount: 16, maxAge: Duration.seconds(10) },
  completed: { maxCount: 16, maxAge: Duration.seconds(10) },
  streamValuesPerRecord: 16,
  normalized: defaultNormalizationBounds,
  deltas: { maxCount: 32, maxAge: Duration.seconds(10) },
  subscriberQueue: 16,
}
const at: Timestamp = { monotonicNanos: '1', wallClockMillis: 1 }
const identity: RequestIdentity = {
  observerSide: 'client',
  connectionId: 'host-7',
  direction: 'clientToServer',
  requestId: { _tag: 'Number', value: 1 },
}
const request: RpcMessage.RequestEncoded = {
  _tag: 'Request',
  id: 1,
  tag: 'Echo',
  payload: 'raw-secret',
  headers: [['authorization', 'raw-token']],
  traceId: 'trace-1',
  spanId: 'span-1',
  sampled: true,
}
const makeClientProtocol = (
  options: {
    readonly send?: RpcClient.Protocol['Service']['send']
  } = {},
): RpcClient.Protocol['Service'] => ({
  run: () => Effect.never,
  send: options.send ?? (() => Effect.void),
  supportsAck: true,
  supportsTransferables: true,
  codecFor: RpcSerialization.json.codecFor,
})
const decodeString = Schema.decodeUnknownOption(RpcSerialization.json.codecFor(Schema.String))
const descriptorForTag: MakeCaptureSinkOptions['descriptorForTag'] = (tag) =>
  tag === 'Echo'
    ? {
        descriptorId: 'rpc:Echo',
        payloadSchema: Schema.String,
        successSchema: Schema.String,
        errorSchema: Schema.String,
        defectSchema: Schema.String,
        encodedDecoders: {
          requestPayload: decodeString,
          success: decodeString,
          typedFailure: decodeString,
          defect: decodeString,
        },
        policies: {
          requestPayload: { _tag: 'redact', transform: () => '[redacted]' },
          success: { _tag: 'reveal' },
          typedFailure: { _tag: 'reveal' },
          defect: { _tag: 'redact', transform: () => '[defect]' },
        },
      }
    : undefined

const start = (options: { readonly sink: CaptureSink; readonly tag?: string }) => {
  options.sink.onMessage({
    clientId: 7,
    connectionId: identity.connectionId,
    at,
    direction: 'clientToServer',
    phase: 'sendAttempted',
    message: { ...request, tag: options.tag ?? request.tag },
  })
  options.sink.onRequest({ identity, at, tag: options.tag ?? request.tag, notification: false }, [
    { channel: 'payload', encoding: 'encoded', value: request.payload },
    { channel: 'headers', encoding: 'encoded', value: request.headers },
  ])
}

describe('explorer capture sink', () => {
  it('normalizes before retention and preserves trace and control-envelope evidence', () => {
    const store = makeExplorerStore({ instanceId: 'capture', bounds })
    const sink = makeCaptureSink({ store, side: 'client', descriptorForTag })
    start({ sink })
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'clientToServer',
      phase: 'sendFinished',
      message: request,
      succeeded: true,
    })
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'clientToServer',
      phase: 'sendAttempted',
      message: { _tag: 'Ack', requestId: 1 },
    })
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'clientToServer',
      phase: 'sendAttempted',
      message: { _tag: 'Interrupt', requestId: 1 },
    })
    expect(store.snapshot().active[0]).toMatchObject({
      descriptorId: 'rpc:Echo',
      send: 'sent',
      trace: {
        traceId: 'trace-1',
        spanId: 'span-1',
        sampled: true,
      },
    })
    expect(store.snapshot().events.map((event) => event._tag)).toEqual([
      'RequestObserved',
      'SendAttempted',
      'SendSucceeded',
      'AckObserved',
      'InterruptObserved',
    ])
    const serialized = JSON.stringify(store.snapshot())
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toContain('raw-secret')
    expect(serialized).not.toContain('raw-token')
  })

  it('does not dispatch a second lifecycle from response envelopes', () => {
    const store = makeExplorerStore({ instanceId: 'canonical', bounds })
    const sink = makeCaptureSink({ store, side: 'client', descriptorForTag })
    start({ sink })
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'serverToClient',
      phase: 'received',
      message: { _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: 'reply' } },
    })
    expect(store.snapshot().completed).toHaveLength(0)
    sink.onTerminal({ identity, at, outcome: 'success', durationSeconds: 0 }, [
      { channel: 'success', encoding: 'encoded', value: 'reply' },
    ])
    expect(store.snapshot().completed[0]?.state).toBe('succeeded')
    expect(
      store.snapshot().events.filter((event) => event._tag === 'TerminalObserved'),
    ).toHaveLength(1)
  })

  it('retains honest transport uncertainty and side-specific fault evidence', () => {
    const store = makeExplorerStore({ instanceId: 'fault', bounds })
    const sink = makeCaptureSink({ store, side: 'client', descriptorForTag })
    start({ sink })
    store.dispatch({
      _tag: 'RequestObserved',
      at,
      request: { ...identity, observerSide: 'server' },
      descriptorId: 'rpc:Echo',
      notification: false,
      observations: [],
    })
    store.dispatch({
      _tag: 'RequestObserved',
      at,
      request: { ...identity, requestId: { _tag: 'Number', value: 2 } },
      descriptorId: 'rpc:Echo',
      notification: false,
      observations: [],
    })
    sink.onTerminal({ identity, at, outcome: 'transportFailure', durationSeconds: 0 }, [])
    sink.onFault({ observerSide: 'client', connectionId: 'host-7', at, reason: 'capacity' })
    expect(store.snapshot().completed[0]?.state).toBe('uncertain')
    expect(store.snapshot().active.some((record) => record.key.observerSide === 'server')).toBe(
      true,
    )
    expect(store.snapshot().active.some((record) => record.key.requestId.value === 2)).toBe(true)
    expect(store.snapshot().completed[0]?.evidence).toEqual([
      { _tag: 'ConnectionFault', faultId: 'client:host-7:1', fault: 'capacity' },
    ])
    expect(store.snapshot().events.at(-1)).toMatchObject({
      _tag: 'ConnectionFault',
      fault: 'capacity',
      observerSide: 'client',
    })
  })

  it('never retains unmapped wire tags or omitted values in snapshot/watch', () => {
    const store = makeExplorerStore({ instanceId: 'unknown', bounds })
    const subscription = store.watch()
    const sink = makeCaptureSink({ store, side: 'client' })
    const unknownTag = 'x'.repeat(1024 * 1024)
    start({ sink, tag: unknownTag })
    expect(store.snapshot().active[0]?.descriptorId).toBe('unknown:unmapped')
    const serialized = JSON.stringify([store.snapshot(), subscription.drain()])
    subscription.close()
    expect(serialized).not.toContain(unknownTag)
    expect(serialized).not.toContain('raw-secret')
    expect(serialized).not.toContain('raw-token')
  })

  it('normalizes only retained stream elements and maps stream typed failures to streamError', () => {
    const store = makeExplorerStore({ instanceId: 'stream', bounds })
    let transformations = 0
    const sink = makeCaptureSink({
      store,
      side: 'client',
      streamValuesPerRecord: 3,
      descriptorForTag: () => ({
        descriptorId: 'rpc:Stream',
        successSchema: RpcSchema.Stream(Schema.Finite, Schema.String),
        policies: {
          streamElement: {
            _tag: 'redact',
            transform: () => {
              transformations += 1
              return '[stream]'
            },
          },
          streamError: { _tag: 'reveal' },
        },
      }),
    })
    start({ sink, tag: 'Stream' })
    const raw = Array.from({ length: 10_000 }, (_, value) => ({
      channel: 'streamElement' as const,
      encoding: 'decoded' as const,
      value,
    }))
    sink.onChunk({ identity, at, valueCount: 10_000 }, raw)
    sink.onChunk({ identity, at, valueCount: 10_000 }, raw)
    expect(transformations).toBe(3)
    expect(store.snapshot().active[0]).toMatchObject({
      chunkEnvelopes: 2,
      streamValues: 20_000,
      retainedStreamValues: 3,
    })
    sink.onTerminal({ identity, at, outcome: 'typedFailure', durationSeconds: 0 }, [
      { channel: 'typedFailure', encoding: 'decoded', value: 'stream-error' },
    ])
    expect(store.snapshot().events.at(-1)).toMatchObject({
      _tag: 'TerminalObserved',
      observations: [
        { channel: 'streamError', captured: { _tag: 'String', value: 'stream-error' } },
      ],
    })
  })

  it('bounds terminal capture without reclassifying canonical outcomes', () => {
    const store = makeExplorerStore({ instanceId: 'cause', bounds })
    let transformations = 0
    const sink = makeCaptureSink({
      store,
      side: 'client',
      normalizationBounds: { ...defaultNormalizationBounds, maxEntries: 4 },
      descriptorForTag: () => ({
        descriptorId: 'rpc:Cause',
        policies: {
          typedFailure: {
            _tag: 'redact',
            transform: () => {
              transformations += 1
              return '[failure]'
            },
          },
        },
      }),
    })
    start({ sink })
    sink.onTerminal({ identity, at, outcome: 'defect', durationSeconds: 0 }, [
      ...Array.from({ length: 10_000 }, (_, value) => ({
        channel: 'typedFailure' as const,
        encoding: 'decoded' as const,
        value,
      })),
      { channel: 'defect', encoding: 'decoded', value: 'last-defect' },
    ])
    expect(transformations).toBe(4)
    expect(store.snapshot().events.at(-1)).toMatchObject({
      _tag: 'TerminalObserved',
      outcome: 'defect',
      observations: [{}, {}, {}, {}],
    })
  })

  it('isolates normalization telemetry exceptions and emits only content-free measurements', () => {
    const store = makeExplorerStore({ instanceId: 'telemetry', bounds })
    const measurements: Array<{
      readonly channel: string
      readonly outcome: string
      readonly durationSeconds: number
    }> = []
    const sink = makeCaptureSink({
      store,
      side: 'client',
      descriptorForTag,
      onNormalization: (measurement) => {
        measurements.push(measurement)
        throw new Error('telemetry defect')
      },
    })
    start({ sink })
    expect(measurements).toHaveLength(1)
    expect(measurements[0]).toMatchObject({ channel: 'requestPayload', outcome: 'success' })
    expect(
      measurements.every(
        (value) => Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0,
      ),
    ).toBe(true)
    expect(JSON.stringify(measurements)).not.toContain('raw-secret')
  })

  it('preserves successful notification send state without generating a late terminal', () => {
    const store = makeExplorerStore({ instanceId: 'notification', bounds })
    const sink = makeCaptureSink({ store, side: 'client', descriptorForTag })
    const message: RpcMessage.RequestEncoded = { ...request, isNotification: true }
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'clientToServer',
      phase: 'sendAttempted',
      message,
    })
    sink.onRequest({ identity, at, tag: 'Echo', notification: true }, [
      { channel: 'payload', encoding: 'encoded', value: message.payload },
    ])
    sink.onMessage({
      clientId: 7,
      connectionId: 'host-7',
      at,
      direction: 'clientToServer',
      phase: 'sendFinished',
      message,
      succeeded: true,
    })
    sink.onTerminal({ identity, at, outcome: 'success', durationSeconds: 0 }, [])
    expect(store.snapshot().completed[0]?.state).toBe('notificationSent')
    expect(store.snapshot().events.map((event) => event._tag)).toEqual([
      'RequestObserved',
      'SendAttempted',
      'SendSucceeded',
    ])
  })

  it('joins delayed decoded requests to trace metadata by the full custom identity', () => {
    const store = makeExplorerStore({ instanceId: 'delayed', bounds })
    const sink = makeCaptureSink({ store, side: 'server', descriptorForTag })
    for (const connectionId of ['first', 'second']) {
      sink.onMessage({
        clientId: 7,
        connectionId,
        at,
        direction: 'clientToServer',
        phase: 'received',
        message: { ...request, traceId: `trace-${connectionId}` },
      })
    }
    for (const connectionId of ['second', 'first']) {
      sink.onRequest(
        {
          identity: { ...identity, observerSide: 'server', connectionId },
          at,
          tag: 'Echo',
          notification: false,
        },
        [{ channel: 'payload', encoding: 'decoded', value: 'decoded-secret' }],
      )
    }
    expect(
      store.snapshot().active.map((record) => [record.key.connectionId, record.trace?.traceId]),
    ).toEqual([
      ['first', 'trace-first'],
      ['second', 'trace-second'],
    ])
    expect(JSON.stringify(store.snapshot())).not.toContain('decoded-secret')
  })
})

describe('standalone observer and explorer capture composition', () => {
  it('preserves transport capabilities and encoded Schema.Redacted safety', async () => {
    const snapshot = await Effect.gen(function* () {
      const store = makeExplorerStore({ instanceId: 'encoded', bounds })
      const transport = makeClientProtocol()
      const payloadSchema = Schema.Struct({
        visible: Schema.String,
        nested: Schema.Struct({ credential: Schema.Redacted(Schema.String) }),
      })
      const observer = yield* makeProtocolObserver({
        side: 'client',
        capacity: 16,
        sinks: [
          {
            capture: true,
            sink: makeCaptureSink({
              store,
              side: 'client',
              descriptorForTag: () => ({
                descriptorId: 'rpc:CredentialRequest',
                payloadSchema,
                encodedDecoders: {
                  requestPayload: Schema.decodeUnknownOption(transport.codecFor(payloadSchema)),
                },
                policies: { requestPayload: { _tag: 'reveal' } },
              }),
            }),
          },
        ],
      })
      const decorated = decorateClientProtocol({ protocol: transport, observer })
      expect(decorated.supportsAck).toBe(transport.supportsAck)
      expect(decorated.supportsTransferables).toBe(transport.supportsTransferables)
      expect(decorated.codecFor).toBe(transport.codecFor)
      yield* decorated.send(7, {
        ...request,
        tag: 'CredentialRequest',
        payload: { visible: 'safe', nested: { credential: 'never-retain' } },
      })
      return store.snapshot()
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(JSON.stringify(snapshot)).not.toContain('never-retain')
    expect(snapshot.events[0]).toMatchObject({
      _tag: 'RequestObserved',
      observations: [
        {
          captured: {
            _tag: 'Object',
            value: { nested: { _tag: 'Object', value: { credential: { _tag: 'Redacted' } } } },
          },
        },
        {},
      ],
    })
  })

  it('retains sendFailed without changing the original error or creating a late terminal', async () => {
    const error = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({ message: 'failed', cause: 'transport-cause' }),
    })
    const result = await Effect.gen(function* () {
      const store = makeExplorerStore({ instanceId: 'failed-send', bounds })
      const observer = yield* makeProtocolObserver({
        side: 'client',
        capacity: 16,
        sinks: [
          { capture: true, sink: makeCaptureSink({ store, side: 'client', descriptorForTag }) },
        ],
      })
      const protocol = decorateClientProtocol({
        observer,
        protocol: makeClientProtocol({ send: () => Effect.fail(error) }),
      })
      const exit = yield* Effect.exit(protocol.send(7, request))
      return { exit, snapshot: store.snapshot() }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result.exit._tag).toBe('Failure')
    if (result.exit._tag === 'Failure') {
      expect(Option.getOrUndefined(Cause.findErrorOption(result.exit.cause))).toBe(error)
    }
    expect(result.snapshot.completed[0]?.state).toBe('sendFailed')
    expect(result.snapshot.events.filter((event) => event._tag === 'LateEvent')).toHaveLength(0)
    expect(
      result.snapshot.events.some(
        (event) => event._tag === 'ConnectionFault' && event.fault === 'sendFailure',
      ),
    ).toBe(true)
  })
})
