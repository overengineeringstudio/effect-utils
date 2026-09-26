import { Duration, Effect, Queue, Schema } from 'effect'
import { Headers } from 'effect/unstable/http'
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, type RpcServer } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { makeServerExplorerMiddleware } from './middleware.ts'
import type { ExplorerBounds, Timestamp } from './model.ts'
import { defaultNormalizationBounds } from './policy.ts'
import { decorateServerProtocol } from './protocol.ts'
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
}

describe('server explorer middleware', () => {
  it('uses decoded handler evidence once when middleware and protocol observation are both active', async () => {
    const store = makeExplorerStore({ instanceId: 'server', bounds })
    const timestamp = makeClock()
    const options = {
      store,
      timestamp,
      descriptorForTag: (tag: string) =>
        tag === 'Echo'
          ? {
              descriptorId: 'rpc:Echo',
              payloadSchema: Echo.payloadSchema,
              successSchema: Echo.successSchema,
              errorSchema: Echo.errorSchema,
              defectSchema: Echo.defectSchema,
              policies: {
                requestPayload: {
                  _tag: 'redact' as const,
                  transform: () => '[payload-redacted]',
                },
                defect: { _tag: 'redact' as const, transform: () => '[defect-redacted]' },
              },
            }
          : undefined,
    }
    const middleware = makeServerExplorerMiddleware(options)
    const original: RpcServer.Protocol['Service'] = {
      run: (callback) => callback(4, request).pipe(Effect.andThen(Effect.never)),
      disconnects: Effect.runSync(Queue.make<number>()),
      send: () => Effect.void,
      end: () => Effect.void,
      clientIds: Effect.succeed(new Set([4])),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: RpcSerialization.json.codecFor,
    }
    const decorated = decorateServerProtocol(original, {
      ...options,
      requestObservation: 'middleware',
    })

    await Effect.runPromiseExit(
      decorated.run((clientId, message) => {
        if (message._tag !== 'Request') return Effect.void
        return middleware(Effect.die('fatal-secret'), {
          client: new Rpc.ServerClient(clientId),
          requestId: RpcMessage.RequestId(message.id),
          rpc: Echo,
          payload: 'decoded-secret',
          headers: Headers.fromInput({ authorization: 'decoded-header-secret' }),
        }).pipe(Effect.asVoid, Effect.orDie, Effect.scoped)
      }),
    )
    await Effect.runPromise(
      decorated.send(4, {
        _tag: 'Exit',
        requestId: 1,
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Die', defect: 'encoded-fatal-secret' }],
        },
      }),
    )

    const snapshot = store.snapshot()
    expect(snapshot.events.filter((event) => event._tag === 'RequestObserved')).toHaveLength(1)
    expect(snapshot.events.filter((event) => event._tag === 'TerminalObserved')).toHaveLength(1)
    expect(snapshot.events.filter((event) => event._tag === 'LateEvent')).toHaveLength(0)
    expect(snapshot.completed[0]?.state).toBe('defect')
    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('[payload-redacted]')
    expect(serialized).toContain('[defect-redacted]')
    expect(serialized).not.toContain('decoded-secret')
    expect(serialized).not.toContain('fatal-secret')
    expect(serialized).not.toContain('header-secret')
  })
})

describe('inspector RPC exclusion', () => {
  it('suppresses every protocol and middleware event for an excluded inspector group', async () => {
    const InspectorRpc = Rpc.make('InspectorWatch', {
      payload: Schema.String,
      success: Schema.String,
    })
    const InspectorGroup = RpcGroup.make(InspectorRpc)
    const store = makeExplorerStore({ instanceId: 'inspector-exclusion', bounds })
    const timestamp = makeClock()
    const options = {
      store,
      timestamp,
      descriptorForTag: (tag: string) => {
        const rpc = InspectorGroup.requests.get(tag)
        return rpc === undefined
          ? undefined
          : {
              descriptorId: `rpc:${rpc._tag}`,
              observe: 'exclude' as const,
              payloadSchema: rpc.payloadSchema,
              successSchema: rpc.successSchema,
              errorSchema: rpc.errorSchema,
              defectSchema: rpc.defectSchema,
            }
      },
    }
    const middleware = makeServerExplorerMiddleware(options)
    const inspectorRequest: RpcMessage.RequestEncoded = {
      _tag: 'Request',
      id: 'watch-1',
      tag: 'InspectorWatch',
      payload: 'private-inspector-state',
      headers: [],
    }
    const original: RpcServer.Protocol['Service'] = {
      run: (callback) =>
        callback(9, inspectorRequest).pipe(
          Effect.andThen(callback(9, { _tag: 'Ack', requestId: 'watch-1' })),
          Effect.andThen(Effect.die('stop')),
        ),
      disconnects: Effect.runSync(Queue.make<number>()),
      send: () => Effect.void,
      end: () => Effect.void,
      clientIds: Effect.succeed(new Set([9])),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: RpcSerialization.json.codecFor,
    }
    const decorated = decorateServerProtocol(original, {
      ...options,
      requestObservation: 'middleware',
    })

    await Effect.runPromiseExit(
      decorated.run((clientId, message) => {
        if (message._tag !== 'Request') return Effect.void
        return middleware(Effect.die('excluded-handler-defect'), {
          client: new Rpc.ServerClient(clientId),
          requestId: RpcMessage.RequestId(message.id),
          rpc: InspectorRpc,
          payload: 'decoded-private-inspector-state',
          headers: Headers.empty,
        }).pipe(Effect.scoped, Effect.exit, Effect.asVoid)
      }),
    )
    await Effect.runPromise(
      decorated.send(9, {
        _tag: 'Exit',
        requestId: 'watch-1',
        exit: { _tag: 'Success', value: 'private-inspector-result' },
      }),
    )

    expect(store.snapshot().revision).toBe(0)
    expect(store.snapshot().events).toHaveLength(0)
  })
})
