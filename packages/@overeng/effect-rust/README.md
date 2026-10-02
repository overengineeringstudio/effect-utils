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
class ContentCore extends Context.Service<
  ContentCore,
  {
    readonly hash: (bytes: Uint8Array) => Effect.Effect<string>
  }
>()('ContentCore') {}

const layer = Interop.wasmLayer.node(ContentCore, {
  // Generated lexical factory: fresh wasm-bindgen state AND instance per call.
  load: loadContentCore,
  make: (runtime: Interop.Runtime<Api>) => ({
    hash: Effect.fn('ContentCore.hash')((bytes: Uint8Array) =>
      runtime.call(({ api }) => api.hash(bytes)),
    ),
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
- Generated lexical wasm glue uses instance-local finalization registries. Live instances run bindgen finalizers normally; retiring an instance disables its delayed destructors before clearing wasm references, so garbage collection after Scope release cannot dereference retired glue.
- Native adapters expose caught panics with the `RUST_PANIC:` envelope, which is also a defect. The native build must enable unwinding and guard every export.
- The Layer's Scope owns the runtime. `Effect.provide(layer)` releases it when that Effect finishes. Use `Layer.build(layer)` in a caller-owned Scope if the service must live across multiple operations.
- Runtime acquisition is asynchronous. Once acquired, a synchronous export remains synchronous and can be evaluated with `Effect.runSync`; only PromiseLike results and explicit `RustJob` results suspend.

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

Cancellation is cooperative, not CPU preemption. `Source.read(path)` currently
returns one owned whole-file byte buffer; it is not a bounded streaming or
range-read capability. An abortable read can quiesce pending I/O, but a
synchronous long-running Rust loop on the wasm thread prevents the host from
delivering cancellation until it yields. Use a dedicated Worker when browser
main-thread responsiveness is required; do not advertise I/O cancellation as
preemptive computation.

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

The current Buck products consume the same admitted Rust `:lib` provider;
they do not independently activate Cargo's `wasm` or `napi` feature. An adapter
used by both products must already admit both features (the pilot uses
`default = ["wasm", "napi"]`). Keep its dependencies target-specific and its
exports gated by both feature and target architecture. Workspace feature
unification can make a wasm-only default appear to work in fixtures; do not
rely on an unrelated member to enable the native backend.

## Portable contracts

`Wire` provides width-annotated integers (`U64` / `I64` decode decimal strings to bigint), millisecond timestamps, constrained strings, patches, strict JSON, Borsh frames, and typed-array columns. `Wire.decode` / `encode` reject unknown fields by default. `decodeJson` rejects duplicate keys, noncanonical or unsafe JSON integers, and nesting beyond 128; `encodeJson` sorts keys with the tag key first. Give constrained string schemas an identifier and use `Schema.String.check(Wire.pattern(source, flags))`.

`Wire.Patch(schema)` distinguishes omitted, null, and present values as `Absent`, `Null`, and `Value`. `Wire.TimestampMillis` requires an explicit RFC3339 offset and exact millisecond precision and canonicalizes output to `.sssZ`. `Wire.frame(schema, { contractId, version })` validates by default, supports explicit `.trusted` codecs, and includes the mandatory `[contract_id u32 LE][version u16 LE]` header. `Wire.columns({ field: 'u64' | 'u32' | ... })` allocates fixed-width columns and validates their types and equal lengths.

`Compiler.compile(contracts, { crateName, vectors, frames })` is a deterministic, in-memory compiler returning `{ ir, files }`: a standalone Rust contract crate, versioned JSON Schema, generated Effect Schema source, optional frame codecs, and shared vector tests. Build/filesystem orchestration belongs to the caller. `./runtime`, `./schema`, and `./compiler` subpaths expose the same boundaries independently.

### Built-in admission and generated support

Named strings may use `Schema.isTrimmed()` and `Schema.isNonEmpty()` (or
`Schema.isMinLength(1)`). Trimmed validation uses the exact ECMAScript `trim`
whitespace set: U+0009–000D, U+0020, U+00A0, U+1680, U+2000–200A,
U+2028–2029, U+202F, U+205F, U+3000, and U+FEFF. U+0085 and U+200B are not
trim whitespace. Interior whitespace is allowed. Other UTF-16 length bounds
are not interchangeable with code-point bounds; use the explicit code-point
checks. Combining trimmed and a separate pattern still requires a reviewed
intersection rather than silently discarding either check.

Pinned Effect's built-in `Schema.isPattern` is admitted with `u` or `iu` when
the pattern satisfies the same fully anchored portable grammar as
`Wire.pattern`. Multiline/global/sticky flags, unanchored patterns, and opaque
filters remain rejected. A final newline is not accepted unless the portable
pattern itself consumes it.

`Schema.TaggedStruct` and `Schema.tag` constant string-literal constructor
defaults are admitted without evaluating user code. The encoded discriminator
remains **required**: construction defaults are not decoding defaults.
Arbitrary runtime defaults and `tagDefaultOmit` remain rejected.

`optionalKey` wrappers retain the underlying named codec rather than generating
another nominal type. `Schema.optional` still needs a JSON presence-policy
decision: its own-property `undefined` is not a JSON value, and the current
strict `Wire.encodeJson` rejects it. Do not use `null` as a substitute for
omission or for `Patch.Absent`.

Generated Rust helpers and dependencies follow the emitted definitions:
decimal `U64`/`I64`, `TimestampMillis`, and `Patch` support appear only when
used; `chrono` requires timestamps, and `regex` requires timestamps or a
pattern. Strict JSON support and Borsh/frame APIs remain part of every generated
contract crate. Borsh opt-out is not an implicit compiler optimization.

### Acquired engines versus pure module helpers

A Layer selects an implementation for an **acquired service**, not for an
already-imported pure module function. Keep existing pure helpers explicitly
JavaScript; acquire an application-owned engine facade inside a caller-owned
Scope for runtime-selected work. That facade can expose the same pure
signatures when its implementation genuinely supports synchronous calls.
Existing Effect operations can consult an optional engine service without
adding a mandatory backend to unrelated consumers.

Generated Service methods remain Effects. Do not hide `runSync`, a global
backend variable, or an asynchronously initialized instance behind a module
helper to imitate pure calls. Typed generated-Service package dependencies
must be admitted by the build/package graph; copying a build output into
`node_modules` is a local smoke technique, not package admission.

## Developer verification without a Buck daemon

Use the current platform's repository-admitted immutable executables from
`.buck2/capabilities/defs.bzl`. Cargo alone on `PATH` is insufficient: set
`RUSTC`, `RUSTDOC`, `CC`, `CXX`, and both Cargo linker overrides. The wasm
compiler sysroot must include `wasm32-unknown-unknown`; the packager requires
the admitted `wasm-bindgen` and `wasm-opt` paths.

For x86_64 Linux, this source-running recipe resolves the existing capabilities
rather than baking Nix store hashes into documentation:

```sh
eval "$(bun -e '
const text = await Bun.file(".buck2/capabilities/defs.bzl").text();
const capabilities = JSON.parse(
  text.slice(text.indexOf("{")).replace(/,\s*([}\]])/g, "$1"),
)["x86_64-linux"];
for (const [variable, id] of Object.entries({
  CARGO: "cargo", RUSTC: "rust-compiler", RUSTDOC: "rust-rustdoc",
  CC: "rust-c-compiler", CXX: "rust-cxx-compiler",
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "rust-linker",
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER: "rust-wasm-linker",
  WASM_BINDGEN: "wasm-bindgen", WASM_OPT: "wasm-opt",
  BUN: "bun", NODE: "node",
})) console.log(`export ${variable}=${JSON.stringify(capabilities[id].executableStorePath)}`);
')"
export CARGO_BUILD_JOBS=6
"$CARGO" test --manifest-path rust/Cargo.toml -p effect-rust --features contract
"$CARGO" build --manifest-path rust/Cargo.toml -p effect-rust-fixture-napi --release
"$CARGO" build --manifest-path rust/Cargo.toml -p effect-rust-fixture-wasm \
  --release --target wasm32-unknown-unknown
```

Package the resulting adapters with `buck2/rust/interop-package.ts`, then run
`rust/effect-rust-fixtures/smoke.mjs` against both package directories. Generate
the service with `buck2/rust/interop-service.ts`; run
`rust/effect-rust-fixtures/service-smoke.ts` with the service directory and
`rust/effect-rust-fixtures/math-interop/vectors.json`. Use `$BUN` for TypeScript
source. Node source examples require `$NODE --experimental-transform-types`
when they reach parameter-property declarations; plain type stripping is not
enough. Node cannot transform TypeScript inside `node_modules`, so use compiled
`dist` for such dependencies. The Buck service-smoke rules already stage
compiled runtime output.

Direct Cargo/Bun fixture smokes prove adapter, packaging, and runtime behavior.
They do not prove Buck daemon startup, action execution, or exact production
optimization settings; report those separately.
