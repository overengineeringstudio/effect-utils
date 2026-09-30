# Experiment: E4 — Runtime packaging and native products

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

Which package layout executes correctly across runtimes and which native platform portability claims are supported?

## Hypothesis

One conditional-export wasm package can run across the required runtimes without consumer-specific wasm glue; native delivery has separate platform obligations.

## Method

Compare generated bindgen targets, inline bytes, URL/query loaders, and compiled Module imports. Execute known digests in Node, Bun direct and built outputs, Vite dev/prod in Chromium, direct browser ESM, and local Workers. Pack/install the candidate package. Separately build and execute native products on three platforms.

## Result

| Candidate                                                               | Observed result                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Conditional root: Node CJS, Bun/browser inline, Workers compiled Module | Known digest passed in Node, Bun direct/built, Vite dev/prod, Chromium direct ESM, and local Workers |
| Raw web URL loading                                                     | Node file-fetch failed; Bun emitted bundle missed its wasm sibling                                   |
| Raw bundler target                                                      | Vite passed; Bun failed start-export glue; browser direct wasm ESM import failed                     |
| Inline bytes in Workers                                                 | Build/dry-run succeeded; local request failed: code generation disallowed by embedder                |
| Node glue bundled by Bun                                                | Executed only with retained source-directory coupling; not a relocatability pass                     |

Installed-tarball Node/Bun runtime and Bun emitted-output smokes passed; Vite production build and Workers dry-run passed. The browser-executed matrix covered the source package, not an installed-tarball browser runtime proof.

Artifact sizes: wasm 143,613 B (gzip 59,357); inline loader including base64 191,706 B (gzip 76,702); clean Vite JS 196,875 B (gzip 79,230); x64 addon 789,176 B (gzip 327,684). Omitting bindgen's unused default module path removed accidental duplicate wasm emission.

Native builds and known-digest runs passed on x86_64-linux, aarch64-linux, and aarch64-darwin using native platform builds. Linux binaries retained Nix-store runtime library references and an observed GLIBC_2.34 symbol requirement; Darwin retained a Nix libiconv dependency. ARM Linux cross evaluation planned dependencies but produced no artifact within a 900-second experimental limit; Darwin cross evaluation rejected unavailable tooling. Buck wasm32/bindgen/shared-library integration was estimated at 8–15 engineer-days, not implemented or timed.

## Conclusion

The conditional package executed across the tested portable matrix; successful native runs did not prove public binary portability.

## Intent Impact

Select packaging statically with conditional exports, not automatic backend fallback. Inline defaults buy consumer simplicity; URL/streaming remains explicit. Workers require precompiled Modules. Keep native delivery Nix-fleet-only on native builders until product portability obligations justify otherwise.

## Limits

No production Workers deployment, clean non-Nix portability proof, minimum-OS certificate, Windows/musl/Deno execution, or hermetic three-platform Buck/Nix build matrix. Native Darwin success required explicit linker setup. Timeouts do not establish architecture impossibility or expected build duration. No startup/throughput comparison was taken in this experiment.

## Related decision

[Packaging decision](../.decisions/0005-runtime-packaging.md).
