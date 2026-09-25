import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect } from 'effect'
import { formatSocketAddress } from 'effect/unstable/net/NetAddress'
import type { Socket as SocketType, SocketError } from 'effect/unstable/socket/Socket'
import { readerString } from 'effect/unstable/socket/Socket'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: WebSocket echo server.
 *
 * Demonstrates:
 * - `NodeSocketServer.layerWebSocket` for server setup
 * - pull-based text reads via `Socket.readerString`
 * - scoped writer lifecycle (`socket.writer`)
 */
/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Echo every incoming message with a prefix. */
const handleConnection = Effect.fn('ws-echo.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const writer = yield* socket.writer
      /** Acquiring the reader attaches to the accepted connection; each pull yields a batch of frames. */
      const pull = yield* readerString(socket)

      yield* Effect.log('client connected')

      while (true) {
        for (const text of yield* pull) {
          yield* Effect.log(`recv ${text}`)
          yield* writer.write(`echo:${text}`)
        }
      }
    }),
  ).pipe(
    Effect.catchIf(isCleanClose, () => Effect.void),
    Effect.withSpan('ws-echo.connection.scope'),
  )
})

/** Run the websocket server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatSocketAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(Effect.withSpan('ws-echo.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8787 })))

/**
 * Expected logs (example):
 * - listening on [::]:8787
 * - client connected
 * - recv hello
 * - recv from
 * - recv effect
 */
NodeRuntime.runMain(program)
