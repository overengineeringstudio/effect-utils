# Spec: Effect–Rust interop foundation

This document specifies the reusable Effect–Rust boundary. It builds on [requirements.md](./requirements.md).

## Status

Draft. This is the target contract, not a claim that the foundation or Buck integration is implemented. The [experiment records](./.experiments/i-delivery.md) distinguish exercised prototypes from admission obligations.

## Scope

**Defines:** delivery constructors, packaging, generated composition, lifecycle, stream and host-capability boundaries, schema generation, and artifact admission.

**Does not define:** domain algorithms, application policy, content-address store/resolver behavior, a neutral IDL, public native npm distribution, or platform support beyond the admitted matrix.

The home is effect-utils: `@overeng/effect-rust` is the TypeScript package and `effect-rust` is the companion crate under the repository's `rust/` workspace. Both sides expose idiomatic APIs in their own language; binding types and wire representations do not become domain APIs.

## Delivery and responsibility (R01, R05, R07)

```text
Effect product service -> explicit Layer -> foundation runtime -> Rust adapter -> Rust core
                                                                            <- Rust caller
```

| Tier         | Constructor                         | Use                                               | Boundary                                           |
| ------------ | ----------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| wasm-bindgen | `wasmLayer.node/bun/browser/worker` | Default across supported runtimes                 | Scoped generated instance factory                  |
| Node-API     | `nativeLayer.node/bun`              | Measured desktop hot paths                        | Unwind-contained native context; Nix-fleet product |
| Subprocess   | `processLayer.node/bun`             | Coarse host-state/tree operations; hard isolation | Scoped child process and typed transport           |

Product Layers expose domain services; the foundation owns loading, jobs, resource release, errors, streaming, and codegen hooks. Native Rust callers depend directly on the core. Constructors do not detect a preferred tier, catch a failure to select another tier, or replay an operation during rebuild. Unsupported host functionality returns Unsupported, not a pretend portable implementation.

## Runtime packaging and admission (R06, R07, R09)

| Export condition / entry        | Artifact contract                                                     |
| ------------------------------- | --------------------------------------------------------------------- |
| `workerd`                       | Statically imported precompiled `WebAssembly.Module`; mandatory       |
| `browser`, `bun`, `default`     | Inline bytes and web glue by default                                  |
| `node`                          | Node CJS bindgen glue, isolated in a CommonJS package boundary        |
| Explicit `/url`                 | Application-supplied asset URL/Response with streaming initialization |
| Explicit native/process entries | Desktop-only imports, excluded from browser graphs                    |

Conditional exports select a wasm packaging adapter, not a delivery tier. Order conditions as `workerd`, `bun`, `node`, `browser`, `default`: Bun also matches `node`, so `bun` must precede it. Inline web glue omits the unused default module path so bundlers do not emit a second wasm artifact. Workers never compile arbitrary bytes at request time. Browser compilation still depends on the application's CSP. Darwin Node-API shared libraries link with `-Clink-arg=-Wl,-undefined,dynamic_lookup` so the runtime supplies `_napi_*` symbols; this flag is not a general Rust or wasm build setting.

Applications may select other legitimate source/delivery options when their asset, caching, isolation, or bundler preferences require them; each option has an explicit constructor/source contract and the same applicable admission smoke. URL delivery owns asset deployment and content type. Native products use native builders for each OS/architecture, not cross builds, and remain Nix-fleet products rather than portable public npm prebuilds.

Admission executes the known SHA-256 digest of `abc` using the emitted and installed artifacts: Node, Bun direct, Bun build plus execution, Vite dev/prod in Chromium, direct Chromium ESM by file URL over HTTP, and Workers requests. Vite success, Wrangler dry-run, a source-tree-coupled bundle, or a native link step alone is not a runtime pass. Release gates also exercise schema vectors and lifecycle failures below. Local workerd evidence is not production Cloudflare evidence.

## Application composition and build profile (R08, R09)

```text
app manifest -> Buck generator -> aggregator crate + TS adapters -> wasm + bindgen products
                           eager group -> shared WasmRuntime -> per-core Layers
                       named lazy group -> separate scoped WasmRuntime when requested
```

Each application manifest lists thin adapter crates and assigns them to one eager group or named lazy groups; it contains no Rust signatures or expressions inside TypeScript strings. `#[effect_rust::export]` declarations own the exports, and their build-time export manifest drives generated TypeScript bindings and service factories. Buck generates one aggregator crate and one wasm product per group; generated crates are build outputs, not committed sources. Linking deduplicates shared dependencies within a group. Cross-group duplication is an explicit cost of lazy loading. A shared `WasmRuntime` Layer supplies the group instance to its per-core Layers. Lazy groups load when their Layer is constructed, not during eager initialization. Laziness does not create CPU parallelism on a single JS thread.

Illustrative manifest shape (build API, not a deployed wire protocol):

```json
{
  "groups": {
    "eager": ["//rust/content-core-interop:lib"],
    "image-tools": ["//rust/image-core-interop:lib"]
  }
}
```

Group names are application-local, case-sensitive manifest keys. `eager` is reserved for the immediate group; other names match `[a-z][a-z0-9-]*` and are unique within the manifest. Crate references use Buck target syntax and resolve to exactly one adapter target. Unknown dependencies, duplicates, or conflicting assignments fail generation. These keys are not public service identifiers or package names.

The fleet-wide wasm size profile uses `opt-level=s`, fat LTO, symbol stripping, and pinned `wasm-opt -Oz` feature flags. It does not mandate `codegen-units=1`. Products may override the profile explicitly with their measured tradeoff and runtime smoke. Native builds retain unwind; wasm profile settings do not authorize native abort builds. Pin the Rust target/toolchain, bindgen crate and matching generator, Binaryen, and enabled wasm features. Never enable all Binaryen features opportunistically: an optimized output must still load in every admitted runtime.

Buck owns the wasm32 product, matching bindgen action, contract compiler action, artifact manifest, native shared-library products, and application aggregator generation; Nix distributes their outputs. [The Buck admission experiment](./.experiments/k2-build-admission.md) exercises these products on three native platforms. It does not make every runtime smoke a Buck gate: workerd and browser capability admission is tracked in [#1566](https://github.com/overengineeringstudio/effect-utils/issues/1566).

## Runtime lifecycle and panic containment (R10, R11, R15, R16)

```text
acquiring -> healthy -> closing -> retired
                | trap
                v
             poisoned -> retirement acknowledgment -> fresh healthy instance
```

1. A generated factory creates private lexical bindings, a job registry, cached views, and one instance scope. Validate ABI/contract identity before exposing services.
2. Register every synchronous/async operation and handle against its instance generation. Release borrows/locks before callbacks or awaits. Bound native task admission; CPU jobs poll cooperative cancellation tokens.
3. Interruption closes job admission, signals Rust cancellation and abortable host capabilities, and awaits `cancelAndJoin`. Acknowledgment means Rust work is stopped/dropped and handles released, not merely that a JS Promise rejected.
4. A synchronous trap or scheduler-poll trap marks the instance poisoned atomically, fails all pending Effects with the original defect, rejects stale handles, and blocks new work.
5. Retire poisoned state without calling unsafe Rust destructors or `free()` through broken mutable-borrow state. Sever factory, registry, callback, finalizer, and cached-view references; retirement acknowledgment replaces normal job acknowledgment.
6. The default policy rebuilds a fresh instance scope for subsequent calls. Never retry or replay failed operations. If fresh initialization fails, retain the cause as a defect and leave the scope unavailable; Init is only an acquisition failure during Layer construction. Healthy closing runs non-panicking release exactly once.

The foundation, not application-wide unhandled-exception hooks, owns the generated scheduler trap observer and registry. In-process lexical rebuilding is the default. `panicPolicy: 'retire'` explicitly selects retirement without rebuilding; dedicated Worker execution is a separate explicit choice where supported, with no fallback. Configuration cannot waive native admission or advertise pending-Promise rejection as quiescence.

Native exports guarantee containment of unwind panics only. Admission requires `panic=unwind` and generated catches around synchronous exports, every future poll, AsyncTask compute/resolve/reject, and owned cleanup before settlement. Abort artifacts or uncovered boundaries are rejected. Double panics during unwinding, OOM, and process faults are not covered. Recreating a native Layer creates a new context, not addon unload. Products needing hard crash isolation declare that requirement and use the subprocess tier; a JS Worker is not a native process-crash boundary.

**Retirement guarantees unreachability, not prompt release.** No registry, handle, observer, cached view, or late callback may retain a retired instance or memory, and no Rust code runs on it again. The engine garbage collector owns linear-memory release. [B3](./.experiments/b3-panic-reclamation.md) proves finite-run reclamation on Node/Bun/Chromium; [W](./.experiments/w-workerd-memory.md) closes the local workerd retention question but shows delayed collection and backing-store release, not a prompt-reclamation guarantee.

On workerd the runtime Layer is isolate-scoped, reused across requests, never constructed per request. Healthy requests do not retire a generation. Workerd memory admission remains open for products with large touched linear memories: production memory-limit behavior and mitigation measurements are [DQ8 and DQ9](#design-questions). Pressure-hint allocations and retired-bytes budgets are not default mechanisms.

## Host capabilities, ownership, and streams (R10, R12, R13, R15)

```text
Effect capability -> scoped callback -> Rust job -> bounded write/pull -> owned bytes
       interrupt -> abort or settle-only      -> cancelAndJoin -> release
```

| Capability mode | Interrupt behavior                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `abortable`     | Send cancellation to the actual host operation and await its stop acknowledgment                                  |
| `settle-only`   | Rust stops waiting and is released; host work may finish, its result is discarded and never touches retired state |

Read/fetch and other host capabilities are explicit typed services. Their adapters run Effects in the operation's scope, not untracked global runtimes. Each declares its cancellation mode. Late settle-only callbacks retain only host completion bookkeeping, not Rust jobs or borrowed views.

Default inputs are copied or transferred into owned storage before asynchronous/thread work; outputs are copied while producer storage is valid. No wasm-backed view survives a call by default. An opt-in borrowed/scoped path is marked in the Rust crate and generated API, states its invalidation events, and cannot return an escaping view or hold a borrow across callbacks, awaits, threads, or memory growth. Ownership must be corrected in the producer; copying already-freed data in JS is not a repair.

Input streams use scoped `write -> acknowledgment -> next pull`, followed by one `finish`. Output streams use `next -> Data(bytes) | End`; zero-length Data is not End. Every exit closes once. Limits cover maximum source chunk, transferred chunk, and in-flight bytes; oversized source chunks are rejected before an unbounded copy. No whole-stream collection or unbounded callback queue is hidden in the bridge.

Chunk profiles are configurable. The latency baseline is 64 KiB; the bulk baseline is 1 MiB. These are initial defaults, not universal optima. `maxSourceChunkBytes` and `inFlightBytes` must be positive and compatible with `maxChunkBytes`; per-job budgets bound concurrent transfers. Multiple handles may share an instance but identities include generation so stale handles cannot alias new jobs.

## Errors and API sketch (R05, R10–R15)

| Failure                     | Channel          | Meaning                                                                                  |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| Init                        | Layer failure    | Initial acquisition, artifact identity, or initialization failed                         |
| Transport                   | Expected failure | Host/process/ABI communication failed                                                    |
| Input                       | Expected failure | Generated input codec or declared boundary limits reject input                           |
| Unsupported                 | Expected failure | Chosen runtime/tier lacks a requested capability                                         |
| Generated domain error      | Expected failure | Domain-owned `Result::Err`, not relabeled as infrastructure failure                      |
| Panic / invariant violation | Defect           | Unexpected Rust/host invariant failure; retain cause, build, instance, operation context |
| Failed rebuild              | Defect           | Fresh state could not be acquired after poisoning; subsequent calls cannot use old state |

```text
plain Rust core -> thin export adapter -> generated bindings + make<Service>
                                             -> Interop Layer -> Effect service
```

The core uses ordinary Rust types, thiserror error enums, traits, iterators, and `impl Future`. Wire/schema derives live in the defining core behind an optional feature; the adapter cannot implement foreign traits for core types under Rust's orphan rule. No JS types, Foundation error taxonomy, or Effect discriminator are required in the core.

```rust
#[cfg_attr(feature = "contract", derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema))]
pub struct Digest([u8; 32]);

// Thin adapter crate: wasm/napi types are generated, not authored in the core.
#[effect_rust::export]
pub fn hash(bytes: effect_rust::Bytes) -> content_core::Digest {
    content_core::hash(&bytes)
}

#[effect_rust::export(input_stream)]
pub fn hasher() -> content_core::Hasher {
    content_core::Hasher::default()
}
```

| Adapter export mode | Rust-facing contract                                    | Generated Effect-facing contract                                |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| default             | Plain synchronous function, owned boundary bytes        | Effect-returning method                                         |
| `async`             | Future plus declared host capabilities                  | Interruptible Effect, capabilities in its environment           |
| `input_stream`      | Incremental writer with `update` and consuming `finish` | Scoped Sink                                                     |
| `output_stream`     | Iterator yielding owned chunks                          | Scoped Stream                                                   |
| `borrowed`          | Synchronous borrowed input, non-borrowing output        | Explicit scoped alternative; no await/callback or escaping view |
| `frame`             | Typed bulk rows                                         | Typed row method with a generated Borsh frame codec             |

The attribute macro emits wasm-bindgen glue under feature `wasm`, napi glue under feature `napi`, and export metadata for Buck. Generated boundary guards own lifecycle and panic handling. Rust APIs remain visible to rustc, rust-analyzer, rename, and rustdoc.

One Rust error enum maps to **one** Effect `Schema.TaggedError` whose `reason` is a tagged union of its variants. Rust retains its chosen serde discriminator (for example `kind`); the generated codec maps it to the Effect reason discriminator. The outer Effect `_tag` names the error enum, not a competing Rust variant tag.

```rust
#[derive(Debug, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum TreeError {
    #[error("not found: {path}")]
    NotFound { path: String },
    #[error("unsupported entry: {path}")]
    UnsupportedEntry { path: String },
}
```

```ts
export class TreeError extends Schema.TaggedError<TreeError>()('TreeError', {
  reason: Schema.Union([
    Schema.TaggedStruct('NotFound', { path: Schema.String }),
    Schema.TaggedStruct('UnsupportedEntry', { path: Schema.String }),
  ]),
}) {}

program.pipe(Effect.catchReason('TreeError', 'NotFound', (reason) => Effect.succeed(reason.path)))
```

Conceptual service and Layer surface; generated product types supply `ContentDigest`, `ContentCore`, and `makeContentCore`:

```ts
interface ContentCoreApi {
  readonly hash: (bytes: Uint8Array) => Effect.Effect<ContentDigest, Input>
  readonly hasher: Sink.Sink<ContentDigest, Uint8Array, never, Input>
  readonly chunks: (total: bigint) => Stream.Stream<Uint8Array, ChunkError | Input>
}

const portable = Interop.wasmLayer.browser(ContentCore, {
  load: () => import('@app/rust/eager'),
  make: makeContentCore,
  chunkProfile: 'latency',
  panicPolicy: 'rebuild',
}) // Layer.Layer<ContentCore, Init>

// Generated statics delegate to the same generic constructor.
const generatedPortable = ContentCore.layerWasm.browser({ panicPolicy: 'rebuild' })
const desktop = ContentCore.layerNative.node
const hostState = Interop.processLayer.node(HostTreeCore, {
  command: admittedProcessProduct,
  request: TreeRequest,
  response: TreeSummary,
  error: TreeError,
  make: makeHostTree,
})

const digest = yield * Stream.run(fileStream, (yield * ContentCore).hasher)
```

`Interop.wasmLayer.node/bun/browser/worker` and `Interop.nativeLayer.node/bun` are generic constructors; generated `Service.layerWasm.<runtime>` and `Service.layerNative.<runtime>` statics preconfigure the artifact and factory. Dedicated Worker isolation uses explicit `Interop.workerLayer` constructors only on admitted hosts. The `worker` wasm constructor refers to a Cloudflare Worker isolate, not a dedicated JS Worker. Init does not appear in service-method failure channels.

`wasmLayer` acquires the group's scoped `WasmRuntime`; `make` constructs the service from generated bindings. Input Sink and output Stream finalizers implement write/ack/finish and Data/End/close internally; consumers never manipulate raw handles. `cancelAndJoin` enforces interruption acknowledgment. `health`, `retire`, and `rebuildLayer` expose lifecycle without replay. Diagnostics distinguish instance-local handles/futures, process-wide native tasks, byte budgets, and poison causes.

## Schema ownership and semantic codecs (R02–R04, R14)

```text
Effect owner: live SchemaAST -------------------+
Rust owner: schemars 1.x + helper vocabulary ----+-> TS compiler IR
                                                   -> Effect code emitter
                                                   -> typed Rust source
                                                   -> JSON Schema + vocabulary
                                                   -> binary codecs + shared tests
```

Each contract has one authoring owner. The foundation owns a TypeScript compiler core walking the **live Effect SchemaAST**, not a lossy JSON export that has discarded check identifiers. It reuses Effect's code emitter for Effect output, reference naming, recursion, and deterministic formatting. Rust-owned contracts enter through schemars 1.x JSON Schema plus the `effect-rust` helper crate's semantic metadata. [B1](./.experiments/b1-schema-compiler.md) rejected the former Typify/validator and native-importer baseline; no existing stack met every must-have.

The compiler lowers a closed, versioned IR covering structs, records, arrays, literals, discriminated unions, refs/recursion, integer widths, string predicates, presence, and semantic scalars. Admission failures include the source path and a remedy: missing width or constrained-string identifier, unknown checks or required keywords, unsupported transforms/regex flags, unsafe number projections, UTF-16 length semantics, or optional/null ambiguity. `Schema.optionalKey` means missing-only; `NullOr` means nullable; undefined is not a JSON value. No types-only output, omitted predicate, or hand-mirrored validator is admitted.

### Extension vocabulary and regex

| Namespace                                                                         | Ownership and compatibility                                                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `https://github.com/overengineeringstudio/effect-utils/vocabulary/effect-rust/v1` | Repository-owned logical vocabulary URI, not a promise of a hosted schema endpoint                    |
| `x-effect-rust-*`                                                                 | Repository-owned lowercase ASCII JSON Schema keywords; suffix matches `[a-z][a-z0-9-]*`               |
| Contract identifiers                                                              | Owner-declared, case-sensitive identifiers unique within the contract set; collisions fail generation |

The JSON Schema 2020-12 dialect meta-schema declares the semantic vocabulary as required in `$vocabulary`; generated contract schemas select that dialect with `$schema`. Vocabulary and dialect version URIs end in `/v[1-9][0-9]*`. Unknown required vocabularies, unknown extension keywords, and incompatible major versions fail closed, never silently erase semantics. Extensions carry integer width/representation, millisecond DateTime, brands, and portable pattern flags. Register extensions once in the compiler with both emitters and shared vectors.

```json
{
  "$id": "https://github.com/overengineeringstudio/effect-utils/schema/effect-rust/v1",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$vocabulary": {
    "https://json-schema.org/draft/2020-12/vocab/core": true,
    "https://json-schema.org/draft/2020-12/vocab/validation": true,
    "https://github.com/overengineeringstudio/effect-utils/vocabulary/effect-rust/v1": true
  }
}
```

```json
{
  "$schema": "https://github.com/overengineeringstudio/effect-utils/schema/effect-rust/v1",
  "type": "string",
  "x-effect-rust-format": "u64-decimal"
}
```

The JSON Schema core vocabulary is standard; `x-effect-rust-format: "u64-decimal"` is repository-specific. A private extension must be explicitly registered under its owner's distinct namespace; merely prefixing an unknown keyword does not admit it. An unrecognized `/v2`, `x-effect-rust-Format`, or ad hoc semantic keyword is invalid to a v1 compiler.

Regex contracts use a strict reviewed cross-engine grammar with only `u` or `iu` flags. Each admitted construct has JS/Rust differential vectors; unsupported syntax fails generation. Code-point lengths, not UTF-16 code-unit lengths, define string bounds. The B1 five-pattern allowlist is prototype evidence, not the complete production grammar.

### Generated Rust

The [R bakeoff](./.experiments/r-generated-rust.md) selects **A-stream**: ordinary serde structs/enums plus validating private-field newtypes and streaming tagged-union decoding with wire-name error paths. Decode validates in one pass; invalid constrained values are not constructible. Newtypes expose `new`, `TryFrom`, `FromStr`, `AsRef<str>`, `Borrow<str>`, `Display`, and consuming access. Every pattern- or length-constrained string requires an owner `identifier`; inferred field-name types are not a fallback.

Generated contracts live in **one Buck-produced crate per contract set**, not a module included in the consumer. Types are exhaustive by default so additions force consumer migration. Owner opt-in `#[non_exhaustive]` adds constructors and open matching; keeping a separate defining crate makes that guarantee effective. Nutype/garde and contract-expansion proc macros are not the generated default; this choice does not prohibit the separate export attribute macro.

| Semantic field     | Generated Rust                                                            | Effect type / wire                                      |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| u64/i64            | Natural `u64`/`i64`, serde wire adapters                                  | Bounded `bigint` / decimal strings                      |
| DateTime           | `TimestampMillis` newtype enforcing millisecond precision at construction | `DateTime.Utc` / RFC3339 normalized to `Z`              |
| Missing-only       | `Option<T>` with missing-only codec                                       | `optionalKey`, rejects explicit null unless T admits it |
| Required nullable  | `Option<T>` with required-presence codec                                  | `NullOr`, missing key rejected                          |
| Optional nullable  | `Patch<T> { Absent, Null, Value(T) }`                                     | Omitted key / null / encoded value                      |
| Constrained string | Named validating newtype                                                  | Refined or branded string                               |
| Record             | Sorted-key map                                                            | Canonical sorted keys on encode                         |

Sub-millisecond DateTime is rejected, not silently truncated. Required-presence and missing-only codecs remain distinct even when both use `Option<T>`. `Patch::Absent` omits the field and must never collapse into `Null`.

Shared vectors assert acceptance, canonical decoded meaning, and encoded meaning on both sides. The compiler emits one Rust `#[test]` per vector and Effect/Vitest vector cases. Scalar extrema, nested paths, recursion, brands, presence, regex constructs, and canonical output belong in admission; object vectors alone do not prove JSON-text parser parity.

## Wire protocols (R03, R04, R12, R14)

```text
typed service call -> generated codec -> JSON control plane / binary bulk
                                          -> strict decode -> domain value
```

### JSON control plane

u64/i64 always encode as canonical base-10 decimal strings and decode to bounded bigint in Effect, natural integers in Rust. Every integer contract carries a width; generation rejects missing width rather than defaulting to safe JS numbers. Unsigned grammar is `0|[1-9][0-9]*`; signed grammar additionally allows `-[1-9][0-9]*`. Reject fractions, exponents, leading zeros, plus signs, whitespace, and negative zero, then check width bounds. Safe-number or optionally annotated mixtures are not a full-range transport.

Both sides implement a strict **I-JSON profile** at the JSON-text boundary: valid UTF-8 and Unicode scalar strings, finite numbers, no duplicate object keys (including tag keys), canonical integer tokens without fraction/exponent spelling, and maximum nesting depth **128** (root object/array counts as one). The Effect decoder detects duplicates and lexical integer violations before ordinary parsing erases them. Unknown fields are rejected everywhere (`deny_unknown_fields` and Effect `onExcessProperty: 'error'`); rolling upgrades need reader-first compatible deployments. No permissive per-contract excess-field escape hatch is admitted.

Encoders canonicalize object/record keys in lexicographic order on both sides, except the discriminator comes **first**, followed by sorted remaining keys. `_tag` is first for Effect-owned tagged unions; Rust-owned wire keeps its declared tag key and maps it to the Effect discriminator at decode. A discriminator selects one variant only; duplicate or unknown discriminators fail. Tag-last input is rejected rather than buffered into a JSON Value fallback. This tag-first choice is accepted **pending the friction bakeoff [DQ7](#design-questions)**; R's fallback demonstrated parity, not final admission of tag-last input. Canonical ordering here belongs to interop and does not take ownership of a domain's content-address encoding policy.

### Binary bulk

| Item                       | Contract                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- |
| Default layout             | Borsh with compiler-emitted, straight-line JS codec; Rust Borsh derive       |
| Envelope                   | Mandatory `[contract-id: u32 LE][version: u16 LE][payload]`                  |
| Default validation         | Generated codec checks plus Effect Schema validation                         |
| Trusted path               | Explicit `.trusted` opt-in for admitted emitted codecs on measured hot paths |
| Columns                    | Compiler-emitted fixed-width owned typed-array columns; equal-length checks  |
| Arrow                      | Only at actual Arrow ecosystem boundaries, not a universal bulk wire         |
| Excluded JS-facing formats | FlatBuffers, Cap'n Proto, bincode                                            |
| Protobuf                   | External contracts only, not the internal default                            |

The contract set owns the numeric contract-id registry; IDs are unique u32 values within the set, with collision checks in Buck. Version is a u16 schema-layout version; any positional layout change requires a new version. A group using multiple sets rejects ID collisions before packaging. Readers select the exact id/version decoder and reject unknown identities, versions, truncation, or trailing bytes before exposing data; no guessing or JSON fallback. The six-byte envelope is additional to, not replaced by, Borsh length prefixes.

The same compiler IR owns both codecs. Rust core types may carry **one** feature-gated binary format derive using `cfg_attr`; multi-format derive stacks are excluded. Frame exports present typed rows, not caller-built DataViews. Column methods present `BigUint64Array`/`BigInt64Array` and corresponding Rust slices; portable wire codecs use explicit fixed-width little endian, not host-endian typed-array serialization. Default decoded data is owned, including columns and byte fields.

```ts
const Sample = Schema.Struct({ id: Wire.U64, delta: Wire.I64 })
const SampleFrame = Wire.frame(Sample, { contractId: 1, version: 1 })
// Schema-validated by default; SampleFrame.trusted is explicit.
```

Trusted opt-in skips redundant Schema traversal only; mandatory envelope, lengths, widths/ranges, UTF-8, and ownership checks remain. Compiler-emitted codecs reject malformed counts before allocation and never modulo-wrap out-of-range integers. Borsh's four-byte offsets do not authorize borrowed eight-byte typed-array views. The [X evidence](./.experiments/x-binary-bulk.md) treats overlapping fixed-width timings as a tie class and measures Schema validation overhead; it is not a universal performance bound.

## Consumer pilots (R01–R16)

| Order | Consumer                                                                                                                   | Boundary exercised                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1     | [Content-address byte engine](../content-address/spec.md)                                                                  | Effect-owned descriptors, direct Rust reuse, portable/native tiers, streaming |
| 2     | Existing first-party wasm bindings (image utilities, color extraction, fuzzy matching): image utilities + color extraction | Producer ownership, packaging, shared aggregator dependencies                 |
| 3     | Existing first-party wasm bindings (image utilities, color extraction, fuzzy matching): fuzzy matching                     | Rust-owned contract, stateful handles and scoped teardown                     |

The foundation does not take ownership of content-address canonical JSON, pins, publication, stores, or resolver policies. DOM-specific image facades do not become Node/Workers capabilities by virtue of portable bytes.

## Design Questions

- **DQ7 Tag-first friction:** Does requiring `_tag`/the owner discriminator first cause significant producer, tooling, or external-consumer friction? Resolve with a bakeoff comparing streaming paths, ordering transformations, diagnostics, and realistic producers; the accepted tag-first rule remains pending that evidence.
- **DQ8 Cloudflare production memory:** What resident-memory peaks, memory-limit enforcement, collection/recycling behavior, and repeated large-linear-memory recovery occur on actual Cloudflare? Local workerd is insufficient. A temporary deployment experiment is authorized but has no result recorded here.
- **DQ9 Mitigation measurement:** Do retire-time ArrayBuffer pressure hints or rebuild/retired-bytes budgets improve production memory admission enough to justify heuristic coupling or loss of availability? Measure peaks, residue, latency, and defect behavior before selecting either; isolate-scoped Layer placement is already decided.
