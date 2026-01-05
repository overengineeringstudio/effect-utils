import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import type { CloseEvent, Socket as SocketType } from '@effect/platform/Socket'
import { toChannelString } from '@effect/platform/Socket'
import type { Address } from '@effect/platform/SocketServer'
import { SocketServer } from '@effect/platform/SocketServer'
import { Effect, Fiber, PubSub, Stream } from 'effect'

/**
 * Example: WebSocket broadcast server.
 *
 * Demonstrates:
 * - fan-out with `PubSub`
 * - per-connection subscriptions
 * - text handling via `Socket.toChannelString`
 */
/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Bridge each socket to the shared PubSub for broadcast. */
const handleConnection = (pubsub: PubSub.PubSub<string>) =>
  Effect.fn('ws-broadcast.connection')(function* (socket: SocketType) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        /** Writer is scoped to the connection lifecycle. */
        const write = yield* socket.writer
        /** Each client gets its own subscription queue. */
        const subscription = yield* pubsub.subscribe

        yield* Effect.addFinalizer(() => pubsub.publish(`[system] ${id} left`).pipe(Effect.asVoid))

        yield* pubsub.publish(`[system] ${id} joined`).pipe(Effect.asVoid)

        /** Forward broadcast messages to the socket. */
        const forward = Stream.fromQueue(subscription).pipe(
          Stream.mapEffect((message) => write(message)),
          Stream.runDrain,
        )

        const forwardFiber = yield* Effect.forkScoped(forward)

        const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
          Stream.pipeThroughChannel(toChannelString(socket)),
          Stream.mapEffect((text) => pubsub.publish(`[${id}] ${text}`).pipe(Effect.asVoid)),
          Stream.runDrain,
        )

        yield* Effect.log(`client ${id} connected`)

        const result = yield* receive
        yield* Fiber.join(forwardFiber)
        return result
      }),
    ).pipe(Effect.withSpan('ws-broadcast.connection.scope'))
  })

/** Initialize PubSub and run the websocket broadcast server. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  const pubsub = yield* PubSub.unbounded<string>({ replay: 5 })

  yield* Effect.log(`listening on ${formatAddress(socketServer.address)}`)

  return yield* socketServer.run(handleConnection(pubsub))
}).pipe(Effect.withSpan('ws-broadcast.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8789 })))

/**
 * Expected logs (example):
 * - listening on :::8789
 * - client <uuid> connected
 */
NodeRuntime.runMain(program)
