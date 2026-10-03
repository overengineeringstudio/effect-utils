# Experiment: E1 — Application composition

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

How does application-level aggregation compare with independently packaged engines for bytes, initialization, and memory?

## Hypothesis

Linking selected cores into one generated application wasm reduces per-engine artifact and memory costs without changing service composition.

## Method

Compare three separate cores (hashing, canonical JSON, fuzzy distance), handwritten combined and manifest-generated combined crates, plus a two-core selection. Exercise Node, Bun, Vite production in Chromium, and local Workers. Compare release and tuned profiles, sizes, initialization, stress linear memory, and shared versus independent Effect Layers.

## Result

| Tuned + wasm-opt -Oz strategy | Raw bytes | Brotli bytes | Initial linear memory | Stress high-water |
| ----------------------------- | --------- | ------------ | --------------------- | ----------------- |
| Three separate modules        | 78,678    | 32,513       | 3,342,336 B           | 19,398,656 B      |
| Combined/generated            | 50,940    | 21,307       | 1,114,112 B           | 12,779,520 B      |

Uncached Chromium/Vite initialization: combined 9.22 ± 0.89 ms versus separate 15.03 ± 1.13 ms (15 samples after 2 warmups). Combined release baseline was 102,939 raw / 37,042 brotli bytes; the tuned optimized result was −50.5% raw / −42.5% brotli. The measured tuned profile used opt-level s, fat LTO, codegen-units=1, strip, and abort; abort did not change wasm bytes. This does not authorize native abort builds.

Generated and handwritten tuned modules were byte-identical. Shared Layers loaded/released once (1/1), independent Layers three times (3/3). A lazy Chromium group fetched no core until its service was requested. `wasm-opt -Oz --all-features` produced a module Node rejected with `unknown import kind 0x7f`; pinned runtime-compatible features restored loading. One-minute host load ranged approximately 67–330 across the session.

## Conclusion

The generated combined artifact reduced bytes and linear-memory high-water in the tested workload while preserving results.

## Intent Impact

Use one generated wasm per application bundle group and share its runtime Layer. Link-time selection controls shipped cores; bundler tree-shaking cannot remove exports from a prebuilt wasm. Use a pinned size profile and runtime smoke, with explicit product overrides.

## Limits

Linear-memory high-water is not whole-process/host-heap memory. Browser used local HTTP, understating real-network costs. Only x86_64 Linux was exercised; generation used experimental glue rewriting, not a production instance factory or Buck rule. The measured profile included codegen-units=1; the accepted default need not mandate it.

## Related decision

[Aggregator decision](../.decisions/0003-composition-via-aggregator.md).
