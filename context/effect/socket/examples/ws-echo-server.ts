import type { CloseEvent, Socket as SocketType } from '@effect/platform/Socket'
import { toChannelString } from '@effect/platform/Socket'
import type { Address } from '@effect/platform/SocketServer'
import { SocketServer } from '@effect/platform/SocketServer'
import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect, Stream } from 'effect'

/**
 * Example: WebSocket echo server.
 *
 * Demonstrates:
 * - `NodeSocketServer.layerWebSocket` for server setup
 * - `Socket.toChannelString` for text frames
 * - scoped writer lifecycle
 */
/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Echo every incoming message with a prefix. */
const handleConnection = Effect.fn('ws-echo.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
        Stream.pipeThroughChannel(toChannelString(socket)),
        Stream.mapEffect((text) =>
          Effect.gen(function* () {
            yield* Effect.log(`recv ${text}`)
            yield* write(`echo:${text}`)
          }),
        ),
        Stream.runDrain,
      )

      yield* Effect.log('client connected')
      return yield* receive
    }),
  ).pipe(Effect.withSpan('ws-echo.connection.scope'))
})

/** Run the websocket server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(Effect.withSpan('ws-echo.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8787 })))

/**
 * Expected logs (example):
 * - listening on :::8787
 * - client connected
 * - recv hello
 * - recv from
 * - recv effect
 */
NodeRuntime.runMain(program)
