import { createServer } from 'node:http'

import { NodeRuntime } from '@effect/platform-node'
import { layer as nodeHttpLayer } from '@effect/platform-node/NodeHttpServer'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { text } from 'effect/unstable/http/HttpServerResponse'
import type { CloseEvent, Socket as SocketType } from 'effect/unstable/socket/Socket'
import { toChannelString } from 'effect/unstable/socket/Socket'
import type { Address } from 'effect/unstable/socket/SocketServer'
import { SocketServer } from 'effect/unstable/socket/SocketServer'
import { Effect, Layer, Stream } from 'effect'

/**
 * Example: HTTP + WebSocket in one Effect runtime.
 *
 * Demonstrates:
 * - `HttpRouter` HTTP routes
 * - `Socket.toChannelString` for WS echo
 * - shared runtime via layer composition
 */
const httpPort = 8788
const wsPort = 8790

/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Simple HTTP app with a couple of routes, served on the Node HTTP server. */
const routes = [
  HttpRouter.route('GET', '/', text('ok')),
  HttpRouter.route('GET', '/health', text('healthy')),
]
const httpApp = HttpRouter.addAll(routes)

const httpServer = HttpRouter.serve(httpApp).pipe(
  Layer.provide(
    nodeHttpLayer(() => createServer(), {
      port: httpPort,
      host: '127.0.0.1',
    }),
  ),
)

/** WebSocket handler that echoes text frames using the socket run loop. */
const handleConnection = Effect.fn('http-ws.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer

      const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
        Stream.pipeThroughChannel(toChannelString(socket)),
        Stream.mapEffect((msg) =>
          Effect.gen(function* () {
            yield* Effect.log(`ws recv ${msg}`)
            yield* write(`echo:${msg}`)
          }),
        ),
        Stream.runDrain,
      )

      yield* Effect.log('ws client connected')
      return yield* receive
    }),
  ).pipe(Effect.withSpan('http-ws.connection.scope'))
})

/** Run both the HTTP server and WebSocket server in one runtime. */
const program = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`ws listening on ${formatAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(
  Effect.withSpan('ws.server'),
  Effect.provide(
    Layer.mergeAll(layerWebSocket({ port: wsPort }), HttpRouter.layer, httpServer),
  ),
)

/**
 * Expected logs (example):
 * - ws listening on :::8790
 * - ws client connected
 * - ws recv hello
 */
NodeRuntime.runMain(program)


