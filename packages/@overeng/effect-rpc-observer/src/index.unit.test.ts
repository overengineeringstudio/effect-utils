import { describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Queue, Schema, Scope } from 'effect'
import { Headers } from 'effect/http'
import { Rpc, RpcMessage, RpcSerialization } from 'effect/rpc'
import type { RpcClient, RpcMiddleware, RpcServer } from 'effect/rpc'
import { expect } from 'vitest'

import {
  decorateClientProtocol,
  decorateServerProtocol,
  makeProtocolObserver,
  makeServerObserverMiddleware,
} from './index.ts'
import type {
  CaptureSink,
  ChunkEvent,
  FaultEvent,
  ProtocolSink,
  RawMessage,
  RawValue,
  RequestEvent,
  TerminalEvent,
} from './index.ts'

const request: RpcMessage.RequestEncoded = {
  _tag: 'Request',
  id: 1,
  tag: 'Echo',
  payload: { secret: 'payload' },
  headers: [['authorization', 'secret']],
}
const success: RpcMessage.ResponseExitEncoded = {
  _tag: 'Exit',
  requestId: 1,
  exit: { _tag: 'Success', value: 'reply' },
}
const recorder = () => {
  const requests: RequestEvent[] = []
  const chunks: ChunkEvent[] = []
  const terminals: TerminalEvent[] = []
  const faults: FaultEvent[] = []
  const sink: ProtocolSink = {
    onRequest: (event) => requests.push(event),
    onChunk: (event) => chunks.push(event),
    onTerminal: (event) => terminals.push(event),
    onFault: (event) => faults.push(event),
  }
  return { sink, requests, chunks, terminals, faults }
}
const clientFixture = () => {
  let callback: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void> = () => Effect.void
  let sends = 0
  const protocol: RpcClient.Protocol['Service'] = {
    // oxlint-disable-next-line overeng/named-args -- Protocol callback shape belongs to Effect.
    run: (_clientId, next) =>
      Effect.sync(() => {
        callback = next
      }).pipe(Effect.andThen(Effect.never)),
    send: () =>
      Effect.sync(() => {
        sends += 1
      }),
    supportsAck: true,
    supportsTransferables: true,
    codecFor: RpcSerialization.json.codecFor,
  }
  return {
    protocol,
    receive: (message: RpcMessage.FromServerEncoded) => callback(message),
    sends: () => sends,
  }
}
const serverFixture = (disconnects: Queue.Dequeue<number>) => {
  let callback: RpcServer.Protocol['Service']['run'] extends (callback: infer T) => unknown
    ? T
    : never = () => Effect.void
  const protocol: RpcServer.Protocol['Service'] = {
    run: (next) =>
      Effect.sync(() => {
        callback = next
      }).pipe(Effect.andThen(Effect.never)),
    disconnects,
    send: () => Effect.void,
    end: () => Effect.void,
    clientIds: Effect.succeed(new Set([4])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsNotifications: true,
    supportsTransferables: true,
    supportsSpanPropagation: true,
    codecFor: RpcSerialization.json.codecFor,
  }
  return {
    protocol,
    receive: ({
      clientId,
      message,
    }: {
      readonly clientId: number
      readonly message: RpcMessage.FromClientEncoded
    }) => callback(clientId, message),
  }
}

const clock = () => {
  let nanos = 0n
  return {
    now: () => {
      nanos += 1_000_000_000n
      return { monotonicNanos: String(nanos), wallClockMillis: 123 }
    },
  }
}

describe('shared RPC observation', () => {
  it.effect(
    'fans out one interception in registration order without raw access for metadata sinks',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const order: string[] = []
          const meta = recorder()
          const captured: RawValue[][] = []
          const messages: RawMessage[] = []
          const capture: CaptureSink = {
            // oxlint-disable-next-line overeng/named-args -- Capture callbacks use the public borrowed-attachment signature.
            onRequest: (_event, raw) => {
              order.push('capture:request')
              captured.push([...raw])
            },
            // oxlint-disable-next-line overeng/named-args -- Capture callbacks use the public borrowed-attachment signature.
            onChunk: (_event, raw) => captured.push([...raw]),
            // oxlint-disable-next-line overeng/named-args -- Capture callbacks use the public borrowed-attachment signature.
            onTerminal: (_event, raw) => {
              order.push('capture:terminal')
              captured.push([...raw])
            },
            onFault: () => {},
            onMessage: (message) => messages.push(message),
          }
          const metadata: ProtocolSink = {
            ...meta.sink,
            onRequest: (...args) => {
              expect(args).toHaveLength(1)
              order.push('meta:request')
              meta.sink.onRequest(args[0])
            },
            onTerminal: (...args) => {
              expect(args).toHaveLength(1)
              order.push('meta:terminal')
              meta.sink.onTerminal(args[0])
            },
          }
          const observer = yield* makeProtocolObserver({
            side: 'client',
            capacity: 8,
            clock: clock(),
            sinks: [
              { capture: false, sink: metadata },
              { capture: true, sink: capture },
            ],
          })
          const fixture = clientFixture()
          const protocol = decorateClientProtocol({ protocol: fixture.protocol, observer })
          const fiber = yield* Effect.forkChild(protocol.run(2, () => Effect.void))
          yield* Effect.yieldNow
          yield* protocol.send(2, request)
          yield* fixture.receive({ _tag: 'Chunk', requestId: 1, values: ['a', 'b'] })
          yield* fixture.receive(success)
          yield* fixture.receive(success)
          expect(fixture.sends()).toBe(1)
          expect(order).toEqual([
            'meta:request',
            'capture:request',
            'meta:terminal',
            'capture:terminal',
          ])
          expect(meta.requests).toHaveLength(1)
          expect(meta.chunks[0]?.valueCount).toBe(2)
          expect(meta.terminals).toHaveLength(1)
          expect(meta.terminals[0]?.durationSeconds).toBeGreaterThan(0)
          expect(captured[0]?.[0]?.value).toBe(request.payload)
          expect(messages.map((message) => message.phase)).toEqual([
            'sendAttempted',
            'sendFinished',
            'received',
            'received',
            'received',
          ])
          yield* Fiber.interrupt(fiber)
        }),
      ),
  )

  it.effect(
    'isolates every throwing sink and never traverses payload for metadata-only observation',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const good = recorder()
          const broken: ProtocolSink = {
            onRequest: () => {
              throw new Error('sink')
            },
            onChunk: () => {
              throw new Error('sink')
            },
            onTerminal: () => {
              throw new Error('sink')
            },
            onFault: () => {
              throw new Error('sink')
            },
          }
          const observer = yield* makeProtocolObserver({
            side: 'client',
            capacity: 8,
            sinks: [
              { capture: false, sink: broken },
              { capture: false, sink: good.sink },
            ],
          })
          const fixture = clientFixture()
          const protocol = decorateClientProtocol({ protocol: fixture.protocol, observer })
          const secretRequest: RpcMessage.RequestEncoded = {
            ...request,
            get payload(): unknown {
              throw new Error('payload accessed')
            },
            get headers(): RpcMessage.RequestEncoded['headers'] {
              throw new Error('headers accessed')
            },
          }
          const fiber = yield* Effect.forkChild(protocol.run(0, () => Effect.void))
          yield* Effect.yieldNow
          yield* protocol.send(0, secretRequest)
          yield* fixture.receive({ _tag: 'Chunk', requestId: 1, values: ['a'] })
          yield* fixture.receive(success)
          yield* fixture.receive({ _tag: 'Defect', defect: 'private fault' })
          expect(good.requests).toHaveLength(1)
          expect(good.chunks).toHaveLength(1)
          expect(good.terminals[0]?.outcome).toBe('success')
          expect(good.faults[0]?.reason).toBe('defect')
          yield* Fiber.interrupt(fiber)
        }),
      ),
  )

  it.effect('admits before synchronous loopback and preserves transferables and failed exits', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = recorder()
        const observer = yield* makeProtocolObserver({
          side: 'client',
          capacity: 8,
          sinks: [{ capture: false, sink: events.sink }],
        })
        const fixture = clientFixture()
        const transferables = [new ArrayBuffer(4)]
        const protocol = decorateClientProtocol({
          protocol: {
            ...fixture.protocol,
            // oxlint-disable-next-line overeng/named-args -- Protocol callback shape belongs to Effect.
            send: (_clientId, message, passed) => {
              expect(message).toBe(request)
              expect(passed).toBe(transferables)
              return fixture.receive(success).pipe(Effect.andThen(Effect.die('send defect')))
            },
          },
          observer,
        })
        const fiber = yield* Effect.forkChild(protocol.run(0, () => Effect.void))
        yield* Effect.yieldNow
        const exit = yield* Effect.exit(protocol.send(0, request, transferables))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(events.terminals.map((event) => event.outcome)).toEqual(['success'])
        expect(events.faults.map((event) => event.reason)).toEqual(['sendFailure'])
        expect(protocol.codecFor).toBe(fixture.protocol.codecFor)
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )

  it.effect(
    'bounds state explicitly and distinguishes IDs and connections without phantom responses',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = recorder()
          const observer = yield* makeProtocolObserver({
            side: 'client',
            capacity: 2,
            connectionId: (id) => `connection-${id}`,
            sinks: [{ capture: false, sink: events.sink }],
          })
          const fixture = clientFixture()
          const protocol = decorateClientProtocol({ protocol: fixture.protocol, observer })
          const fiber = yield* Effect.forkChild(protocol.run(1, () => Effect.void))
          yield* Effect.yieldNow
          yield* protocol.send(1, request)
          yield* protocol.send(1, { ...request, id: '1' })
          yield* protocol.send(2, request)
          expect(events.terminals.map((event) => event.outcome)).toEqual(['transportFailure'])
          expect(events.faults[0]?.reason).toBe('capacity')
          yield* fixture.receive(success)
          yield* fixture.receive({ ...success, requestId: '1' })
          expect(events.terminals).toHaveLength(2)
          expect(events.terminals[1]?.identity.requestId._tag).toBe('String')
          expect(events.requests[2]?.identity.connectionId).toBe('connection-2')
          yield* protocol.send(1, { ...request, id: '1' })
          expect(events.requests).toHaveLength(4)
          yield* Fiber.interrupt(fiber)
        }),
      ),
  )

  it.effect('keeps Interrupt nonterminal and completes notifications only on accepted sends', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = recorder()
        const observer = yield* makeProtocolObserver({
          side: 'client',
          capacity: 8,
          sinks: [{ capture: false, sink: events.sink }],
        })
        const fixture = clientFixture()
        const protocol = decorateClientProtocol({ protocol: fixture.protocol, observer })
        const fiber = yield* Effect.forkChild(protocol.run(1, () => Effect.void))
        yield* Effect.yieldNow
        yield* protocol.send(1, request)
        yield* protocol.send(1, { _tag: 'Interrupt', requestId: 1 })
        expect(events.terminals).toHaveLength(0)
        yield* fixture.receive({
          _tag: 'Exit',
          requestId: 1,
          exit: {
            _tag: 'Failure',
            cause: [
              { _tag: 'Fail', error: 'failure' },
              { _tag: 'Interrupt', fiberId: 1 },
              { _tag: 'Die', defect: 'defect' },
            ],
          },
        })
        expect(events.terminals[0]?.outcome).toBe('defect')
        yield* protocol.send(1, { ...request, id: 2, isNotification: true })
        expect(events.terminals[1]?.outcome).toBe('success')
        const failed = decorateClientProtocol({
          protocol: { ...fixture.protocol, send: () => Effect.die('failed') },
          observer,
        })
        yield* Effect.exit(failed.send(1, { ...request, id: 3, isNotification: true }))
        expect(events.terminals[2]?.outcome).toBe('transportFailure')
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )

  it.effect(
    'commits server terminal only after delivery and does not treat inbound batch EOF as disconnect',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = recorder()
          const observer = yield* makeProtocolObserver({
            side: 'server',
            capacity: 8,
            sinks: [{ capture: false, sink: events.sink }],
          })
          const disconnects = yield* Queue.make<number>()
          const fixture = serverFixture(disconnects)
          const protocol = decorateServerProtocol({ protocol: fixture.protocol, observer })
          const fiber = yield* Effect.forkChild(protocol.run(() => Effect.void))
          yield* Effect.yieldNow
          yield* fixture.receive({ clientId: 4, message: request })
          yield* fixture.receive({ clientId: 4, message: { _tag: 'Eof' } })
          expect(events.terminals).toHaveLength(0)
          yield* protocol.send(4, success)
          expect(events.terminals[0]?.outcome).toBe('success')
          yield* fixture.receive({ clientId: 4, message: { ...request, id: 2 } })
          yield* Queue.offer(disconnects, 4)
          expect(yield* Queue.take(protocol.disconnects)).toBe(4)
          expect(events.terminals[1]?.outcome).toBe('transportFailure')
          expect(events.faults[0]?.reason).toBe('disconnect')
          expect(protocol.supportsNotifications).toBe(fixture.protocol.supportsNotifications)
          yield* Fiber.interrupt(fiber)
        }),
      ),
  )

  it.effect(
    'shares protocol and decoded middleware coordination with first terminal evidence winning',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = recorder()
          const values: RawValue[] = []
          const capture: CaptureSink = {
            ...events.sink,
            // oxlint-disable-next-line overeng/named-args -- Capture callbacks use the public borrowed-attachment signature.
            onRequest: (event, raw) => {
              events.sink.onRequest(event)
              values.push(...raw)
            },
            // oxlint-disable-next-line overeng/named-args -- Capture callbacks use the public borrowed-attachment signature.
            onTerminal: (event, raw) => {
              events.sink.onTerminal(event)
              values.push(...raw)
            },
            onMessage: () => {},
          }
          const observer = yield* makeProtocolObserver({
            side: 'server',
            capacity: 8,
            sinks: [{ capture: true, sink: capture }],
          })
          const fixture = serverFixture(yield* Queue.make<number>())
          const protocol = decorateServerProtocol({
            protocol: fixture.protocol,
            observer,
            requestObservation: 'middleware',
          })
          const middleware = makeServerObserverMiddleware({ observer })
          const fiber = yield* Effect.forkChild(protocol.run(() => Effect.void))
          yield* Effect.yieldNow
          yield* fixture.receive({ clientId: 4, message: request })
          expect(events.requests).toHaveLength(0)
          // SuccessValue is opaque in Effect; handlers produce it from the decoded reply at runtime.
          const decodedReply = 'decoded reply' as unknown as RpcMiddleware.SuccessValue
          yield* middleware(Effect.succeed(decodedReply), {
            client: new Rpc.ServerClient(4),
            requestId: RpcMessage.RequestId(1),
            rpc: Rpc.make('Echo', { success: Schema.String }),
            payload: 'decoded payload',
            headers: Headers.empty,
          }).pipe(Effect.scoped)
          yield* protocol.send(4, success)
          expect(events.requests).toHaveLength(1)
          expect(events.terminals).toHaveLength(1)
          expect(values.map((value) => value.encoding)).toEqual(['decoded', 'decoded', 'decoded'])
          yield* Fiber.interrupt(fiber)
        }),
      ),
  )

  it.effect('does not claim server chunks or terminal delivery when response sends fail', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = recorder()
        const phases: string[] = []
        const capture: CaptureSink = {
          ...events.sink,
          onMessage: (message) => phases.push(`${message.phase}:${String(message.succeeded)}`),
        }
        const observer = yield* makeProtocolObserver({
          side: 'server',
          capacity: 8,
          sinks: [{ capture: true, sink: capture }],
        })
        const fixture = serverFixture(yield* Queue.make<number>())
        const protocol = decorateServerProtocol({
          protocol: { ...fixture.protocol, send: () => Effect.die('response transport failure') },
          observer,
        })
        const fiber = yield* Effect.forkChild(protocol.run(() => Effect.void))
        yield* Effect.yieldNow
        yield* fixture.receive({ clientId: 4, message: request })
        const exit = yield* Effect.exit(
          protocol.send(4, { _tag: 'Chunk', requestId: 1, values: ['not delivered'] }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(events.chunks).toHaveLength(0)
        expect(events.terminals.map((event) => event.outcome)).toEqual(['transportFailure'])
        expect(events.faults[0]?.reason).toBe('sendFailure')
        expect(phases).toEqual([
          'received:undefined',
          'sendAttempted:undefined',
          'sendFinished:false',
        ])
        yield* Effect.exit(protocol.send(4, success))
        expect(events.terminals).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )

  it.effect('stops callbacks after scope release', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const events = recorder()
      const observer = yield* makeProtocolObserver({
        side: 'client',
        capacity: 2,
        sinks: [{ capture: false, sink: events.sink }],
      }).pipe(Scope.provide(scope))
      const protocol = decorateClientProtocol({ protocol: clientFixture().protocol, observer })
      yield* Scope.close(scope, Exit.void)
      yield* protocol.send(1, request)
      expect(events.requests).toHaveLength(0)
      expect(events.terminals).toHaveLength(0)
    }),
  )
})
