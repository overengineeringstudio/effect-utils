# Effect Socket / WebSocket Experiments

Runnable scripts demonstrating Effect Platform socket usage (mostly WebSockets) with real server + client pairs.

## Understanding Effect sockets

Effect sockets model a connection as a capability with scoped resources and explicit error channels. Compared to raw WebSocket APIs, cleanup and error handling are explicit (via `Effect.scoped` and error channels), while the shape of your messages stays under your control. You work with a `Socket` service that exposes two core pieces: a read loop (`run` / `runRaw`) and a scoped writer (`socket.writer`).

**Read + writer semantics (mapping to WebSocket primitives)**

- `socket.runRaw(handler)` attaches a message loop to the underlying WebSocket `message` events and completes when the connection closes or errors.
- `socket.run(handler)` is the same loop but normalizes data to `Uint8Array` for binary-first workflows.
- `Socket.toChannelString` / `Socket.toChannel` lift the read loop into a duplex `Channel` (it emits incoming messages and consumes outbound chunks).
- `socket.writer` is a scoped function that maps to `ws.send(...)` and `ws.close(...)` under the hood; closing the scope releases the writer and ends the connection.
- `runRaw` yields `string | Uint8Array`; use `Socket.toChannelString` when you want text decoding without manual `TextDecoder` usage.

Conceptually:

```
WebSocket events   -> Socket.runRaw / Socket.toChannelString -> handler / Channel
ws.send / ws.close -> socket.writer (scoped) / Channel input
```

**Lifecycle**

- Acquire the `Socket` (client: `Socket.makeWebSocket`, server: `SocketServer.run` provides one per connection).
- Enter `Effect.scoped` to ensure the writer and connection cleanup run when the scope ends.
- Start a read loop with `socket.run` (binary) or `socket.runRaw` (string or binary), or use `Socket.toChannelString` for a stream-friendly channel.
- Write using the scoped writer (can send `CloseEvent` to close cleanly).
- When the connection closes, the read loop ends with a `SocketCloseError` unless the close code is considered clean.

**Socket close behavior (common cases)**

- **Client or server calls `CloseEvent`**: send `new CloseEvent(1000, 'reason')` via `socket.writer` to initiate a clean close handshake.
- **Scope ends without explicit close**: the socket is closed by the underlying finalizer (client: `makeWebSocket` releases with code `1000`; server: `fromWebSocket` closes the `ws`).
- **Non-fatal close codes**: in these examples we treat code `1000` as clean, and we often also ignore `1006` (“abnormal closure”) so an abrupt disconnect doesn’t fail the read loop.
- **Non‑clean close codes**: any other close code (or an error during open/read) completes the read loop with `SocketCloseError` / `SocketGenericError`.
- **Custom close rules**: `makeWebSocket` / `fromWebSocket` accept `closeCodeIsError` to override what counts as clean.
- **Open timeout**: if the handshake does not finish in time, `runRaw` fails with a `SocketGenericError` (`OpenTimeout`).

Example (manual close with a reason):

```ts
const write = yield * socket.writer
yield * write(new Socket.CloseEvent(1000, 'done'))
```

Example (close after a specific message):

```ts
const receive = socket.runRaw((data) =>
  typeof data === 'string' && data === 'bye'
    ? Effect.flatMap(socket.writer, (write) => write(new Socket.CloseEvent(1000, 'bye')))
    : Effect.void,
)
```

Example (ignore clean closes explicitly):

```ts
socket.runRaw(handle).pipe(
  Effect.catchIf(
    Socket.SocketCloseError.isClean((code) => code === 1000 || code === 1006),
    () => Effect.void,
  ),
)
```

Example (direct read loop):

```ts
const receive = socket.runRaw((data) =>
  typeof data === 'string' ? Effect.log(`recv ${data}`) : Effect.void,
)
```

**Patterns and when to use them (pros, cons, scenarios)**

- **Direct read loop (`runRaw` / `run`)** — Pros: minimal overhead, simple control flow, easy cleanup. Cons: fewer stream combinators. Use when your handler is straightforward (echo, simple dispatch, small protocol).
- **Channel stream (`toChannelString` + `Stream.pipeThroughChannel`)** — Pros: text decoding built-in, full `Stream` operators, no manual `TextDecoder`. Cons: duplex channel requires an input stream (even empty). Use when you want stream transformations on incoming text.
- **Schema-first JSON** — Pros: validated messages + self-documenting protocol. Cons: decode/encode cost. Use for most app-level messaging.
- **RPC over WebSocket** — Pros: typed request/response + streaming. Cons: adds RPC framework. Use for API-style websockets.
- **RPC over HTTP upgrade** — Pros: share an HTTP server/port. Cons: on Node we currently see `Stream is already ended` logs during the upgrade response in this repo; prefer the SocketServer protocol unless you need a shared port.

Example (channel stream):

```ts
const socketTextStream = (socket: Socket) =>
  Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
    Stream.pipeThroughChannel(Socket.toChannelString(socket)),
  )
```

Example (schema-first JSON):

```ts
const MessageSchema = Schema.Union(
  Schema.TaggedStruct('ping', { id: Schema.String }),
  Schema.TaggedStruct('echo', { text: Schema.String }),
)

const decodeMessage = (raw: string) => Schema.decodeUnknown(Schema.parseJson(MessageSchema))(raw)

const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
  Stream.pipeThroughChannel(Socket.toChannelString(socket)),
  Stream.mapEffect((raw) => decodeMessage(raw)),
  Stream.runDrain,
)
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
