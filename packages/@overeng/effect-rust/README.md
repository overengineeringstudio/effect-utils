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

`yield* Interop.hostSource(mode, { read, readRange })` captures a typed Source
implementation with the same scoped cancellation and quiescence ownership.
`readRange(path, offset: bigint, maxBytes: number)` backs Rust's
`Source::read_range(path, offset: u64, max_bytes: u32)`: the offset crosses the
callback boundary as canonical decimal u64 text, `maxBytes` is a positive u32,
and oversized responses are rejected. Empty bytes mean EOF; a short nonempty
read does not. Reads do not implicitly own a persistent file handle or
snapshot: the host implementation owns consistency when files change.
`Source::read(path)` remains the explicit whole-file capability.

`Source::yield_now()` awaits a cancellable host macrotask, allowing event-loop
work and cancellation delivery between CPU chunks. Call it between long
chunks; checking a cancellation token or yielding only a microtask is not an
event-loop yield. Cancellation remains cooperative, not CPU preemption:
synchronous wasm work still blocks its thread until it reaches a yield.
Use a dedicated Worker when browser main-thread responsiveness is required.

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

The Buck wasm and native products consume one admitted Rust `:lib` provider;
they do not independently activate Cargo backend features. A thin adapter used
by both products declares `default = ["wasm", "napi"]`, keeps its backend
dependencies target-specific, and gates exports by feature and target
architecture. The fixture adapters use this convention directly; native
availability must not depend on an unrelated workspace member enabling napi.

Declare `include_str!` / `include_bytes!` inputs in the Cargo package's
`BUCK.genie.ts` through `compileTimeResources`, separately from build-script
inputs. A local repository path inside the crate keeps its crate-relative
destination; a generated or external Buck label requires an explicit
`destination`. Resource bytes and mappings participate in projection
freshness. Unsafe paths and destinations that collide with another resource
or Rust source are rejected.

```ts
cargoBuck2PackageProjection({
  sourceUrl: import.meta.url,
  compileTimeResources: [
    { path: 'rust/effect-rust-fixtures/math-interop/vectors.json' },
  ],
})
```

## Portable contracts

Author contracts with ordinary Effect Schema nodes and checks. Bounded
`Schema.Int` and bounded `Schema.BigInt`, tagged structs/unions, records, brands,
code-point limits and supported portable patterns lower directly. Give nested
constrained strings a stable `identifier`. Naked unbounded integers, opaque
predicates and arbitrary transformations are not portable.

`EffectRust` supplies string-keyed metadata only where domain validation cannot
decide the boundary: `[EffectRust.width]` optionally pins integer storage,
`[EffectRust.timestampPrecision]: 'millis'` selects strict DateTimeUtc transport,
`[EffectRust.excess]: 'ignore'` explicitly changes a struct's default rejection
of unknown fields, and `[EffectRust.nonExhaustive]: true` selects Rust API
evolution policy without accepting unknown runtime tags.

```ts
import { Schema } from 'effect'
import { Borsh, ContractJson, EffectRust } from '@overeng/effect-rust'

const Deployment = Schema.TaggedStruct('Deployment', {
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  revision: Schema.BigInt.check(
    Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n }),
  ),
  updatedAt: Schema.DateTimeUtc.annotate({
    [EffectRust.timestampPrecision]: 'millis',
  }),
  owner: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const json = ContractJson.codec(Deployment)
const decode = Schema.decodeUnknownSync(json)
const encode = Schema.encodeSync(json)
const frame = Borsh.frame(Deployment, { contractId: 0x01020304, version: 1 })
```

`ContractJson.codec` is an ordinary Effect string codec preserving the authored
domain type. Bigints use canonical decimal JSON strings, never JSON numbers.
Timestamps require calendar-valid RFC3339 with an explicit offset and no
submillisecond loss, and canonicalize to `.sssZ`. JSON decoding rejects duplicate
keys, noncanonical or unsafe JSON integers and nesting beyond 128. Canonical
encoding sorts keys with the discriminator first. `decodeValue` / `encodeValue`
provide the corresponding strict boundary for already-parsed JSON.

`Schema.optionalKey(Schema.NullOr(T))` represents Patch directly in TypeScript:
missing, `null` and a present value stay distinct. Generated Rust keeps
`Patch<T>` for those three states; there is no tagged Patch ADT in the
TypeScript domain or JSON.

Integer storage is the smallest admitted width fitting the authored bounds,
unless `[EffectRust.width]` pins a compatible wider width. Original subrange
constraints remain independently enforced. Changing an inferred or pinned
width changes binary layout and requires a frame version bump.
`Borsh.frame(schema, { contractId, version })` validates by default, supports
explicit `.trusted` codecs and includes the mandatory
`[contract_id u32 LE][version u16 LE]` header. `Columns.make(numericStructSchema)`
allocates fixed-width columns derived from the same inferred/pinned schema
widths and validates their types, authored bounds and equal lengths. Safe
number fields wider than 32 bits use 64-bit typed-array storage without
changing their numeric JSON representation; bigint fields remain decimal
strings on JSON boundaries.

`Compiler.compile(contracts, { crateName, vectors, frames })` is a deterministic, in-memory compiler returning `{ ir, files }`: a standalone Rust contract crate, versioned JSON Schema, generated Effect Schema source, optional frame codecs, and shared vector tests. Build/filesystem orchestration belongs to the caller. `./runtime`, `./schema`, and `./compiler` subpaths expose the same boundaries independently.

For an existing Cargo workspace, use the discriminated member mode rather than
editing a generated manifest:

```ts
Compiler.compile(contracts, {
  crateName: 'deployment-contract',
  schemaMetadata: 'schemars',
  cargo: {
    mode: 'workspace',
    workspace: '..',
    inherit: ['version', 'edition', 'license'],
    dependencies: 'workspace',
  },
})
```

`schemaMetadata: 'schemars'` emits `JsonSchema` implementations directly from
the same validated IR as Rust and JSON Schema; adapters do not maintain a
second schema definition. Standalone mode owns its manifest and dependency
versions; workspace mode inherits the explicitly selected package metadata
and workspace dependency versions.

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
`EffectRust.pattern`. Multiline/global/sticky flags, unanchored patterns, and opaque
filters remain rejected. A final newline is not accepted unless the portable
pattern itself consumes it.

`Schema.TaggedStruct` and `Schema.tag` constant string-literal constructor
defaults are admitted without evaluating user code. The encoded discriminator
remains **required**: construction defaults are not decoding defaults.
Arbitrary runtime defaults and `tagDefaultOmit` remain rejected.

`optionalKey` wrappers retain the underlying named codec rather than generating
another nominal type. `Schema.optional(T)` is admitted at object keys:
`ContractJson.encode` omits an own `undefined` value only where the schema declares
that key optional, including nested objects. Required keys, array elements
and record values still reject `undefined`; omission does not admit `null`
unless `T` already does. Ordinary Effect Schema validation retains the authored
presence semantics; JSON collapses own-undefined and missing optional keys.

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
helper to imitate pure calls.

### Generated package admission

Declare generated service products in a consumer's TypeScript package
projection, instead of copying them into the source tree or defining a second
service tag:

```ts
typescriptPackage({
  // Alongside the consumer's source and dependency authority.
  generatedDependencies: {
    'effect-rust-fixture': '//rust/effect-rust-fixtures/service:service',
  },
})
```

The package graph supplies generated declarations and runtime artifacts to
typechecking, managed editor publication and runtime package trees. Generated
products do not carry copied `node_modules`; their admitted consumer supplies
the declared dependencies. The `effect-rust-fixture-consumer` fixture imports the
actual generated tag and runs both wasm and native Layers under Node and Bun.

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
