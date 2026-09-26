import { NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Fiber, Schema } from 'effect'
import type { SocketError } from 'effect/unstable/socket/Socket'
import {
  CloseEvent,
  layerWebSocketConstructorGlobal,
  makeWebSocket,
  readerString,
} from 'effect/unstable/socket/Socket'

/**
 * Example: WebSocket JSON client with schema validation.
 *
 * Demonstrates:
 * - `Schema.fromJsonString` for safe decoding/encoding
 * - typed request/response handling
 * - pull-based text reads via `Socket.readerString`
 * - graceful close after messages
 */
/** WebSocket endpoint for the JSON server. */
const url = 'ws://127.0.0.1:8791'

/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Tagged union for client -> server messages. */
const ClientMessageSchema = Schema.Union([
  Schema.TaggedStruct('ping', {
    id: Schema.String,
  }),
  Schema.TaggedStruct('echo', {
    text: Schema.String,
  }),
])

type ClientMessage = typeof ClientMessageSchema.Type

/** Tagged union for server -> client responses. */
const ServerMessageSchema = Schema.Union([
  Schema.TaggedStruct('pong', {
    id: Schema.String,
    receivedAt: Schema.Finite,
  }),
  Schema.TaggedStruct('echoed', {
    text: Schema.String,
  }),
])

type ServerMessage = typeof ServerMessageSchema.Type

/** Encode a typed client message to JSON. */
const encodeClientMessage = Effect.fn('ws-json.encode')(function* (message: ClientMessage) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(ClientMessageSchema))(message)
})

/** Decode a JSON string into a typed server response. */
const decodeServerMessage = Effect.fn('ws-json.decode')(function* (raw: string) {
  const message: ServerMessage = yield* Schema.decodeEffect(
    Schema.fromJsonString(ServerMessageSchema),
  )(raw)
  return message
})

/** Connect, send typed messages, and decode typed responses. */
const runClient = Effect.gen(function* () {
  const socket = yield* makeWebSocket(url, {
    openTimeout: Duration.seconds(5),
  })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const writer = yield* socket.writer
      /** Acquiring the reader dials the server (bounded by `openTimeout`). */
      const pull = yield* readerString(socket)

      /** Emit a ping then an echo message, then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const ping: ClientMessage = { _tag: 'ping', id: crypto.randomUUID() }
        const echo: ClientMessage = { _tag: 'echo', text: 'hello json' }

        const pingJson = yield* encodeClientMessage(ping)
        const echoJson = yield* encodeClientMessage(echo)

        yield* writer.write(pingJson)
        yield* Effect.sleep(Duration.millis(300))
        yield* writer.write(echoJson)
        yield* Effect.sleep(Duration.millis(300))
        yield* writer.write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('ws-json.client.send'))

      /** Decode and log every server response until the connection closes. */
      const receive = Effect.gen(function* () {
        while (true) {
          for (const text of yield* pull) {
            yield* decodeServerMessage(text).pipe(
              Effect.tap((decoded) => Effect.log(decoded)),
              Effect.catch((error) =>
                Effect.logError({ message: 'invalid server message', error }),
              ),
            )
          }
        }
      }).pipe(Effect.catchIf(isCleanClose, () => Effect.void))

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      yield* receive
      yield* Fiber.join(sendFiber)
    }),
  ).pipe(Effect.withSpan('ws-json.client.scope'))
}).pipe(Effect.withSpan('ws-json.client'))

const program = runClient.pipe(Effect.provide(layerWebSocketConstructorGlobal))

/**
 * Expected logs (example):
 * - { _tag: "pong", id: "<uuid>", receivedAt: <timestamp> }
 * - { _tag: "echoed", text: "hello json" }
 */
NodeRuntime.runMain(program)
