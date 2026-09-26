import { createServer } from 'node:http'

import { NodeRuntime } from '@effect/platform-node'
import { layer as nodeHttpLayer } from '@effect/platform-node/NodeHttpServer'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect, Layer } from 'effect'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { text } from 'effect/unstable/http/HttpServerResponse'
import { formatSocketAddress } from 'effect/unstable/net/NetAddress'
import type { Socket as SocketType, SocketError } from 'effect/unstable/socket/Socket'
import { readerString } from 'effect/unstable/socket/Socket'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: HTTP + WebSocket in one Effect runtime.
 *
 * Demonstrates:
 * - `HttpRouter` HTTP routes
 * - `Socket.readerString` pull loop for WS echo
 * - shared runtime via layer composition
 */
const httpPort = 8788
const wsPort = 8790

/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

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

/** WebSocket handler that echoes text frames from a pull loop. */
const handleConnection = Effect.fn('http-ws.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* socket.writer
      const pull = yield* readerString(socket)

      yield* Effect.log('ws client connected')

      while (true) {
        for (const msg of yield* pull) {
          yield* Effect.log(`ws recv ${msg}`)
          yield* writer.write(`echo:${msg}`)
        }
      }
    }),
  ).pipe(
    Effect.catchIf(isCleanClose, () => Effect.void),
    Effect.withSpan('http-ws.connection.scope'),
  )
})

/** Run both the HTTP server and WebSocket server in one runtime. */
const program = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`ws listening on ${formatSocketAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(
  Effect.withSpan('ws.server'),
  Effect.provide(Layer.mergeAll(layerWebSocket({ port: wsPort }), HttpRouter.layer, httpServer)),
)

/**
 * Expected logs (example):
 * - ws listening on [::]:8790
 * - ws client connected
 * - ws recv hello
 */
NodeRuntime.runMain(program)
