# Experiment: I — Delivery tiers

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

Which delivery boundary provides portable execution and where do native or subprocess costs justify distinct tiers?

## Hypothesis

A single Rust byte core can serve Rust and Effect through portable, native, and subprocess boundaries.

## Method

Expose SHA-256, incremental hashing, tree digest, and descriptor round-trip through wasm-bindgen, Node-API, a WASI Component, and JSON/stdio CLI. Swap Effect Layers while preserving the service shape. Allocate 1 MB/100 MB buffers before timing; tiny calls include conversion/await, not isolated ABI overhead. Fresh initialization excludes process launch and shared imports.

## Result

| Mechanism                 | Observed 100 MB throughput     | Tiny call        | Fresh init       | Artifact bytes                           |
| ------------------------- | ------------------------------ | ---------------- | ---------------- | ---------------------------------------- |
| wasm-bindgen Node / Bun   | 360 ± 14 / 183 ± 25 MB/s       | 1.14 / 1.18 µs   | 2.07 / 3.94 ms   | 143,613 wasm                             |
| Node-API Node / Bun       | 2,265 ± 166 / 2,167 ± 242 MB/s | 0.61 / 1.26 µs   | 0.60 / 0.53 ms   | 789,176 unstripped addon                 |
| WASI Component Node / Bun | 316 ± 37 / 200 ± 23 MB/s       | 6.83 / 3.31 µs   | 20.67 / 17.25 ms | 199,535 component; 230,219 transpiled JS |
| JSON CLI Node / Bun       | 15 ± 1 / 22 ± 1 MB/s           | 34.99 / 25.13 µs | 6.80 / 7.37 ms   | 695,592 unstripped executable            |

Throughput is decimal MB/s; uncertainty shown is sample SD. Node WebCrypto reached 1,164 ± 31 MB/s and Bun CryptoHasher 2,215 ± 161 MB/s at 100 MB. Web-target fresh initialization in Node was 18.99 ± 2.15 ms, distinct from the Node glue row.

wasm-bindgen and Component known-digest/stream/descriptor probes executed in Node, Bun, Chromium, and local Workers with precompiled Modules. Native/CLI ran on x86_64 Linux desktop. Desktop tree traversal used host capabilities/native filesystem; browser/Workers tree requests were rejected. One-minute load during buffer measurements was 79.07–126.67.

## Conclusion

One shared Rust core ran through each tested boundary, with materially different delivery and transport costs.

## Intent Impact

Wasm-bindgen is the portable default; a native addon needs a richer measured hot path than merely replacing runtime crypto. CLI JSON byte throughput is a transport result, not native hashing speed. Component cost did not buy a required-runtime advantage.

## Limits

No ARM/Darwin execution in this experiment; later packaging probes own those native results. No production Workers deployment, standalone Effect interpreter-overhead estimate, or completed Buck integration.

## Related decision

[Tiered delivery decision](../.decisions/0001-tiered-delivery.md).

## Amendment 1

The supplied later public byte-engine pilot exercised generated wasm/native services on Node/Bun, preserving byte, descriptor, tree, store, cancellation, and finalizer behavior. Its initial scratch report could not pass complete Buck analysis because watcher startup timed out; direct builds were not a Buck pass. [PR #1602](https://github.com/overengineeringstudio/effect-utils/pull/1602) later reports real Buck parity/service smokes: 35 cases per runtime, zero disagreements, 181/181 freshly generated vectors on each language side, and a successful Buck quick aggregate. Outer check:quick still exited 1 for the two disclosed [#1564](https://github.com/overengineeringstudio/effect-utils/issues/1564) Nix failures. See [watcher measurements](./buck-watcher-startup.md). Earlier overloaded scratch throughput is not a controlled default-engine speedup; JS remains the default and Rust opt-in. #1602 was open, not merged, when consulted.
