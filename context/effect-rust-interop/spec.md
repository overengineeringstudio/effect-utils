# Spec: Effect–Rust interop foundation

This document specifies the reusable Effect–Rust boundary. It builds on [requirements.md](./requirements.md).

## Status

Draft. This is the target contract, not a claim that the foundation or Buck integration is implemented. The [experiment records](./.experiments/i-delivery.md) distinguish exercised prototypes from admission obligations.

## Scope

**Defines:** delivery constructors, packaging, generated composition, lifecycle, stream and host-capability boundaries, schema generation, and artifact admission.

**Does not define:** domain algorithms, application policy, content-address store/resolver behavior, a neutral IDL, public native npm distribution, or platform support beyond the admitted matrix.

The home is effect-utils: a TypeScript package and a Rust companion crate under the repository's `rust/` workspace. The package name is [DQ1](#design-questions).

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

Conditional exports select a wasm packaging adapter, not a delivery tier. The `workerd` condition precedes generic browser/default conditions. Inline web glue omits the unused default module path so bundlers do not emit a second wasm artifact. Workers never compile arbitrary bytes at request time. Browser compilation still depends on the application's CSP.

Applications may select other legitimate source/delivery options when their asset, caching, isolation, or bundler preferences require them; each option has an explicit constructor/source contract and the same applicable admission smoke. URL delivery owns asset deployment and content type. Native products use native builders for each OS/architecture, not cross builds, and remain Nix-fleet products rather than portable public npm prebuilds.

Admission executes the known SHA-256 digest of `abc` using the emitted and installed artifacts: Node, Bun direct, Bun build plus execution, Vite dev/prod in Chromium, direct Chromium ESM by file URL over HTTP, and Workers requests. Vite success, Wrangler dry-run, a source-tree-coupled bundle, or a native link step alone is not a runtime pass. Release gates also exercise schema vectors and lifecycle failures below. Local workerd evidence is not production Cloudflare evidence.

## Application composition and build profile (R08, R09)

```text
app manifest -> Buck generator -> aggregator crate + TS adapters -> wasm + bindgen products
                           eager group -> shared WasmRuntime -> per-core Layers
                       named lazy group -> separate scoped WasmRuntime when requested
```

Each application manifest names core dependencies and assigns them to one eager group or named lazy groups. Buck generates one aggregator crate and one wasm product per group; generated crates are build outputs, not committed sources. Linking deduplicates shared dependencies within a group. Cross-group duplication is an explicit cost of lazy loading. A shared `WasmRuntime` Layer supplies the group instance to its per-core Layers. Laziness does not create CPU parallelism on a single JS thread.

Illustrative manifest shape (build API, not a deployed wire protocol):

```json
{
  "groups": {
    "eager": { "cores": ["content-address"] },
    "image-tools": { "cores": ["image-utilities", "color-extraction"] }
  }
}
```

Group/core names are application-local, case-sensitive manifest keys. `eager` is reserved for the immediate group; other names match `[a-z][a-z0-9-]*`, are unique within the manifest, and resolve to exactly one declared core/group. Unknown dependencies, duplicates, or conflicting assignments fail generation. They are not public service identifiers or package names.

The fleet-wide wasm size profile uses `opt-level=s`, fat LTO, symbol stripping, and pinned `wasm-opt -Oz` feature flags. It does not mandate `codegen-units=1`. Products may override the profile explicitly with their measured tradeoff and runtime smoke. Native builds retain unwind; wasm profile settings do not authorize native abort builds. Pin the Rust target/toolchain, bindgen crate and matching generator, Binaryen, and enabled wasm features. Never enable all Binaryen features opportunistically: an optimized output must still load in every admitted runtime.

Buck owns the wasm32 product, generator action, artifact manifest, shared-library products, and application aggregator generation; Nix distributes their outputs. Required rule integration is [DQ5](#design-questions), not an existing API claim.

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
6. The default policy rebuilds a fresh instance scope for subsequent calls. Never retry or replay failed operations. If fresh initialization fails, report Init and leave the scope unavailable. Healthy closing runs non-panicking release exactly once.

The foundation, not application-wide unhandled-exception hooks, owns the generated scheduler trap observer and registry. Recovery policy is configurable (including retirement without rebuild); its solid default is poison, settle, retire, rebuild. Configuration cannot waive native admission or advertise pending-Promise rejection as quiescence.

Native exports require unwind builds and generated catches around synchronous exports, each future poll, CPU compute, and cleanup boundaries. `panic=abort` artifacts or uncovered boundaries are rejected. Recreating a native Layer creates a new context, not addon unload. Use subprocess delivery where a process crash must be contained; a JS worker is not a native process crash boundary.

Repeated panic/rebuild tests must establish memory reclamation before leak-free recovery is claimed ([DQ4](#design-questions)). The healthy-cancellation experiment is insufficient for this gate.

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
| Init                        | Expected failure | Acquisition, artifact identity, or initialization failed                                 |
| Transport                   | Expected failure | Host/process/ABI communication failed                                                    |
| Input                       | Expected failure | Generated input codec or declared boundary limits reject input                           |
| Unsupported                 | Expected failure | Chosen runtime/tier lacks a requested capability                                         |
| Generated domain error      | Expected failure | Domain-owned `Result::Err`, not relabeled as infrastructure failure                      |
| Panic / invariant violation | Defect           | Unexpected Rust/host invariant failure; retain cause, build, instance, operation context |

Conceptual API shape, with product-specific types generated from the owner contract:

```ts
interface ChunkPolicy {
  readonly maxChunkBytes: number
  readonly maxSourceChunkBytes: number
  readonly inFlightBytes: number
}

interface ContentCoreApi {
  readonly hash: (bytes: Uint8Array) => Effect.Effect<ContentDigest, CoreFailure>
  readonly hashStream: (
    chunks: Stream.Stream<Uint8Array>,
    policy?: ChunkPolicy,
  ) => Effect.Effect<ContentDigest, CoreFailure>
}

// Explicit runtime and backend; Service and contract are product-owned.
const portable = Interop.wasmLayer.browser(ContentCore, {
  source: inlineArtifact,
  factory: generatedInstanceFactory,
  make: makeContentCoreApi,
  chunkProfile: 'latency',
  panicPolicy: 'rebuild',
})
const desktop = Interop.nativeLayer.node(ContentCore, {
  load: admittedNativeProduct,
  make: makeContentCoreApi,
})
const hostState = Interop.processLayer.node(HostTreeCore, {
  command: admittedProcessProduct,
  requestSchema: generatedRequestSchema,
  responseSchema: generatedResponseSchema,
  make: makeHostTreeApi,
})
```

`wasmLayer` acquires the group's scoped `WasmRuntime`; `make` constructs the product service from generated bindings. `inputStream`, `outputStream`, `invokeAsync`, and `cancelAndJoin` implement the preceding protocols. `health`, `retire`, and `rebuildLayer` expose lifecycle without silently retrying. Diagnostics distinguish instance-local handles/futures, process-wide native tasks, byte budgets, and poison causes.

| Rust companion primitive            | Generated responsibility                                                    |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Contract export helper              | Owner schema/error export and contract identity                             |
| Incremental input/output adapters   | Generational handles, limits, finish/end/close, healthy RAII release        |
| Cancellable job                     | Owned future/task, cancellation token, completion/retirement acknowledgment |
| Host callback adapters              | wasm Promise/native callback conversion outside the portable core           |
| Panic adapters and instance factory | Unwind containment and module-local trap observation; no global singleton   |
| Borrowed-path marker                | Scope constraints and explicit generated alternative API                    |

## Schema ownership and semantic codecs (R02–R04, R14)

```text
Rust owner: serde -> schemars -> JSON Schema + semantic metadata -> Effect 4 compiler -> Effect Schema
Effect owner: Effect Schema -> JSON Schema + semantic metadata -> Typify + validation -> Rust codecs
                                      shared vectors -> both suites
```

Each contract names its owner and generates the opposite language's executable runtime codecs and types. The baseline is pinned Typify plus JSON Schema validation for Rust, and the Effect 4 native schema compiler for Effect. The generator bakeoff in [DQ2](#design-questions) may replace this stack, including a custom compiler if existing tools fall short. Types-only TS generation and serde machine types alone are not sufficient runtime validation.

Owner metadata carries semantic extensions for DateTime, u64/i64, and brands through custom keywords; codecs implement those meanings on both sides. The exact extension dialect belongs to DQ2, not an invented stable namespace here. Generation must diagnose omitted predicates, unsupported flags/transforms, optional/null mismatches, string-length units, excess-field policy, and unsafe integer projections rather than silently accepting a weaker contract.

Shared vectors specify accept/reject and canonical decoded/encoded meaning, not merely JSON parse success. DateTime normalization, brand predicates, missing versus null, nested bounds, and integer extrema are exercised on both sides. Input validation and output encoding share the owner's semantics; no hand-written mirrored validators.

Full u64/i64 transport is unresolved ([DQ3](#design-questions)). Compare decimal strings with bigint codecs, lossless JSON parsing, binary wire, and annotated mixtures on every runtime. Safe-number-only transport is ineligible as the general solution. Binary data remains binary; a control-plane schema does not require byte payloads to pass through JSON.

## Consumer pilots (R01–R16)

| Order | Consumer                                                                                                                   | Boundary exercised                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1     | [Content-address byte engine](../content-address/spec.md)                                                                  | Effect-owned descriptors, direct Rust reuse, portable/native tiers, streaming |
| 2     | Existing first-party wasm bindings (image utilities, color extraction, fuzzy matching): image utilities + color extraction | Producer ownership, packaging, shared aggregator dependencies                 |
| 3     | Existing first-party wasm bindings (image utilities, color extraction, fuzzy matching): fuzzy matching                     | Rust-owned contract, stateful handles and scoped teardown                     |

The foundation does not take ownership of content-address canonical JSON, pins, publication, stores, or resolver policies. DOM-specific image facades do not become Node/Workers capabilities by virtue of portable bytes.

## Design Questions

- **DQ1 Package identity:** What is the TypeScript package and companion crate name? Resolve before publishing imports; names in API sketches are not package commitments.
- **DQ2 Generator stack and extension dialect:** Which state-of-the-art generators preserve the required semantics and diagnostics? Resolve with bidirectional generation, semantic-extension codecs, deterministic output, and zero shared-vector disagreements; replace the baseline or build a compiler if necessary.
- **DQ3 Integer transport:** Which full-range u64/i64 wire representation wins? Resolve losslessness on every runtime first, then encode/decode throughput, then readability and bundle size.
- **DQ4 Poisoned-instance reclamation:** Does repeated trap retirement/rebuild reclaim Rust state, wasm memories, host references, and native context state? Resolve with whole-heap/high-water measurements and repeated lifecycle proof, not healthy cancellation alone.
- **DQ5 Buck product integration:** How are the wasm32 target, matching bindgen action, aggregator action, and shared-library products admitted into the build graph? Resolve with pinned reproducible products and the complete runtime matrix; experimental integration estimate is 8–15 engineer-days, not measured work duration.
- **DQ6 Neutral IDL:** Can a neutral owner offer Effect-Schema-level expressiveness and excellent codegen? Research is separate in [effect-utils#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547); it does not block per-owner contracts.
