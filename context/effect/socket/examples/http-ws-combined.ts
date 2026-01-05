import { createServer } from 'node:http'

import { NodeRuntime } from '@effect/platform-node'
import { layer as nodeHttpLayer } from '@effect/platform-node/NodeHttpServer'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { catchAllCause, empty, get } from '@effect/platform/HttpRouter'
import { serveEffect } from '@effect/platform/HttpServer'
import { text } from '@effect/platform/HttpServerResponse'
import type { CloseEvent, Socket as SocketType } from '@effect/platform/Socket'
import { toChannelString } from '@effect/platform/Socket'
import type { Address } from '@effect/platform/SocketServer'
import { SocketServer } from '@effect/platform/SocketServer'
import { Effect, Layer, Stream } from 'effect'

/**
 * Example: HTTP + WebSocket in one Effect runtime.
 *
 * Demonstrates:
 * - `HttpRouter` HTTP routes
 * - `Socket.toChannelString` for WS echo
 * - shared runtime via `Effect.all`
 */
const httpPort = 8788
const wsPort = 8790

/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Simple HTTP app with a couple of routes. */
const httpApp = empty.pipe(
  get('/', text('ok')),
  get('/health', text('healthy')),
  catchAllCause((cause) => Effect.logError(cause).pipe(Effect.as(text('internal error')))),
)

/** WebSocket handler that echoes text frames using the socket run loop. */
const handleConnection = Effect.fn('http-ws.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer

      const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
        Stream.pipeThroughChannel(toChannelString(socket)),
        Stream.mapEffect((text) =>
          Effect.gen(function* () {
            yield* Effect.log(`ws recv ${text}`)
            yield* write(`echo:${text}`)
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
const program = Effect.scoped(
  Effect.all(
    [
      serveEffect(httpApp).pipe(Effect.withSpan('http.server')),
      Effect.gen(function* () {
        const socketServer = yield* SocketServer
        yield* Effect.log(`ws listening on ${formatAddress(socketServer.address)}`)
        return yield* socketServer.run(handleConnection)
      }).pipe(Effect.withSpan('ws.server')),
    ],
    { concurrency: 2, discard: true },
  ),
).pipe(
  Effect.provide(
    Layer.mergeAll(
      nodeHttpLayer(() => createServer(), { port: httpPort, host: '127.0.0.1' }),
      layerWebSocket({ port: wsPort }),
    ),
  ),
)

/**
 * Expected logs (example):
 * - ws listening on :::8790
 * - ws client connected
 * - ws recv hello
 */
NodeRuntime.runMain(program)
