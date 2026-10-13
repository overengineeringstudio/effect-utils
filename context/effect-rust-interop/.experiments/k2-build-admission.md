# Experiment K2: Buck product and runtime admission

## Question

Do generated Buck products load their intended runtime entry and execute on each native platform builder?

## Hypothesis

Buck wasm-bindgen, native Node-API, and eager/lazy aggregator products can execute their installed artifact on native Linux and Darwin builders with runtime-specific export resolution.

## Method

[PR #1556](https://github.com/overengineeringstudio/effect-utils/pull/1556), evidence head `e651d71b9`, ran six Buck smokes per platform: wasm, napi, and app products × Node/Bun. Each checked its own export condition. Out-of-tree workerd and Vite/Chromium harnesses executed known results with negative controls for missing workerd exports and a reinserted unused bindgen URL. Lazy-group proof checked one wasm per group and no export crossing. The head was ready for review at evidence handoff, not asserted merged.

## Result

| Platform       | Build                   | Six desktop smokes | Local workerd / Vite | Native artifact                          |
| -------------- | ----------------------- | ------------------ | -------------------- | ---------------------------------------- |
| x86_64-linux   | Pass                    | All pass           | Pass                 | ELF                                      |
| aarch64-linux  | Exit 0                  | All pass           | Pass                 | 1,118,720-byte ELF                       |
| aarch64-darwin | Exit 0 after linker fix | All pass           | Pass                 | 949,104-byte arm64 Mach-O, ad-hoc signed |

Before → after:

- Bun matched `node` and loaded CJS glue → `bun` precedes `node`, and the smoke confirms Bun's own condition.
- Darwin rejected undefined `_napi_*` symbols → macOS Node-API libraries use `-Clink-arg=-Wl,-undefined,dynamic_lookup`, then all runtime smokes pass.
- Symlinked aggregator entry resolved group imports against its real source path → copied output is relocatable for the exercised groups.

The eager wasm was 25,882 bytes; lazy wasm 1,025 bytes (662 gzip). Wasm sizes matched across native builders, but bytes differed (16 lazy / 337 adapter bytes); build metadata was suspected, not confirmed.

Three corrected scoped test files recorded 55 passes. The final quick-check report had two pre-existing failures: ambient OpenSSL unavailable to a product-import check, and a bridge fixture declaring a Rust workspace root without Cargo.toml. [#1564](https://github.com/overengineeringstudio/effect-utils/issues/1564) tracks them and a signing-sensitive telemetry test. This record does not call that quick check clean.

## Conclusion

Amend [packaging decision 0005](../.decisions/0005-runtime-packaging.md) with Bun-before-Node and Darwin dynamic lookup. Product rules and platform smoke are exercised; fully integrated browser/workerd Buck capability gates remain [#1566](https://github.com/overengineeringstudio/effect-utils/issues/1566).

## Intent Impact

Refines packaging and build realization without reopening application composition or claiming fully integrated runtime capabilities.

## Limits

This is historical K2 proof, not a fresh run of #1556 by this VRS update. Workerd/browser harnesses were out of tree because the required platform capabilities were not admitted to Buck. Local workerd execution is not production Cloudflare memory admission. Native products remain Nix-distributed, not public npm prebuilds. Same wasm size does not prove reproducible bytes; the byte differences above remain unresolved product evidence, not a reason to reopen the decided build architecture.

## Specification

[Runtime packaging and admission](../spec.md#runtime-packaging-and-admission-r06-r07-r09).

## Amendment 1

The K2 head and size/byte observations above are retained as historical evidence. [PR #1556](https://github.com/overengineeringstudio/effect-utils/pull/1556) now records a later rebased product head; [#1602](https://github.com/overengineeringstudio/effect-utils/pull/1602) includes its head-specific fixture gate, exit 0 with 326 local actions and six Node/Bun smoke receipts. [#1604](https://github.com/overengineeringstudio/effect-utils/pull/1604) separately changes the browser default from inline to external assets. [Fresh watcher measurements](./buck-watcher-startup.md) distinguish successful fixed-source gates under restored temporary overrides from resolved daemon-startup/invalidation behavior. All three PRs were open when consulted; the outer quick-check baseline failures remain visible.
