import { NodeRuntime } from '@effect/platform-node'
import { layer } from '@effect/platform-node/NodeSocketServer'
import { Effect } from 'effect'
import { formatSocketAddress } from 'effect/unstable/net/NetAddress'
import type { Socket as SocketType, SocketError } from 'effect/unstable/socket/Socket'
import { readerBytes } from 'effect/unstable/socket/Socket'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: TCP echo server.
 *
 * Demonstrates:
 * - raw TCP sockets via `NodeSocketServer.layer`
 * - pull-based binary reads via `Socket.readerBytes`
 * - echoing each pulled batch with `Writer.writeAll`
 */
/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Echo raw TCP bytes back to the client. */
const handleConnection = Effect.fn('tcp-echo.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const writer = yield* socket.writer
      /** Acquiring the reader attaches to the accepted connection. */
      const pull = yield* readerBytes(socket)

      yield* Effect.log('client connected')

      while (true) {
        const batch = yield* pull
        for (const data of batch) {
          yield* Effect.log(`recv bytes=${data.length}`)
        }
        yield* writer.writeAll(batch)
      }
    }),
  ).pipe(
    Effect.catchIf(isCleanClose, () => Effect.void),
    Effect.withSpan('tcp-echo.connection.scope'),
  )
})

/** Run the TCP echo server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatSocketAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(Effect.withSpan('tcp-echo.server'))

const program = runServer.pipe(Effect.provide(layer({ port: 8793, host: '127.0.0.1' })))

/**
 * Expected logs (example):
 * - listening on 127.0.0.1:8793
 * - client connected
 * - recv bytes=9
 * - recv bytes=12
 * - recv bytes=3
 */
NodeRuntime.runMain(program)
