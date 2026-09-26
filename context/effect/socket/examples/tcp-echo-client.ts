import { NodeRuntime } from '@effect/platform-node'
import { makeNet } from '@effect/platform-node/NodeSocket'
import { Duration, Effect, Fiber, Stream } from 'effect'
import type { SocketError } from 'effect/unstable/socket/Socket'
import { CloseEvent, toStream } from 'effect/unstable/socket/Socket'

/**
 * Example: TCP echo client.
 *
 * Demonstrates:
 * - `NodeSocket.makeNet` for TCP connect
 * - backpressured binary reads via `Socket.toStream`
 * - clean close via `Socket.CloseEvent`
 */
/** Every close fails the read side; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Connect to the TCP echo server and send a few messages. */
const runClient = Effect.gen(function* () {
  /** Constructing the socket does not dial; reading does. */
  const socket = yield* makeNet({ port: 8793, host: '127.0.0.1' })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle; writes wait until the reader has connected. */
      const writer = yield* socket.writer

      /** Emit a small batch of messages then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const messages = ['hello tcp', 'effect rules', 'bye']
        for (const message of messages) {
          yield* writer.write(message)
          yield* Effect.sleep(Duration.millis(300))
        }
        yield* writer.write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('tcp-echo.client.send'))

      /** `Socket.toStream` dials the connection and emits incoming byte chunks until it closes. */
      const receive = toStream(socket).pipe(
        Stream.runForEach((data) => Effect.log(`recv bytes=${data.length}`)),
        Effect.catchIf(isCleanClose, () => Effect.void),
      )

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      yield* receive
      yield* Fiber.join(sendFiber)
    }),
  ).pipe(Effect.withSpan('tcp-echo.client.scope'))
}).pipe(Effect.withSpan('tcp-echo.client'))

/**
 * Expected logs (example):
 * - recv bytes=9
 * - recv bytes=12
 * - recv bytes=3
 */
NodeRuntime.runMain(runClient)
