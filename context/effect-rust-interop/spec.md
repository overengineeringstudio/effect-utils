# Spec: Effect–Rust interop foundation

This document specifies the reusable Effect–Rust boundary. It builds on [requirements.md](./requirements.md).

## Status

Active. This describes the implemented system in the open implementation stack, not a claim that those PRs have merged or that production Cloudflare admission is complete.

| Implemented surface                                               | Public implementation                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible archive fixture prerequisite                         | [#1592](https://github.com/overengineeringstudio/effect-utils/pull/1592)                                                                                                                                                     |
| wasm32, bindgen, Node-API and aggregator products                 | [#1615](https://github.com/overengineeringstudio/effect-utils/pull/1615)                                                                                                                                                     |
| Compiler, runtime, export macros and generated services           | [#1578](https://github.com/overengineeringstudio/effect-utils/pull/1578)                                                                                                                                                     |
| Opt-in content-address Rust byte engine                           | [#1602](https://github.com/overengineeringstudio/effect-utils/pull/1602)                                                                                                                                                     |
| External browser assets, scoped resources, typed direct transport | [#1604](https://github.com/overengineeringstudio/effect-utils/pull/1604), [#1605](https://github.com/overengineeringstudio/effect-utils/pull/1605), [#1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) |

The asset/resource/direct stack branches from the foundation independently of the content-address pilot. Historical [experiment records](./.experiments/i-delivery.md) retain their original coverage limits; implementation PRs identify the heads actually exercised. Browser/workerd smokes have real runtime evidence but are not yet admitted Buck smoke capabilities ([#1566](https://github.com/overengineeringstudio/effect-utils/issues/1566)). Existing product-check failures ([#1564](https://github.com/overengineeringstudio/effect-utils/issues/1564)), watcher startup ([#1590](https://github.com/overengineeringstudio/effect-utils/issues/1590)), and inherited compiler wrappers ([#1599](https://github.com/overengineeringstudio/effect-utils/issues/1599)) are build issues, not unresolved interop designs.

## Scope

**Defines:** delivery constructors, packaging, generated composition, lifecycle, stream and host-capability boundaries, schema generation, and artifact admission.

**Does not define:** domain algorithms, application policy, content-address store/resolver behavior, a neutral IDL, public native npm distribution, or platform support beyond the admitted matrix.

The home is effect-utils: `@overeng/effect-rust` is the TypeScript package and `effect-rust` is the companion crate under the repository's `rust/` workspace. Both sides expose idiomatic APIs in their own language; binding types and wire representations do not become domain APIs.

## Delivery and responsibility (R01, R05, R07)

```text
Effect product service -> explicit Layer -> foundation runtime -> Rust adapter -> Rust core
                                                                            <- Rust caller
```

| Tier         | Constructor                                        | Use                                               | Boundary                                           |
| ------------ | -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| wasm-bindgen | `wasmLayer.node/bun/browser/browserWorker/workerd` | Default across supported runtimes                 | Scoped generated instance factory                  |
| Node-API     | `nativeLayer.node/bun`                             | Measured desktop hot paths                        | Unwind-contained native context; Nix-fleet product |
| Subprocess   | `processLayer.node/bun`                            | Coarse host-state/tree operations; hard isolation | Scoped child process and typed transport           |

Product Layers expose domain services; the foundation owns loading, jobs, resource release, errors, streaming, and codegen hooks. Native Rust callers depend directly on the core. Constructors do not detect a preferred tier, catch a failure to select another tier, or replay an operation during rebuild. Unsupported host functionality returns Unsupported, not a pretend portable implementation.

## Runtime packaging and admission (R06, R07, R09)

| Export condition / entry                    | Artifact contract                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `workerd`                                   | Statically imported precompiled `WebAssembly.Module`; no fetch or runtime compilation |
| `bun`                                       | Inline bytes and web glue                                                             |
| `node`                                      | Node CJS bindgen glue, isolated in a CommonJS package boundary                        |
| `browser`, `default`                        | External emitted wasm asset using pinned bindgen URL/fetch/streaming glue             |
| `./browser-worker`, `./browser-worker/load` | External wasm asset in a browser Worker                                               |
| `./workerd`, `./workerd/load`               | Explicit precompiled-module entry                                                     |
| `./inline`, `./inline/load`                 | Explicit inline bytes; no fetch                                                       |
| Explicit `./url`                            | Application-supplied asset URL/Response                                               |
| Explicit native/process entries             | Desktop-only imports, excluded from browser graphs                                    |

Conditional exports select a wasm packaging adapter, not a delivery tier. Order conditions as `workerd`, `bun`, `node`, `browser`, `default`: Bun also matches `node`, so `bun` must precede it. The fresh-instance `./load` entry uses inline bytes on Node/Bun, external assets on browser/default, and precompiled Modules on workerd. Browser glue retains `new URL(..., import.meta.url)` and bindgen's fetch/`instantiateStreaming` path; serve `application/wasm`. Inline/workerd glue omits the unused default module path so bundlers do not emit a duplicate asset. There is no automatic switch to inline or another tier. Browser compilation depends on the application's CSP. Darwin Node-API libraries link with `-Clink-arg=-Wl,-undefined,dynamic_lookup` only for runtime-supplied `_napi_*` symbols.

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

Buck owns the wasm32 target transition, pinned bindgen/optimizer action, shared-library products, generated application aggregators and service packages. `rust_wasm_aggregator` emits one crate and product per group; `rust_interop_service` consumes compiled export metadata and emits the service. Node/Bun smokes execute these real products. Browser/workerd runtime evidence remains out-of-tree until their smoke capabilities are admitted.

The shipped wasm-bindgen, Node-API and aggregator rules and wasm target transition live in [buck2/rust/interop.bzl](../../buck2/rust/interop.bzl); the pinned toolchain lives in [buck2/rust/toolchains.bzl](../../buck2/rust/toolchains.bzl). These rules use the shared [cache_guarded_rule](../../buck2/platforms/defs.bzl) admission wrapper.

Adapter crates used by both wasm and native products declare `default = ["wasm", "napi"]`, keep backend dependencies target-specific, and gate exports by feature and target architecture. Buck consumes one admitted Rust `:lib` provider rather than independently enabling Cargo backend features.

Typed `compileTimeResources` in the Cargo package projection admits `include_str!`/`include_bytes!` resources separately from build-script inputs. Repository paths preserve crate-relative destinations; generated/external labels require an explicit destination. Bytes and mappings participate in freshness, and unsafe or colliding destinations fail admission. TypeScript consumers declare generated product dependencies in their existing package projection:

```ts
typescriptPackage({
  generatedDependencies: {
    'effect-rust-fixture': '//rust/effect-rust-fixtures/service:service',
  },
})
```

`generatedDependencies` supplies declarations and runtime products to typechecking, managed editor publication and package trees; generated products do not carry copied `node_modules`. Consumers import the generated service identity, not a second hand-authored tag.

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

On workerd the runtime Layer is isolate-scoped, reused across requests, never constructed per request. Healthy requests do not retire a generation. Large touched linear memories still require [Cloudflare production memory admission, DQ8](#design-questions). Pressure-hint allocations and retired-bytes budgets have not been selected as defaults; their evaluation belongs to that same production-memory question.

## Host capabilities, ownership, and streams (R10, R12, R13, R15)

```text
Effect capability -> scoped callback -> Rust job -> bounded write/pull -> owned bytes
       interrupt -> abort or settle-only      -> cancelAndJoin -> release
```

| Capability mode | Interrupt behavior                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `abortable`     | Send cancellation to the actual host operation and await its stop acknowledgment                                                |
| `settle-only`   | Await actual job settlement and discard its result; any non-abortable host operation may finish, but cannot touch retired state |

Read/fetch and other host capabilities are explicit typed services. Their adapters run Effects in the operation's scope, not untracked global runtimes. Each declares its cancellation mode. Late settle-only callbacks retain only host completion bookkeeping, not Rust jobs or borrowed views.

`Interop.hostSource(mode, { read, readRange })` supplies Rust `Source::read` and `Source::read_range(path, offset: u64, max_bytes: u32)`. Range offsets cross as exact bigint; `maxBytes` is a positive u32 and oversized responses reject. Empty bytes mean EOF; a short nonempty read does not. The host owns consistency when files change; the bridge does not imply a persistent file handle or snapshot.

`Source::yield_now()` awaits a cancellable host macrotask between CPU chunks. A cancellation-token check or microtask-only yield does not let event-loop cancellation arrive. Cancellation is cooperative, not preemption; synchronous wasm blocks until it reaches a yield. Use an explicit dedicated Worker when main-thread responsiveness is required.

Default inputs are copied or transferred into owned storage before asynchronous/thread work; outputs are copied while producer storage is valid. No wasm-backed view survives a call by default. An opt-in borrowed/scoped path is marked in the Rust crate and generated API, states its invalidation events, and cannot return an escaping view or hold a borrow across callbacks, awaits, threads, or memory growth. Ownership must be corrected in the producer; copying already-freed data in JS is not a repair.

Input Sinks use scoped `write -> acknowledgment -> next pull`, followed by one consuming `finish`; unsuccessful/interrupted use closes once. Output Streams use `next(maxBytes) -> owned bytes | undefined`; only `undefined` means end, and zero-length bytes remain data. The runtime does not prefetch; responses above `maxBytes` fail as `Transport`. No whole-stream collection or unbounded callback queue is hidden in the bridge.

`chunkProfile: 'latency'` uses 64 KiB and `'bulk'` uses 256 KiB. Input views are split without copying. A runtime-wide `byteBudget` defaults to four profile chunks and must hold at least one chunk; concurrent input/output streams backpressure by bytes. Output permits remain held until the next downstream pull or close. Consumer-added buffering is outside that budget. Handle identities include their acquisition generation.

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

#[effect_rust::export(input_stream, returns = "String")]
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

The implemented generic API accepts a fresh lexical `{ api, release }` loader and a generated service factory. This reduced example shows synchronous calls remaining synchronous after asynchronous acquisition:

```ts
import { Context, Effect } from 'effect'
import { Interop } from '@overeng/effect-rust'
import { load } from './generated/content-core/load.ts'

interface Api {
  readonly hash: (bytes: Uint8Array) => string
}
class ContentCore extends Context.Service<
  ContentCore,
  { readonly hash: (bytes: Uint8Array) => Effect.Effect<string> }
>()('ContentCore') {}

const portable = Interop.wasmLayer.browser(ContentCore, {
  load,
  make: (runtime: Interop.Runtime<Api>) => ({
    hash: (bytes) => runtime.callSync((api) => api.hash(bytes)),
  }),
  panicPolicy: 'rebuild',
  chunkProfile: 'latency',
})
```

Production consumers import the generated `Context.Service`, `make<Service>` and Layer statics instead of defining the example tag themselves. `defineStatics(Service, { make, wasm?, native? })` exposes `Service.layerWasm.node/bun/browser/browserWorker/workerd(options)` and `Service.layerNative.node/bun(options)` for advertised loaders. Static declarations do not acquire instances. `browserWorker` fetches an asset inside a browser Worker; `workerd` uses a precompiled Module. The old ambiguous `worker` constructor is removed. Init is confined to Layer acquisition; rebuild failures are defects.

`callSync` enters Rust lazily with interruption/generation checks but without a job, AbortController, callback fiber or per-call tracing span. Promise/job exports retain `runtime.call` and acknowledged cancellation. A synchronous export in an already acquired service can run with `Effect.runSync`; importing a module helper does not select an engine Layer.

Services prepare directional Schema codecs once at construction, including borrowed-only/frame-only services. Construction rejects a second physical Effect copy before entering Rust. Consumers must deduplicate the service/runtime dependency cohort; this guard is not cross-runtime cohort compatibility.

Dedicated isolation uses explicit `workerLayer.browser/node` with request/response/error schemas and an endpoint. `processLayer.node/bun` accepts `{ command, request, response, error, make }`, with an Effect child-process command and an explicit spawner Layer. Processes use newline-delimited strict JSON; Worker/process cancellation acknowledges remote finalizers and quiescence, not receipt of a cancel message. Runtime health, retirement and rebuild never replay failed calls.

### Scoped resources (R10–R12, R15)

```text
caller Scope -> acquire resource in generation G
                    -> FIFO method calls -> close once
generation G trap -> poison siblings/pending work -> reject stale handles
rebuild G+1       -> fresh acquisition only
```

`#[effect_rust::resource]` exports a safe, non-generic inherent impl with `pub fn new(...) -> Self` and synchronous borrowed receiver methods:

```rust
pub struct Counter { value: i32 }
#[effect_rust::resource]
impl Counter {
    pub fn new(value: i32) -> Self { Self { value } }
    pub fn add(&mut self, amount: i32) -> i32 {
        self.value += amount;
        self.value
    }
    pub fn value(&self) -> i32 { self.value }
}
```

The generated `service.counter(value)` has type `Effect.Effect<Counter, never, Scope.Scope>`. Constructors cannot return `Result`; invalid constructor inputs and construction panics are defects. Methods retain their declared expected errors. `close: Effect.Effect<void>` permits early release; Scope exit closes exactly once. One FIFO semaphore serializes every method and close per resource; distinct resources are independent.

Resources use the existing generation registry. A panic poisons siblings and pending work; rebuilding never revives old handles. Healthy close runs Rust Drop. Wasm retirement disables finalizers and discards the instance without claiming destructors ran. Native retirement closes owned resources after guarded unwinding; explicit close/drop failures are defects. Consuming, async, generic, static helper, reserved-close and resource argument/return methods are rejected at macro expansion rather than implying unsupported ownership.

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

The compiler lowers a closed, versioned IR covering structs, records, arrays, literals, discriminated unions, refs/recursion, integer widths, string predicates, presence, and semantic scalars. Admission failures carry source path, unsupported feature and remedy; opaque checks, arbitrary transforms/defaults, unsafe number projections, unsupported regex flags and UTF-16/code-point mismatches fail rather than lose constraints.

Contracts use ordinary Effect Schema nodes and checks, not a parallel `Wire.*` authoring language. A small `EffectRust` module supplies namespaced annotations where validation alone cannot select storage or transport. `ContractJson`, `Borsh` and `Columns` are boundary operations, not schema replacements:

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
  owner: Schema.optional(Schema.String),
  patch: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const json = ContractJson.codec(Deployment)
const decode = Schema.decodeUnknownSync(json)
const encode = Schema.encodeSync(json)
const frame = Borsh.frame(Deployment, { contractId: 0x01020304, version: 1 })
```

Fully bounded `Schema.Int` is admitted directly. The smallest admitted width fitting the interval is inferred; `[EffectRust.width]` optionally pins a compatible wider width. Original bounds remain enforced independently of storage. Naked/unbounded integers reject; bigint bounds must fit the admitted u64/i64 intervals. A width change changes Borsh/column layout and requires a frame version bump. Nested constrained strings require a stable `identifier`.

`Schema.optionalKey(T)` means missing-only; explicit null requires `T` to admit it. `Schema.optional(T)` additionally admits own-undefined at object fields: JSON encoding omits it only for schema-declared optional keys, including nested objects. Required fields, array elements and record values still reject undefined. `Schema.optionalKey(Schema.NullOr(T))` is the raw TypeScript Patch representation; generated Rust retains `Patch<T>` for missing/null/value. No tagged Patch ADT is introduced on the TypeScript or JSON boundary.

### Extension vocabulary and regex

| Namespace                                                                         | Ownership and compatibility                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `https://github.com/overengineeringstudio/effect-utils/vocabulary/effect-rust/v1` | Repository-owned logical vocabulary URI, not a promise of a hosted schema endpoint                                         |
| `x-effect-rust-*`                                                                 | Repository-owned lowercase ASCII JSON Schema keywords; suffix matches `[a-z][a-z0-9-]*`                                    |
| Contract identifiers                                                              | Owner-declared, case-sensitive identifiers unique within the contract set; collisions fail generation                      |
| `effect-rust/*` live annotations                                                  | Repository-owned, case-sensitive string keys exported by `EffectRust`; live metadata is distinct from JSON Schema keywords |

The JSON Schema 2020-12 dialect meta-schema declares the semantic vocabulary as required in `$vocabulary`; generated contract schemas select that dialect with `$schema`. Vocabulary and dialect version URIs end in `/v[1-9][0-9]*`. Unknown required vocabularies, unknown extension keywords, and incompatible major versions fail closed, never silently erase semantics. Extensions carry integer width/representation, millisecond DateTime, brands, and portable pattern flags. Register extensions once in the compiler with both emitters and shared vectors.

`[EffectRust.timestampPrecision]: 'millis'` selects strict timestamp transport, `[EffectRust.excess]: 'ignore'` explicitly opts a struct out of default excess rejection, and `[EffectRust.nonExhaustive]: true` selects Rust evolution policy without permitting unknown runtime tags. An annotation cannot bless opaque predicates or arbitrary transformations.

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

`Compiler.compile(contracts, { crateName, vectors, frames, cargo, schemaMetadata })` is deterministic and in-memory, returning `{ ir, files }`. Files include generated Rust, versioned JSON Schema, generated Effect source and shared vectors. `cargo` discriminates standalone and workspace modes; workspace mode explicitly selects inherited package metadata and workspace dependencies. `schemaMetadata: 'schemars'` emits `JsonSchema` implementations from the admitted IR, not independently derived mirror schemas:

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

| Semantic field     | Generated Rust                                    | Effect type / wire                                       |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| u64/i64            | Width-checked integer/newtype and serde adapters  | Bounded bigint; decimal strings on JSON, bigint direct   |
| DateTime           | `TimestampMillis` enforcing millisecond precision | `DateTime.Utc`; strict RFC3339 JSON, epoch millis direct |
| Missing-only       | `Option<T>` with missing-only codec               | `optionalKey`, rejects explicit null unless T admits it  |
| Required nullable  | `Option<T>` with required-presence codec          | `NullOr`, missing key rejected                           |
| Optional nullable  | `Patch<T> { Absent, Null, Value(T) }`             | Raw `optionalKey(NullOr(T))`: missing / null / value     |
| Constrained string | Named validating newtype                          | Refined or branded string                                |
| Record             | Sorted-key map                                    | Canonical sorted keys on encode                          |

Sub-millisecond DateTime is rejected, not silently truncated. Required-presence and missing-only codecs remain distinct even when both use `Option<T>`. `Patch::Absent` omits the field and must never collapse into `Null`.

Shared vectors assert acceptance, canonical decoded meaning, and encoded meaning on both sides. The compiler emits one Rust `#[test]` per vector and Effect/Vitest vector cases. Scalar extrema, nested paths, recursion, brands, presence, regex constructs, and canonical output belong in admission; object vectors alone do not prove JSON-text parser parity.

## Wire protocols (R03, R04, R12, R14)

```text
one admitted domain schema -> directional codecs prepared at construction
  wasm/native call         -> Direct structured values -> Rust serde visitor
  process/storage boundary -> ContractJson strict JSON -> Rust wire codec
  explicit bulk operation  -> Borsh frames / Columns   -> typed Rust rows
```

### Typed direct in-process transport

Wasm and native generated services use `Direct.codec`/`decode`/`encode` from the same IR, without JSON text or an intermediate `serde_json::Value` tree. u64/i64 remain bigint, timestamps use integral epoch-millisecond numbers within years 0000–9999, bytes remain Uint8Array and containers remain structured values. Bounds, fixed lengths, excess policy, presence and discriminator checks are unchanged. Direct ABI, adapters and generated services advance together; consumers rebuild rather than retain a compatibility path.

Expected errors carry typed `rustError` payloads on Error objects rather than JSON hidden in messages. Generated adapters translate them into their domain TaggedError/reason unions. Unexpected throws and panic envelopes remain defects. Native asynchronous workers carry Rust values; JS handles and result/error encoding stay on their owning JS thread.

Native object-boundary decoding normalizes only finite safe integral doubles to Rust integer values, preserving u32/i32 and authored safe-integer bounds. Fractional/unsafe values still reject at integer fields. This is normalization of natural JavaScript numbers, not permission to accept noncanonical JSON text.

### JSON control plane

On actual JSON boundaries, u64/i64 encode as canonical base-10 decimal strings and decode to bounded bigint in Effect and width-checked Rust values. Unsigned grammar is `0|[1-9][0-9]*`; signed grammar additionally permits `-[1-9][0-9]*`. Fractions, exponents, leading zeros, plus signs, whitespace and negative zero reject before width checks. Bounded safe-number fields remain numeric JSON; inferred or pinned storage is recorded in the IR. JSON remains the process/storage wire even when in-process calls use Direct.

The strict contract JSON profile requires valid UTF-8/Unicode scalar strings, finite schema-admitted numbers, no duplicate keys (including tags) and nesting depth at most **128** (root container counts as one). Integer-field tokens require canonical safe-integral spellings: `1.0` and `1e0` reject. Lexical checks are schema-aware, not a blanket prohibition on fractional/exponent tokens or large integer-spelled finite floats. Unknown fields reject by default; an explicit per-struct `[EffectRust.excess]: 'ignore'` changes only that struct's policy.

`EffectRust.F32` / Rust `#[wire(f32)]` admits finite IEEE binary32, rounds inputs to nearest binary32 and rejects NaN, infinities and overflow. Numeric JSON fractions, exponents and integer-spelled tokens at f32 fields follow this float policy; integer fields stay strict. Canonical JSON emits the shortest ECMAScript representation of the widened binary32 value, equivalent to `JSON.stringify(Math.fround(x))`. Direct/Borsh preserve −0; JSON normalizes it to 0. Borsh stores four little-endian bytes; Columns uses Float32Array.

Decoders accept any object-key order. Tag-first input takes the streaming fast path; otherwise a buffered fallback locates the discriminator before variant decoding. Encoders emit the discriminator **first**, then sorted remaining keys. Unknown/duplicate tags reject in both paths. Rust-owned wire retains its tag key and maps it to the Effect reason discriminator. Canonical ordering is interop-specific, not JCS and not the domain's content-address encoding policy. The requested tag-order friction bakeoff is resolved, not an open requirement.

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
const Sample = Schema.Struct({
  id: Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n })),
  delta: Schema.BigInt.check(
    Schema.isBetweenBigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n }),
  ),
})
const SampleFrame = Borsh.frame(Sample, { contractId: 1, version: 1 })
const columns = Columns.make(Sample)
// Schema-validated by default; SampleFrame.trusted is explicit.
```

Trusted opt-in skips redundant Schema traversal only; mandatory envelope, lengths, widths/ranges, UTF-8, and ownership checks remain. Compiler-emitted codecs reject malformed counts before allocation and never modulo-wrap out-of-range integers. Borsh's four-byte offsets do not authorize borrowed eight-byte typed-array views. The [X evidence](./.experiments/x-binary-bulk.md) treats overlapping fixed-width timings as a tie class and measures Schema validation overhead; it is not a universal performance bound.

## Consumer pilots (R01–R16)

| Consumer                                                  | Boundary exercised                                                                | Recorded result                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Content-address byte engine](../content-address/spec.md) | Effect-owned descriptors, direct Rust reuse, streams, host callbacks, wasm/native | #1602: 35 parity cases per Node/Bun runtime, zero disagreements; JavaScript remains default           |
| internal app pilot A (image/byte processing)              | Producer ownership, packaging, shared aggregate dependencies                      | Aggregate wasm 34–37% smaller; faster warm init; inline first init 342 vs external 85 ms in Chromium  |
| internal app pilot B (stateful matcher)                   | Rust-owned contracts, stateful lifetime and teardown                              | 41/41 parity; 10k create/drop with zero leaks; generated boundary 3.2–5.4× slower than raw before q53 |

The [pilot A record](./.experiments/pilot-a-image-byte-processing.md) and [pilot B record](./.experiments/pilot-b-stateful-matcher.md) preserve the anonymized historical observations. [The q53 before/after benchmark](./.experiments/q53-direct-transport.md) measures the later real service product with an unchanged harness; shared-host load limits absolute claims, and native-byte cells establish neither improvement nor regression. [Annotation-first](./.experiments/wa-annotation-first.md) and [tag-order friction](./.experiments/t-tag-order-friction.md) record the evidence behind the corresponding cutovers.

The foundation does not take ownership of content-address canonical JSON, pins, publication, stores, or resolver policies. DOM-specific image facades do not become Node/Workers capabilities by virtue of portable bytes.

## Design Questions

- **DQ6 Neutral IDL:** Can a language-neutral owner match Effect Schema expressiveness and idiomatic runtime codegen? [#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547) remains parked; it does not block single-owner contracts.
- **DQ8 Cloudflare production memory:** What resident peaks, memory-limit enforcement, recycling and repeated large-linear-memory recovery occur on actual Cloudflare? Local workerd is insufficient. Evaluate proposed pressure hints or budgets against production peaks, residue, latency and availability before selecting them.
- **DQ10 Cross-runtime Effect cohort:** Can service/runtime identity remain sound across physical Effect copies, release cohorts or runtime boundaries? Current generated construction rejects a second physical copy; broader compatibility needs explicit upstream guidance and multi-runtime proof.
- **DQ11 Upstream asks:** Which downstream compensations can use stable public Effect APIs? [Effect-TS/effect#8690](https://github.com/Effect-TS/effect/issues/8690) awaits feedback on canonical bigint/timestamps, per-schema excess policy, JSON Schema fidelity/import hooks, optional omission, public AST rebuilding and involvement. Repros there ran on Effect 4.0.0; that does not imply the foundation's pinned RC has changed.
