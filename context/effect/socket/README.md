# Effect Socket / WebSocket Experiments

Runnable scripts demonstrating Effect Platform socket usage (mostly WebSockets) with real server + client pairs.

## Understanding Effect sockets

Effect sockets model a connection as a capability with scoped resources and explicit error channels. Compared to raw WebSocket APIs, cleanup and error handling are explicit (via `Effect.scoped` and error channels), while the shape of your messages stays under your control. You work with a `Socket` service that exposes two scoped acquisitions: a pull-based `socket.reader` and a `socket.writer`.

**Reader + writer semantics (mapping to WebSocket primitives)**

- `socket.reader` acquires the connection (client sockets dial here; server sockets attach to the accepted connection) and yields a `Reader` whose `pull` returns a non-empty batch of frames (`string | Uint8Array`). Nothing is read from the transport until you pull, so consumption is backpressured end-to-end.
- `Socket.readerString(socket)` / `Socket.readerBytes(socket)` acquire the same pull but normalize frames to `string` (via `TextDecoder`) or `Uint8Array`.
- `pull` never completes normally: every termination, including a clean close, fails with a `SocketError` whose `reason` is a `SocketCloseError` (carrying `code` / `closeReason`), `SocketReadError`, or `SocketOpenError`.
- `socket.writer` yields a `Writer` with `write(chunk | CloseEvent)` and `writeAll(chunks)`; these map to `ws.send(...)` / `ws.close(...)` (or `socket.write(...)` / `destroy()` for TCP) and apply the transport's native backpressure. Writes made before the reader has connected wait until it has.
- `Socket.toStream` exposes the read side as a `Stream<Uint8Array, SocketError>`; `Socket.toChannel` / `Socket.toChannelString` build a duplex `Channel` that writes its input batches to the socket and emits incoming batches.

Conceptually:

```
WebSocket events   -> socket.reader / Socket.readerString -> pull (batches) / Socket.toStream
ws.send / ws.close -> socket.writer (write / writeAll)    / Socket.toChannel input
```

**Lifecycle**

- Obtain the `Socket` (client: `Socket.makeWebSocket` / `NodeSocket.makeNet`, which do not connect yet; server: `SocketServer.run` provides one per connection).
- Enter `Effect.scoped`; acquire `socket.writer` and the reader (`socket.reader`, `Socket.readerString`, or `Socket.readerBytes`). The reader acquisition owns the connection: code between it and the first pull runs once per connection.
- Pull in a loop and write with the writer (send a `CloseEvent` to close cleanly).
- When the connection closes, the pull fails with `SocketError`; catch the close reasons you consider normal. Closing the scope closes the connection.

**Socket close behavior (common cases)**

- **Client or server sends `CloseEvent`**: `writer.write(new CloseEvent(1000, 'reason'))` initiates a clean close handshake (TCP: destroys the connection).
- **Scope ends without explicit close**: the reader's finalizer closes the connection (client: `makeWebSocket` releases with code `1000`; server: the accepted `ws` is closed).
- **Every close is an error**: sockets no longer classify close codes. The pull fails with `SocketError` wrapping `SocketCloseError`; in these examples we treat code `1000` and `1006` (“abnormal closure”) as the normal end of a connection and let every other code fail.
- **Open timeout**: if the handshake does not finish within `openTimeout`, acquiring the reader fails with `SocketError` wrapping `SocketOpenError` (`kind: 'Timeout'`).
- **Reconnect**: wrap the scoped read loop in `Effect.retry`; each retry re-acquires the reader and dials again (client sockets only).

Example (read loop with clean-close handling):

```ts
const isCleanClose = (error: Socket.SocketError) =>
  error.reason._tag === 'SocketCloseError' &&
  (error.reason.code === 1000 || error.reason.code === 1006)

const receive = Effect.gen(function* () {
  const pull = yield* Socket.readerString(socket)
  while (true) {
    for (const text of yield* pull) {
      yield* Effect.log(`recv ${text}`)
    }
  }
}).pipe(
  Effect.scoped,
  Effect.catchIf(isCleanClose, () => Effect.void),
)
```

Example (manual close with a reason):

```ts
const writer = yield * socket.writer
yield * writer.write(new Socket.CloseEvent(1000, 'done'))
```

Example (close after a specific message):

```ts
const writer = yield * socket.writer
const pull = yield * Socket.readerString(socket)
while (true) {
  for (const text of yield * pull) {
    if (text === 'bye') yield * writer.write(new Socket.CloseEvent(1000, 'bye'))
  }
}
```

**Patterns and when to use them (pros, cons, scenarios)**

- **Pull loop (`Socket.readerString` / `Socket.readerBytes` + `socket.writer`)** — Pros: minimal overhead, explicit backpressure, simple control flow, easy cleanup. Cons: fewer stream combinators. Use when your handler is straightforward (echo, simple dispatch, small protocol). Used by most examples here.
- **Read-only stream (`Socket.toStream`)** — Pros: full `Stream` operators on incoming bytes. Cons: binary only (add `Stream.decodeText()` for text). Use when you want stream transformations on incoming data (see `tcp-echo-client.ts`).
- **Duplex channel (`Socket.toChannel` / `Socket.toChannelString` + `Stream.pipeThroughChannel`)** — Pros: outgoing stream and incoming stream in one pipeline. Cons: outgoing messages must be expressible as a `Stream`. Use when both directions are naturally streams.
- **Schema-first JSON** — Pros: validated messages + self-documenting protocol. Cons: decode/encode cost. Use for most app-level messaging.
- **RPC over WebSocket** — Pros: typed request/response + streaming. Cons: adds RPC framework. Use for API-style websockets.
- **RPC over HTTP upgrade** — Pros: share an HTTP server/port. Cons: on Node we currently see `Stream is already ended` logs during the upgrade response in this repo; prefer the SocketServer protocol unless you need a shared port.

Example (read-only stream):

```ts
const receive = Socket.toStream(socket).pipe(
  Stream.runForEach((data) => Effect.log(`recv bytes=${data.length}`)),
  Effect.catchIf(isCleanClose, () => Effect.void),
)
```

Example (schema-first JSON):

```ts
const MessageSchema = Schema.Union([
  Schema.TaggedStruct('ping', { id: Schema.String }),
  Schema.TaggedStruct('echo', { text: Schema.String }),
])

const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(MessageSchema))

const receive = Effect.gen(function* () {
  const pull = yield* Socket.readerString(socket)
  while (true) {
    for (const raw of yield* pull) {
      yield* decodeMessage(raw)
    }
  }
})
```

Example (RPC over WebSocket):

```ts
const Api = RpcGroup.make(Ping, Add)

const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
  Layer.provide(
    Layer.mergeAll(
      RpcSerialization.layerJson,
      NodeSocketServer.layerWebSocket({ port: 8794, path: '/rpc' }),
    ),
  ),
)

const server = RpcServer.layer(Api).pipe(
  Layer.provide(
    Layer.mergeAll(Api.toLayer({ ping: pingHandler, 'math.add': addHandler }), protocolLayer),
  ),
)
```

## Concrete code examples (commands)

WS echo

- Server: `bun examples/ws-echo-server.ts`
- Client: `bun examples/ws-echo-client.ts`

WS broadcast

- Server: `bun examples/ws-broadcast-server.ts`
- Client: `bun examples/ws-broadcast-client.ts`

WS JSON (schema-first)

- Server: `bun examples/ws-json-server.ts`
- Client: `bun examples/ws-json-client.ts`

HTTP + WS combined

- Server: `bun examples/http-ws-combined.ts`
- Test HTTP: `curl http://127.0.0.1:8788/`

RPC over WebSocket

- Server: `bun examples/rpc-ws-server.ts`
- Client: `bun examples/rpc-ws-client.ts`

TCP echo

- Server: `bun examples/tcp-echo-server.ts`
- Client: `bun examples/tcp-echo-client.ts`

## Quickstart

```bash
bun examples/ws-echo-server.ts
# in another terminal
bun examples/ws-echo-client.ts
```
