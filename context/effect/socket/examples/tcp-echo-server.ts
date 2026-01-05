import type { Socket as SocketType } from '@effect/platform/Socket'
import type { Address } from '@effect/platform/SocketServer'
import { SocketServer } from '@effect/platform/SocketServer'
import { NodeRuntime } from '@effect/platform-node'
import { layer } from '@effect/platform-node/NodeSocketServer'
import { Effect } from 'effect'

/**
 * Example: TCP echo server.
 *
 * Demonstrates:
 * - raw TCP sockets via `NodeSocketServer.layer`
 * - `Socket.run` for binary reads (echo bytes)
 */
/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Echo raw TCP bytes back to the client. */
const handleConnection = Effect.fn('tcp-echo.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      const receive = socket.run((data) =>
        Effect.gen(function* () {
          yield* Effect.log(`recv bytes=${data.length}`)
          yield* write(data)
        }),
      )

      yield* Effect.log('client connected')
      return yield* receive
    }),
  ).pipe(Effect.withSpan('tcp-echo.connection.scope'))
})

/** Run the TCP echo server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatAddress(socketServer.address)}`)
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
