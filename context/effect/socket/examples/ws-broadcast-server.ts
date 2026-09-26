import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect, PubSub, Stream } from 'effect'
import { formatSocketAddress } from 'effect/unstable/net/NetAddress'
import type { Socket as SocketType, SocketError } from 'effect/unstable/socket/Socket'
import { readerString } from 'effect/unstable/socket/Socket'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: WebSocket broadcast server.
 *
 * Demonstrates:
 * - fan-out with `PubSub`
 * - per-connection subscriptions
 * - pull-based text reads via `Socket.readerString`
 * - tying forwarding to the connection lifetime with `Effect.raceFirst`
 */
/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Bridge each socket to the shared PubSub for broadcast. */
const handleConnection = (pubsub: PubSub.PubSub<string>) =>
  Effect.fn('ws-broadcast.connection')(function* (socket: SocketType) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        /** Writer is scoped to the connection lifecycle. */
        const writer = yield* socket.writer
        /** Acquiring the reader attaches to the accepted connection. */
        const pull = yield* readerString(socket)
        /** Each client gets its own subscription queue. */
        const subscription = yield* PubSub.subscribe(pubsub)

        yield* Effect.addFinalizer(() =>
          PubSub.publish(pubsub, `[system] ${id} left`).pipe(Effect.asVoid),
        )

        yield* PubSub.publish(pubsub, `[system] ${id} joined`).pipe(Effect.asVoid)

        /** Forward broadcast messages to the socket. */
        const forward = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((message) => writer.write(message)),
          Stream.runDrain,
        )

        /** Publish every incoming frame until the client disconnects. */
        const receive = Effect.gen(function* () {
          while (true) {
            for (const text of yield* pull) {
              yield* PubSub.publish(pubsub, `[${id}] ${text}`)
            }
          }
        }).pipe(Effect.catchIf(isCleanClose, () => Effect.void))

        yield* Effect.log(`client ${id} connected`)

        /** The connection ends when `receive` does; that interrupts forwarding. */
        return yield* Effect.raceFirst(receive, forward)
      }),
    ).pipe(Effect.withSpan('ws-broadcast.connection.scope'))
  })

/** Initialize PubSub and run the websocket broadcast server. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  const pubsub = yield* PubSub.unbounded<string>({ replay: 5 })

  yield* Effect.log(`listening on ${formatSocketAddress(socketServer.address)}`)

  return yield* socketServer.run(handleConnection(pubsub))
}).pipe(Effect.withSpan('ws-broadcast.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8789 })))

/**
 * Expected logs (example):
 * - listening on [::]:8789
 * - client <uuid> connected
 */
NodeRuntime.runMain(program)
