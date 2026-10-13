# @overeng/effect-iroh

An Effect 4 wrapper over the official [`@number0/iroh`](https://docs.iroh.computer/languages/javascript) Node N-API binding for authenticated peer-to-peer QUIC connections and schema-framed messages. It targets Node and Bun desktop/server applications, not browsers.

## Owner

`agent/effect-utils/effect-iroh`

## Usage

```ts
import { Effect, Option, Stream } from 'effect'
import { IrohEndpoint } from '@overeng/effect-iroh'

const program = Effect.gen(function* () {
  const endpoint = yield* IrohEndpoint
  const connection = yield* endpoint.connect({ addr: peerAddress, alpn: 'my-protocol/1' })
  // Check connection.remoteId against application policy before processing data.
  const bi = yield* connection.openBi
  const protocol = bi.messages({ schema: MyVersionedSchema })
  yield* Stream.make(message).pipe(Stream.run(protocol.write))
  return yield* Stream.runCollect(protocol.read)
})

// The Layer owns bind/close; connection and stream acquisition require Scope.
// `peerAddress`, `MyVersionedSchema`, and `message` belong to the caller's protocol.
const run = Effect.scoped(program).pipe(
  Effect.provide(IrohEndpoint.layer({ alpns: ['my-protocol/1'] })),
)

// On the accepting endpoint, accept returns Option<IrohConnection>.
const acceptOne = Effect.gen(function* () {
  const endpoint = yield* IrohEndpoint
  const accepted = yield* endpoint.accept
  if (Option.isNone(accepted)) return // Endpoint closed.
  const connection = accepted.value
  // Check connection.remoteId against application policy before processing data.
  const bi = yield* connection.acceptBi
  return yield* Stream.runCollect(bi.messages({ schema: MyVersionedSchema }).read)
})
const acceptRun = Effect.scoped(acceptOne).pipe(
  Effect.provide(IrohEndpoint.layer({ alpns: ['my-protocol/1'] })),
)
```

## API notes

`IrohEndpoint.make(options)` permits multiple independent endpoints in one Scope.
`accept` is a scoped Effect returning `Option.Option<IrohConnection>`, with
`Option.none()` after endpoint closure. Endpoints also expose `connect({ addr, alpn })`, `address`,
`online`, and `close`. Connections expose `openBi`, `acceptBi`, `remoteId`, negotiated
`alpn`, observed `paths`, and `close`.
The `addr` argument is a `NodeAddr` containing the peer identity and addressing hints.

Bidirectional streams expose byte Streams/Sinks, explicit `close`, and
`messages({ schema, maxFrameBytes })` Streams/Sinks. Choose one reader and one
writer per stream half; do not mix the raw and framed interfaces on the same
half. Sinks send FIN after successful upstream completion. Frames are a four-byte
big-endian length followed by Schema JSON encoded as UTF-8; the default limit is
1 MiB. Failures are Schema-tagged `IrohInitError`, `IrohTransportError`, and
`IrohProtocolError`.

## Cancellation

Upstream promises have no cancellation handles, and the upstream `RecvStream`
holds an async mutex during `read`, so `stop()` cannot cancel a pending read.
Interruption therefore closes the owning **connection** for stream operations,
or the **endpoint** for accept/connect/online, and awaits native settlement.
Cancelling an accept ends that endpoint's accept loop; cancelling a read also
ends sibling streams on that connection. This conservative behavior avoids
abandoning Rust futures but is not per-operation cancellation.
Closing a stream with in-flight I/O also closes its owning connection rather than
waiting for `stop()` or `reset()` behind the pending native operation.

## Example

The [echo example](./src/echo.ts) uses an explicit `apiVersion: 1` envelope and
exchanges two Unicode-capable messages. Tests run two real endpoints on one host;
they are not evidence of cross-host hole punching or throughput.

## Binding choice

The official npm binding provides the endpoint/connection/stream handles and
platform builds without maintaining a second Rust adapter. The published
`@number0/iroh@1.1.0` binary bundles iroh core 1.0.2. Its manifest's `main` points
to a missing file, so this package explicitly loads `@number0/iroh/index.js`.

`nativeLibraryPath` can load an alternative build of the official binding. Do not
set `NAPI_RS_NATIVE_LIBRARY_PATH` globally: it also overrides unrelated N-API
modules such as Vitest's rolldown binding.

Alternatives considered:

- **Handwritten napi-rs crate:** duplicates upstream bindings and platform builds.
- **Our `@overeng/effect-rust` interop:** `#[effect_rust::resource]` rejects async
  methods, so iroh's async handle graph would need a new Rust wrapper plus an
  interop extension.
- **Rust sidecar process:** adds a process boundary, IPC protocol, and lifecycle.
- **Wasm:** [browser connections](https://docs.iroh.computer/languages/wasm-browser)
  are relay-only because the sandbox has no UDP, and there is no official browser
  npm package.

## Limitations

- The Linux/macOS/Windows matrix is not yet tested; official prebuilds lack Intel
  macOS.
- Cancellation is coarse: interrupting one operation closes its owning connection
  or endpoint.
- Byte arrays cross the native boundary as `number[]`.
- Application authorization and identity persistence are the caller's job; check
  `remoteId` before processing data.
