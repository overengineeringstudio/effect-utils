# Requirements: Effect–Rust interop foundation

## Context

Builds on [vision.md](./vision.md). The first domain consumer is the [content-address system](../content-address/spec.md); its descriptors, stores, canonical encoding, and resolver policies remain outside this foundation. Implementation admission is tracked in [effect-utils#1549](https://github.com/overengineeringstudio/effect-utils/issues/1549).

## Assumptions

- **A01 Shared engines:** Domain engines need direct Rust consumption and Effect consumption without separately maintained algorithms.
- **A02 Runtime set:** Supported execution surfaces are Node, Bun, browsers exercised in Chromium, and Cloudflare Workers.
- **A03 Build ownership:** Buck produces Rust artifacts; Nix distributes native products. An application declares the engines and deployment groups it uses.

## Acceptable Tradeoffs

- **T01 Portable baseline:** A portable boundary may be slower than a native hot path; native delivery needs measured product justification.
- **T02 Owned data:** Safe ownership may require copying. Explicit scoped alternatives are acceptable where measurements justify them.
- **T03 Host cancellation:** Non-abortable host operations may settle after interruption if their declared mode is honest and Rust no longer depends on their result.
- **T04 Application packaging:** Inline delivery may increase JS bytes and prevent independent artifact caching. Applications may choose deliberate alternative delivery contracts.

## Requirements

### Must preserve domain contracts

- **R01 Shared core:** One Rust core serves direct Rust callers and every selected Effect delivery tier without algorithm forks.
- **R02 Single authority:** Each contract names exactly one authoring owner; the other language's types and runtime codecs are generated, never hand mirrored.
- **R03 Semantic equivalence:** Both sides execute shared accept/reject and semantic round-trip vectors covering optionality, excess fields, bounds, unions, DateTime, brands, and integer widths. Unsupported semantics fail generation rather than silently weakening validation.
- **R04 Full-width integers:** Transport preserves every u64 and i64 value on every supported runtime. Throughput ranks after losslessness; readability and bundle size rank after throughput.

### Must make delivery explicit

- **R05 Explicit tiers:** Consumers explicitly select portable, measured desktop-native, or coarse subprocess delivery. Initialization or operation failure never triggers automatic tier fallback.
- **R06 Runtime admission:** Portable packages pass known-digest execution in Node, Bun direct and bundled execution, Vite development and production in Chromium, direct Chromium ESM, and Workers; bundling or dry-run alone is insufficient.
- **R07 Native admission:** Native products are admitted only for supported desktop runtimes using native platform builders and Nix distribution; no cross-build or portable public npm-prebuild claim substitutes for runtime proof.
- **R08 Composable artifacts:** Applications select eager and named lazy groups. Each group shares one scoped runtime across its engines; unused engines and groups are not loaded eagerly.
- **R09 Reproducible production:** Build products are derived from the application manifest and pinned tools/features; optimized artifacts pass runtime smoke. Product-specific profile overrides remain explicit.

### Must define lifetime and failure boundaries

- **R10 Cancellation completion:** Rust jobs and handles are quiesced and released before Effect interruption completes. Host capabilities declare abortable or settle-only behavior.
- **R11 Panic containment:** A trap or panic settles every affected pending Effect as a defect, prevents subsequent use of poisoned state, and creates a fresh usable scope under the configured recovery policy. Native admission rejects abort builds and uncovered panic boundaries.
- **R12 Owned boundary:** Returned data remains valid after producer release and memory growth by default. Borrowed alternatives are marked in the Rust contract and cannot escape their valid scope or cross an unowned async/thread boundary.
- **R13 Bounded streams:** Input and output streams have configurable latency/bulk chunk profiles, bounded in-flight bytes, backpressure, distinct end-of-stream, and exactly-once handle release on all exits.
- **R14 Failure fidelity:** Expected foundation failures distinguish Init, Transport, Input, and Unsupported; domain failures retain their generated contract. Panics and invariant violations remain defects with original cause and operation context.
- **R15 Concurrent isolation:** Jobs and handles cannot alias across instances or generations. Concurrent work is bounded and cannot deadlock by retaining a Rust borrow or lock across a host callback.
- **R16 Reclamation evidence:** Recovery admission includes repeated poisoned-instance rebuilds and memory measurements that distinguish live Rust allocations, wasm linear memory, host heap, and native state. Healthy cancellation counts alone do not prove recovery reclamation.
