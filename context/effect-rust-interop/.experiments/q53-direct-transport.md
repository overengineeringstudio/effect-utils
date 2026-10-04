# Experiment q53: Typed-direct before/after boundary benchmark

Non-normative evidence reported by [PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610), open when consulted. These are built-product measurements, not a merged implementation or a fresh benchmark run by this documentation refresh.

## Question

How much avoidable boundary work can typed-direct transport remove on the same generated-product harness?

## Hypothesis

Typed in-process transport, construction-time directional codecs, and a synchronous runtime entry can remove avoidable conversion/scheduling work without weakening domain validation, typed errors, interruption, panic poisoning, or scoped ownership.

## Method

Compare baseline `5e23db087676d4ddb32bd1ca8b94e9877dcba8fd` (#1605) with after source `6e8118e8b`, using the actual Buck-generated fixture service and compiled runtime with one physical Effect cohort. Node 24.20.0 and Bun 1.4.2 exercise wasm and native: 20,000 iterations, 2,000 warmup calls, seven alternating raw/generated samples per workload. Quote, digest, frame sum, and typed-error assertions execute before timing. Runner and harness are checksum-identical before/after:

- Harness SHA-256: `c9bcee04f888e2d55de4df7f68f48a91a0799fe913e647f5dee1399531451d52`.
- Runner SHA-256: `f7f194681198bd060f88620526474d08a2e78a2a3dff02bbc080340773dcfb2f`.

Raw adapters already returned JavaScript values before the change; this is not a JSON-text success-path baseline. After removes intermediate JSON-value representation/conversions, hoists directional codec construction, and uses `callSync` for synchronous exports. Canonical JSON remains a separate wire boundary.

## Result

All 20 cells below are median nanoseconds per call. After/before compares generated medians; raw medians are both shown because adapter representation also changed.

| Runtime | Tier | Workload | Raw before → after (ns) | Generated before (ns) | Generated after (ns) | After/before |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Node | wasm | primitive | 58 → 58 | 4,020 | 431 | 0.107× |
| Node | wasm | domain | 8,251 → 9,840 | 34,334 | 18,939 | 0.552× |
| Node | wasm | expected-error | 4,830 → 5,753 | 22,828 | 15,360 | 0.673× |
| Node | wasm | bytes-1KiB | 3,395 → 3,651 | 7,531 | 4,304 | 0.571× |
| Node | wasm | frame-256rows | 1,978 → 1,951 | 6,121 | 2,433 | 0.398× |
| Node | native | primitive | 338 → 345 | 4,445 | 943 | 0.212× |
| Node | native | domain | 17,693 → 14,800 | 68,859 | 26,112 | 0.379× |
| Node | native | expected-error | 7,999 → 10,653 | 29,496 | 25,319 | 0.858× |
| Node | native | bytes-1KiB | 23,397 → 28,880 | 27,739 | 28,670 | 1.034× |
| Node | native | frame-256rows | 11,762 → 12,937 | 15,643 | 14,515 | 0.928× |
| Bun | wasm | primitive | 62 → 80 | 3,067 | 412 | 0.134× |
| Bun | wasm | domain | 8,952 → 9,254 | 28,937 | 16,832 | 0.582× |
| Bun | wasm | expected-error | 1,554 → 2,536 | 11,221 | 6,561 | 0.585× |
| Bun | wasm | bytes-1KiB | 5,060 → 5,386 | 8,406 | 5,886 | 0.700× |
| Bun | wasm | frame-256rows | 1,133 → 1,143 | 4,995 | 1,474 | 0.295× |
| Bun | native | primitive | 308 → 327 | 3,695 | 806 | 0.218× |
| Bun | native | domain | 16,488 → 13,110 | 54,361 | 24,182 | 0.445× |
| Bun | native | expected-error | 3,577 → 5,677 | 14,222 | 10,159 | 0.714× |
| Bun | native | bytes-1KiB | 23,629 → 27,411 | 28,093 | 28,305 | 1.008× |
| Bun | native | frame-256rows | 11,684 → 12,615 | 15,870 | 14,536 | 0.916× |

Before, domain generated/raw overhead was 3.23–4.16× wasm and 3.30–3.89× native. Generated primitive cost fell from 3,067–4,445 ns to 412–943 ns. Generated domain medians improved by roughly 1.7–2.6× in these runs; generated cost is not raw-call cost.

A separate Node CPU profile includes raw and generated calls, both tiers, warmup and setup. Effect runtime/Schema sampled self time fell from 12,682 ms (29.67%) to 5,495 ms (16.21%); JSON/timestamp boundary from 2,056 ms (4.81%) to 3 ms (0.01%); generated service from 766 ms (1.79%) to 143 ms (0.42%). Native addon callsites remained opaque and dominant: 19,607 ms (45.87%) before and 18,825 ms (55.54%) after. This is consistent with the removed work, not generated-only attribution or Rust serialization isolation. Profile timings are not used for the speedup claim.

Same-head verification reported 336 TypeScript tests, 25 effect-rust plus four math-interop Cargo tests, a generated Rust template smoke, eight real product/service smokes, and 44 shared vectors on both layers with zero disagreements. Actual Chromium window/module Worker and workerd typed-value smokes passed; workerd used a precompiled Module with zero fetches. The complete Buck aggregate passed 859 commands, but outer check:quick exited 1 for the two recorded [#1564](https://github.com/overengineeringstudio/effect-utils/issues/1564) Nix product-import failures. This is not a wholly green outer gate.

## Conclusion

The unchanged harness supports reduced synchronous primitive and domain boundary work while retaining exercised contract/lifecycle behavior. It does not establish a universal speedup, nor replace the historical [internal app pilot B (stateful matcher)](./pilot-b-stateful-matcher.md) benchmark with a matcher rerun.

## Intent Impact

Keep direct in-process values distinct from canonical wire JSON while sharing admitted validation semantics. Prefer the synchronous entry for synchronous exports and retain the async job path where needed.

## Limits

Shared-host baseline load1 was 9.12→9.52 (Node) and 9.52→9.44 (Bun), memory PSI some avg60 0.00%. After load1 was 46.78→47.29 and 47.29→55.57; PSI 0.02→0.61% and 0.61→0.63%; available memory 42.81–49.53 GiB. Load rose during Bun and later profiling backed off. Native generated bytes medians were slightly worse (1.034× Node, 1.008× Bun), while raw native bytes also slowed; these cells prove neither regression nor improvement under comparable load. No isolated latency guarantee follows.

Direct and canonical JSON have intentionally different representations. Adapters/services must advance together; the proof is a clean ABI cutover, not compatibility with prior generated packages. Expected-error calls still allocate and validate. Two physical Effect copies are rejected rather than accepted as coherent.

## Sources

- [Typed direct PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610), identical benchmark, CPU attribution, product proofs, and load caveats.
- [Resource baseline #1605](https://github.com/overengineeringstudio/effect-utils/pull/1605), also open when consulted.
- [Public historical pilot evidence](https://github.com/Effect-TS/effect/issues/8690), which still describes direct/resource work as planned and is not the after-implementation source.
