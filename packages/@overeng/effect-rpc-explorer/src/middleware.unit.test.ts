import { Duration, Effect, Queue, Schema } from 'effect'
import { Headers } from 'effect/http'
import { Rpc, RpcMessage, RpcSerialization } from 'effect/rpc'
import { describe, expect, it } from 'vitest'

import {
  decorateServerProtocol,
  makeProtocolObserver,
  makeServerObserverMiddleware,
} from '@overeng/effect-rpc-observer'

import type { ExplorerBounds } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import { makeCaptureSink } from './protocol.ts'
import { makeExplorerStore } from './store.ts'

const bounds: ExplorerBounds = {
  active: { maxCount: 16, maxAge: Duration.seconds(10) },
  completed: { maxCount: 16, maxAge: Duration.seconds(10) },
  streamValuesPerRecord: 16,
  normalized: defaultNormalizationBounds,
  deltas: { maxCount: 32, maxAge: Duration.seconds(10) },
  subscriberQueue: 16,
}
const Echo = Rpc.make('Echo', {
  payload: Schema.String,
  success: Schema.String,
  error: Schema.String,
})
const request: RpcMessage.RequestEncoded = {
  _tag: 'Request',
  id: 1,
  tag: 'Echo',
  payload: 'encoded-secret',
  headers: [['authorization', 'header-secret']],
  traceId: 'handler-trace',
  spanId: 'handler-span',
}

describe('shared server middleware with explorer capture', () => {
  it('uses decoded request and terminal evidence exactly once on the protocol coordinator', async () => {
    const snapshot = await Effect.gen(function* () {
      const store = makeExplorerStore({ instanceId: 'server', bounds })
      const observer = yield* makeProtocolObserver({
        side: 'server',
        capacity: 16,
        connectionId: (clientId) => `transport-${clientId}`,
        sinks: [
          {
            capture: true,
            sink: makeCaptureSink({
              store,
              side: 'server',
              descriptorForTag: () => ({
                descriptorId: 'rpc:Echo',
                payloadSchema: Echo.payloadSchema,
                successSchema: Echo.successSchema,
                defectSchema: Echo.defectSchema,
                policies: {
                  requestPayload: { _tag: 'redact', transform: () => '[payload-redacted]' },
                  defect: { _tag: 'redact', transform: () => '[defect-redacted]' },
                },
              }),
            }),
          },
        ],
      })
      const middleware = makeServerObserverMiddleware({ observer })
      const protocol = decorateServerProtocol({
        observer,
        requestObservation: 'middleware',
        protocol: {
          run: (callback) =>
            callback(4, request).pipe(Effect.andThen(Effect.die('transport finished'))),
          disconnects: yield* Queue.make<number>(),
          send: () => Effect.void,
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([4])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: RpcSerialization.json.codecFor,
        },
      })
      yield* protocol
        .run((clientId, message) => {
          if (message._tag !== 'Request') return Effect.void
          return middleware(Effect.die('fatal-secret'), {
            client: new Rpc.ServerClient(clientId),
            requestId: RpcMessage.RequestId(message.id),
            rpc: Echo,
            payload: 'decoded-secret',
            headers: Headers.fromInput({ authorization: 'decoded-header-secret' }),
          }).pipe(Effect.scoped, Effect.exit, Effect.asVoid)
        })
        .pipe(Effect.exit)
      yield* protocol.send(4, {
        _tag: 'Exit',
        requestId: 1,
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Die', defect: 'encoded-fatal-secret' }],
        },
      })
      return store.snapshot()
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(snapshot.events.filter((event) => event._tag === 'RequestObserved')).toHaveLength(1)
    expect(snapshot.events.filter((event) => event._tag === 'TerminalObserved')).toHaveLength(1)
    expect(snapshot.events.filter((event) => event._tag === 'LateEvent')).toHaveLength(0)
    expect(snapshot.completed[0]).toMatchObject({
      state: 'defect',
      trace: { traceId: 'handler-trace', spanId: 'handler-span' },
      key: { connectionId: 'transport-4' },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('[payload-redacted]')
    expect(serialized).toContain('[defect-redacted]')
    expect(serialized).not.toContain('decoded-secret')
    expect(serialized).not.toContain('fatal-secret')
    expect(serialized).not.toContain('header-secret')
  })

  it('suppresses excluded inspector protocol, middleware, control and fault events', async () => {
    const snapshot = await Effect.gen(function* () {
      const store = makeExplorerStore({ instanceId: 'excluded', bounds })
      const observer = yield* makeProtocolObserver({
        side: 'server',
        capacity: 16,
        sinks: [
          {
            capture: true,
            sink: makeCaptureSink({
              store,
              side: 'server',
              descriptorForTag: () => ({ descriptorId: 'rpc:Echo', observe: 'exclude' }),
            }),
          },
        ],
      })
      const middleware = makeServerObserverMiddleware({ observer })
      const protocol = decorateServerProtocol({
        observer,
        requestObservation: 'middleware',
        protocol: {
          run: (callback) =>
            callback(9, request).pipe(
              Effect.andThen(callback(9, { _tag: 'Ack', requestId: 1 })),
              Effect.andThen(Effect.die('finished')),
            ),
          disconnects: yield* Queue.make<number>(),
          send: () => Effect.void,
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([9])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: RpcSerialization.json.codecFor,
        },
      })
      yield* protocol
        .run((clientId, message) =>
          message._tag === 'Request'
            ? middleware(Effect.die('private'), {
                client: new Rpc.ServerClient(clientId),
                requestId: RpcMessage.RequestId(message.id),
                rpc: Echo,
                payload: 'private',
                headers: Headers.empty,
              }).pipe(Effect.scoped, Effect.exit, Effect.asVoid)
            : Effect.void,
        )
        .pipe(Effect.exit)
      yield* protocol.send(9, {
        _tag: 'Exit',
        requestId: 1,
        exit: { _tag: 'Success', value: 'private' },
      })
      yield* protocol.end(9)
      return store.snapshot()
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.events).toHaveLength(0)
  })
})
