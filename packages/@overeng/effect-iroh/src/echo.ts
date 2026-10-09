import { Deferred, Effect, Fiber, Schema, Stream } from 'effect'

import { IrohEndpoint } from './mod.ts'

/** A versioned, schema-encoded example protocol, not a fleet control protocol. */
export const EchoMessage = Schema.Struct({
  apiVersion: Schema.Literal(1),
  payload: Schema.Union([
    Schema.TaggedStruct('Ping', { sequence: Schema.Natural, text: Schema.NonEmptyString }),
    Schema.TaggedStruct('Pong', { sequence: Schema.Natural, text: Schema.NonEmptyString }),
  ]),
}).annotate({ identifier: 'Iroh.EchoMessage' })
export const echoAlpn = 'effect-iroh/echo/1'

/** Run two actual QUIC endpoints, recording the selected path rather than guessing. */
export const roundTrip = Effect.fn('Iroh.echoRoundTrip')(function* (options: { readonly relay?: boolean; readonly nativeLibraryPath?: string } = {}) {
  const start = performance.now()
  const endpointOptions = {
    alpns: [echoAlpn], preset: options.relay === true ? 'n0' as const : 'minimal' as const,
    ...(options.nativeLibraryPath === undefined ? {} : { nativeLibraryPath: options.nativeLibraryPath }),
  }
  const server = yield* IrohEndpoint.make(endpointOptions)
  const client = yield* IrohEndpoint.make(endpointOptions)
  if (options.relay === true) yield* Effect.all([server.online, client.online], { concurrency: 'unbounded' })
  const serverAddr = yield* server.address
  const completed = yield* Deferred.make<void>()
  const echo = yield* Effect.scoped(Effect.gen(function* () {
    const connection = yield* server.accept
    if (connection === undefined) return yield* Effect.die('Echo endpoint closed before accepting')
    const bi = yield* connection.acceptBi
    const messages = bi.messages(EchoMessage)
    const requests = yield* Stream.runCollect(messages.read)
    yield* Stream.fromIterable(requests).pipe(
      Stream.map((message) => ({
        apiVersion: 1 as const,
        payload: { ...message.payload, _tag: 'Pong' as const },
      })),
      Stream.run(messages.write),
    )
    // Do not close the server connection until the client has received QUIC FIN.
    yield* Deferred.await(completed)
    return requests
  })).pipe(Effect.forkScoped)
  const bindMs = performance.now() - start
  const connectStart = performance.now()
  // Omit direct hints for relay bootstrap; n0 can subsequently hole-punch.
  const connection = yield* client.connect(options.relay === true
    ? { ...serverAddr, directAddresses: [] }
    : serverAddr, echoAlpn)
  const connectMs = performance.now() - connectStart
  const initialPaths = yield* connection.paths
  const bi = yield* connection.openBi
  const messages = bi.messages(EchoMessage)
  const exchangeStart = performance.now()
  const requests: readonly (typeof EchoMessage.Type)[] = [
    { apiVersion: 1, payload: { _tag: 'Ping', sequence: 0, text: 'hello over QUIC' } },
    { apiVersion: 1, payload: { _tag: 'Ping', sequence: 1, text: 'Grüße 👋 — schema framing' } },
  ]
  yield* Stream.fromIterable(requests).pipe(Stream.run(messages.write))
  const responses = yield* Stream.runCollect(messages.read)
  const exchangeMs = performance.now() - exchangeStart
  const finalPaths = yield* connection.paths
  yield* Deferred.succeed(completed, undefined)
  const received = yield* Fiber.join(echo)
  return {
    requests, responses, received, serverId: serverAddr.id, clientId: (yield* client.address).id,
    bindMs, connectMs, exchangeMs, totalMs: performance.now() - start,
    initialPaths, finalPaths,
    selectedPath: finalPaths.find((path) => path.isSelected),
  }
})
