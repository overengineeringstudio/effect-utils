import { NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Fiber } from 'effect'
import type { SocketError } from 'effect/unstable/socket/Socket'
import {
  CloseEvent,
  layerWebSocketConstructorGlobal,
  makeWebSocket,
  readerString,
} from 'effect/unstable/socket/Socket'

/**
 * Example: WebSocket broadcast client.
 *
 * Demonstrates:
 * - pull-based text reads via `Socket.readerString`
 * - basic send loop and graceful close
 */
/** WebSocket endpoint for the broadcast server. */
const url = 'ws://127.0.0.1:8789'

/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Connect, publish a few messages, and log any broadcasts. */
const runClient = Effect.gen(function* () {
  const socket = yield* makeWebSocket(url)

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const writer = yield* socket.writer
      /** Acquiring the reader dials the server; the connection lives as long as this scope. */
      const pull = yield* readerString(socket)

      /** Emit a small batch of messages then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const messages = ['hello', 'anyone here?', 'bye']
        for (const message of messages) {
          yield* writer.write(message)
          yield* Effect.sleep(Duration.millis(500))
        }
        yield* writer.write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('ws-broadcast.client.send'))

      /** Log every broadcast until the connection closes. */
      const receive = Effect.gen(function* () {
        while (true) {
          for (const text of yield* pull) {
            yield* Effect.log(`recv ${text}`)
          }
        }
      }).pipe(Effect.catchIf(isCleanClose, () => Effect.void))

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      yield* receive
      yield* Fiber.join(sendFiber)
    }),
  ).pipe(Effect.withSpan('ws-broadcast.client.scope'))
}).pipe(Effect.withSpan('ws-broadcast.client'))

const program = runClient.pipe(Effect.provide(layerWebSocketConstructorGlobal))

/**
 * Expected logs (example):
 * - recv [system] <uuid> joined
 * - recv [<uuid>] hello
 * - recv [<uuid>] anyone here?
 * - recv [<uuid>] bye
 */
NodeRuntime.runMain(program)
