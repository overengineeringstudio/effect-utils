import { CloseEvent } from '@effect/platform/Socket'
import { NodeRuntime } from '@effect/platform-node'
import { makeNet } from '@effect/platform-node/NodeSocket'
import { Duration, Effect, Fiber } from 'effect'

/**
 * Example: TCP echo client.
 *
 * Demonstrates:
 * - `NodeSocket.makeNet` for TCP connect
 * - binary reads via `Socket.run`
 */
/** Connect to the TCP echo server and send a few messages. */
const runClient = Effect.gen(function* () {
  const socket = yield* makeNet({ port: 8793, host: '127.0.0.1' })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      /** Emit a small batch of messages then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const messages = ['hello tcp', 'effect rules', 'bye']
        for (const message of messages) {
          yield* write(message)
          yield* Effect.sleep(Duration.millis(300))
        }
        yield* write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('tcp-echo.client.send'))

      const receive = socket.run((data) => Effect.log(`recv bytes=${data.length}`))

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      const result = yield* receive
      yield* Fiber.join(sendFiber)
      return result
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
