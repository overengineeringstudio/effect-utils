# @overeng/effect-rust

Effect-facing services for plain Rust cores. Rust owns traits, iterators, futures, and domain errors; Effect owns Layers, Effects, Sinks, Streams, interruption, and scopes. Thin generated adapters translate between them.

## Explicit runtime Layers

```ts
import { Context, Effect } from 'effect'
import { Interop } from '@overeng/effect-rust'
import { load as loadContentCore } from './generated/content-core/load.ts'

interface Api {
  readonly hash: (bytes: Uint8Array) => string
}
class ContentCore extends Context.Service<ContentCore, {
  readonly hash: (bytes: Uint8Array) => Effect.Effect<string>
}>()('ContentCore') {}

const layer = Interop.wasmLayer.node(ContentCore, {
  // Generated lexical factory: fresh wasm-bindgen state AND instance per call.
  load: loadContentCore,
  make: (runtime: Interop.Runtime<Api>) => ({
    hash: Effect.fn('ContentCore.hash')((bytes: Uint8Array) =>
      runtime.call(({ api }) => api.hash(bytes))),
  }),
  panicPolicy: 'rebuild',
  chunkProfile: 'latency',
})

const digest = ContentCore.pipe(
  Effect.flatMap((core) => core.hash(new Uint8Array([1, 2, 3]))),
  Effect.provide(layer),
)
```

`wasmLayer.node`, `.bun`, `.browser`, and `.worker` are explicit constructors. `nativeLayer.node` and `.bun` load the selected native adapter. Nothing detects an environment or falls back to another transport. `load` returns `{ api, release }`; it may reuse an immutable compiled `WebAssembly.Module`, but not an initialized bindgen module or its mutable glue state. `release` must sever instance/glue references and stop generation-owned external callbacks; it must not invoke poisoned Rust destructors.

Service classes use `defineStatics(Service, { make, wasm?, native? })` with generated adapters to expose `ContentCore.layerWasm.node(options)`, `.bun`, `.browser`, `.worker`, and `layerNative.node` / `.bun` for the supplied loaders. The optional `wasm` and `native` records contain explicit loaders for each advertised runtime. Layer construction initializes the service; imports and static declarations do not initialize instances.

### Failure and lifetime

- `Init` is a typed construction failure only. A failed rebuild is a defect, never a new `Init` error in an operation's error channel.
- `Input`, `Transport`, and `Unsupported` are foundation `Schema.TaggedError` classes. Domain error enums are generated separately, preserving their reason union.
- A wasm trap poisons its entire generation: every pending Effect dies with the trap, Rust handles are retired without destructors, and glue is released. The default `panicPolicy: 'rebuild'` constructs fresh glue and an instance before further calls; `'retire'` permanently denies further calls. Calls and streams bound to the old generation cannot use the rebuilt instance accidentally.
- Native adapters expose caught panics with the `RUST_PANIC:` envelope, which is also a defect. The native build must enable unwinding and guard every export.
- The Layer's Scope owns the runtime. `Effect.provide(layer)` releases it when that Effect finishes. Use `Layer.build(layer)` in a caller-owned Scope if the service must live across multiple operations.

### Interruption and host capabilities

`runtime.call(({ api, signal }) => ...)` accepts a synchronous value, a Promise, or an explicit `RustJob`:

```ts
const job: Interop.RustJob<string> = {
  _tag: 'RustJob',
  mode: 'abortable',
  result: rustResult,
  cancel: () => rustCancelAcknowledgment,
}
```

An abortable job's `cancel` acknowledgment means Rust has dropped its future and cannot make further host calls. Interruption aborts the invocation's signal and waits for that acknowledgment. A bare Promise or `{ _tag: 'RustJob', mode: 'settle-only', result }` is settle-only: interruption waits for actual settlement and discards the result. Returning an acknowledgment before Rust quiescence violates the adapter contract.

`yield* Interop.hostCapability('abortable' | 'settle-only', (...args) => effect)` captures the Layer's dependencies. Each host operation gets its own Scope; its Promise settles only after its Effect finalizers. `capability.call(signal, ...args)` is the generated Rust host callback. Abortable callbacks interrupt on the signal; settle-only callbacks are allowed to finish. `quiesce` awaits outstanding host operations. Generated abortable jobs must await both the Rust cancellation acknowledgment and their invocation's outstanding host callbacks before acknowledging interruption.

### Input Sinks and output Streams

- `runtime.inputSink(open)` acquires an input handle with `write(bytes)`, consuming `finish()`, and `close()`. Writes are acknowledged before the next chunk or upstream pull. Successful `finish` consumes the handle; failed or interrupted use closes it through the Scope.
- `runtime.outputStream(open)` acquires a handle with `next(maxBytes)` and `close()`. `next` returns owned bytes or `undefined` at end. The runtime does not prefetch. A response larger than `maxBytes` is a typed `Transport` failure.
- `chunkProfile: 'latency'` uses 64 KiB; `'bulk'` uses 256 KiB. Input views are split without copying. Output chunks retain byte-budget permits until downstream requests the next chunk or closes the stream.
- `byteBudget` defaults to four profile chunks and must be at least one chunk. It is shared by a runtime's input and output streams, so concurrent streams backpressure by bytes rather than by an unbounded item queue. Downstream buffering added by the consumer is outside this budget.

## Isolates and dedicated Workers

`Interop.isolateRuntime(layer)` creates a `ManagedRuntime` owned by one isolate. Create it at the Workers/isolate entrypoint and use `runPromise` for requests; call `dispose` at shutdown. It is not a process-global singleton and must not be recreated for each request.

`workerLayer.browser` and `.node` own dedicated Workers and terminate them on Scope release. Their `{ load, request, response, error, make }` options use Schema codecs and an explicit message endpoint. Adapt standard Workers with `browserWorkerEndpoint(worker)` / `nodeWorkerEndpoint(worker)`. Inside the Worker, `serveWorker(endpoint, schemas, handle)` scopes the request registry and sends cancellation acknowledgments only after remote Effect/Rust finalizers finish.

`processLayer.node` and `.bun` accept `{ command, request, response, error, make }`. `command` is an Effect `ChildProcess.Command`; provide the runtime's explicit `ChildProcessSpawner` Layer. The process uses newline-delimited strict I-JSON, with a bounded stdin queue, scoped stdout/stderr fibers, and process termination on release. The protocol is:

- Parent: `{ _tag: 'Request', id, payload }` or `{ _tag: 'Cancel', id }`.
- Child/Worker: `{ _tag: 'Success' | 'Failure', id, payload }`, `{ _tag: 'Defect', id, message }`, or `{ _tag: 'Cancelled', id }`.
- `Cancelled` is an acknowledgment of quiescence, not merely receipt of `Cancel`. Transport failure terminates the isolate before acknowledging outstanding cancellation.

## Rust adapter integration

The adapter crate re-exports plain Rust core functions and applies `#[effect_rust::export]`. Its binary macro records produce `exports.json`; the Buck packager reads this manifest rather than accepting Rust source expressions in an application manifest. Product packages export concrete Api types and fresh lexical `{ api, release }` loaders through `./load`. A separate `rust_interop_service` package owns the generated Effect `Context.Service` class, `make<Service>` adapter, and explicit runtime Layer statics; consumers import that generated service rather than defining a second tag.

Domain error enums derive `serde::Serialize`, `serde::Deserialize`, and `effect_rust::ExportError`. Their serde discriminator remains the Rust wire contract's tag key. The generated Effect adapter maps that discriminator to `_tag` inside a single error class's nested `reason` union, making `Effect.catchReason` available without changing Rust's wire tag.

For `input_stream`, use `returns = "String"` (or the actual finish-result type) when the factory returns a `Hasher` whose consuming `finish` return type is not discoverable from that factory signature. This override is type metadata, not a source-code expression.

Frame exports require explicit `contract_id` and `version` metadata and Borsh row derives. Rows should declare `#[borsh(crate = "borsh")]` so the derive uses the explicit crate namespace in hermetic Buck builds. The TypeScript frame codec and Rust adapter must agree on both header values and the payload layout.

## Portable contracts

`Wire` provides width-annotated integers (`U64` / `I64` decode decimal strings to bigint), millisecond timestamps, constrained strings, patches, strict JSON, Borsh frames, and typed-array columns. `Wire.decode` / `encode` reject unknown fields by default. `decodeJson` rejects duplicate keys, noncanonical or unsafe JSON integers, and nesting beyond 128; `encodeJson` sorts keys with the tag key first. Give constrained string schemas an identifier and use `Schema.String.check(Wire.pattern(source, flags))`.

`Wire.Patch(schema)` distinguishes omitted, null, and present values as `Absent`, `Null`, and `Value`. `Wire.TimestampMillis` requires an explicit RFC3339 offset and exact millisecond precision and canonicalizes output to `.sssZ`. `Wire.frame(schema, { contractId, version })` validates by default, supports explicit `.trusted` codecs, and includes the mandatory `[contract_id u32 LE][version u16 LE]` header. `Wire.columns({ field: 'u64' | 'u32' | ... })` allocates fixed-width columns and validates their types and equal lengths.

`Compiler.compile(contracts, { crateName, vectors, frames })` is a deterministic, in-memory compiler returning `{ ir, files }`: a standalone Rust contract crate, versioned JSON Schema, generated Effect Schema source, optional frame codecs, and shared vector tests. Build/filesystem orchestration belongs to the caller. `./runtime`, `./schema`, and `./compiler` subpaths expose the same boundaries independently.
