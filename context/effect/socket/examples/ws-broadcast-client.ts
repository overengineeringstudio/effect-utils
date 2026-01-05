import type { Socket as SocketType } from '@effect/platform/Socket'
import {
  CloseEvent,
  layerWebSocketConstructorGlobal,
  makeWebSocket,
  toChannelString,
} from '@effect/platform/Socket'
import { NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Fiber, Stream } from 'effect'

/**
 * Example: WebSocket broadcast client.
 *
 * Demonstrates:
 * - text streaming via `Socket.toChannelString`
 * - basic send loop and graceful close
 */
/** WebSocket endpoint for the broadcast server. */
const url = 'ws://127.0.0.1:8789'

/** Convert socket messages into a Stream of text frames. */
const socketTextStream = (socket: SocketType) =>
  Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
    Stream.pipeThroughChannel(toChannelString(socket)),
  )

/** Connect, publish a few messages, and log any broadcasts. */
const runClient = Effect.gen(function* () {
  const socket = yield* makeWebSocket(url)

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      /** Emit a small batch of messages then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const messages = ['hello', 'anyone here?', 'bye']
        for (const message of messages) {
          yield* write(message)
          yield* Effect.sleep(Duration.millis(500))
        }
        yield* write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('ws-broadcast.client.send'))

      const receive = socketTextStream(socket).pipe(
        Stream.mapEffect((text) => Effect.log(`recv ${text}`)),
        Stream.runDrain,
      )

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      const result = yield* receive
      yield* Fiber.join(sendFiber)
      return result
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
