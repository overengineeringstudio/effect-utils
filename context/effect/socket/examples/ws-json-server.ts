import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect, Schema } from 'effect'
import { formatSocketAddress } from 'effect/unstable/net/NetAddress'
import type { Socket as SocketType, SocketError } from 'effect/unstable/socket/Socket'
import { readerString } from 'effect/unstable/socket/Socket'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: WebSocket JSON server with schema validation.
 *
 * Demonstrates:
 * - `Schema.fromJsonString` for safe decoding
 * - tagged unions for protocol design
 * - error logging on invalid payloads
 * - pull-based text reads via `Socket.readerString`
 */
/** Error surfaced when the client payload does not match the schema. */
class InvalidClientMessageError extends Schema.TaggedError<InvalidClientMessageError>()(
  'InvalidClientMessageError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    raw: Schema.String,
  },
) {}

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

/** Decode a JSON string into a typed client message. */
const decodeClientMessage = Effect.fn('ws-json.decode')(function* (raw: string) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(ClientMessageSchema))(raw).pipe(
    Effect.map((message) => {
      const decoded: ClientMessage = message
      return decoded
    }),
    Effect.mapError(
      (cause) =>
        new InvalidClientMessageError({
          cause,
          raw,
          message: 'Failed to decode client message',
        }),
    ),
  )
})

/** Encode a typed server message to JSON. */
const encodeServerMessage = Effect.fn('ws-json.encode')(function* (message: ServerMessage) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(ServerMessageSchema))(message)
})

/** Every close fails the pull; treat normal (1000) and abnormal (1006) closes as the end of the connection. */
const isCleanClose = (error: SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

/** Handle a connection with schema-validated JSON messages. */
const handleConnection = Effect.fn('ws-json.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const writer = yield* socket.writer
      /** Acquiring the reader attaches to the accepted connection. */
      const pull = yield* readerString(socket)

      const handleMessage = (text: string) =>
        decodeClientMessage(text).pipe(
          Effect.flatMap((message) => {
            const response: ServerMessage =
              message._tag === 'ping'
                ? { _tag: 'pong', id: message.id, receivedAt: Date.now() }
                : { _tag: 'echoed', text: message.text }

            return encodeServerMessage(response).pipe(Effect.flatMap((json) => writer.write(json)))
          }),
          Effect.catch((error) => Effect.logError({ message: 'invalid message', error })),
        )

      yield* Effect.log('client connected')

      while (true) {
        for (const text of yield* pull) {
          yield* handleMessage(text)
        }
      }
    }),
  ).pipe(
    Effect.catchIf(isCleanClose, () => Effect.void),
    Effect.withSpan('ws-json.connection.scope'),
  )
})

/** Run the websocket JSON server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatSocketAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(Effect.withSpan('ws-json.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8791 })))

/**
 * Expected logs (example):
 * - listening on [::]:8791
 * - client connected
 */
NodeRuntime.runMain(program)
