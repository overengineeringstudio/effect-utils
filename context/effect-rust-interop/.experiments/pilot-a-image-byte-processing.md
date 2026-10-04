# Experiment: internal app pilot A (image/byte processing)

Non-normative historical pilot evidence, followed by separately built browser-delivery evidence. No private application identity or artifact location is needed to interpret the result.

## Question

Do aggregate-size and warm-init improvements survive first initialization and integration costs?

## Hypothesis

Aggregating two Rust cores can reduce shipped wasm and warm initialization cost without necessarily reducing first-load cost or handwritten integration work.

## Method

The published pilot summary compares a two-core aggregate with the previous pair, warm initialization, Chromium first initialization under inline versus external delivery, and manual glue line counts. This record reports the published denominators; it does not invent sampling details absent from that summary. The later browser-delivery PR separately exercises raw packages and Vite production output in actual Chromium window and module Worker contexts, plus local workerd.

## Result

| Historical pilot observation               | Result                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| Aggregate wasm compared with previous pair | 34–37% smaller                                            |
| Warm initialization                        | 6–10 ms versus 14–21 ms                                   |
| Chromium first initialization              | Inline base64 342 ms versus external asset 85 ms          |
| Manual glue                                | 120 → 123 lines; no overall reduction                     |
| Effect dependency mismatch                 | Mixed Effect RCs produced `self._build is not a function` |

The q52 decision request also reported a 2.49 MB inline-loader JavaScript artifact. That is a loader size, not the aggregate wasm size or a measured compressed network transfer.

[#1604](https://github.com/overengineeringstudio/effect-utils/pull/1604) reports the implemented browser/default external-asset entry and explicit inline option. Its Chromium raw and production smokes each observe three streamed external instantiations per window/Worker context, zero buffered external instantiations, and isolated traps. Vite 8.2.2 emits one 953.20 kB wasm asset, 32.80 kB main JS, and 31.64 kB Worker JS. Local workerd uses a precompiled Module with zero fetches. These are that PR's fixture-product results, not the internal pilot's artifact sizes or a fresh repeat of 342/85 ms.

## Conclusion

Aggregation improved the measured wasm and warm-init costs, but inline JavaScript delivery reversed the first-init advantage. The result motivates external browser assets, not a universally faster aggregate or less application glue. Dependency cohort coherence is an independent integration constraint.

## Intent Impact

Use explicit external browser assets with an explicit inline option; preserve aggregation while measuring first-load costs separately from warm acquisition.

## Limits

The summary provides no first-init distribution or controlled-host performance guarantee. Do not conflate warm initialization with first initialization, raw wasm with loader JavaScript, or pilot bytes with follow-up fixture bytes. #1604 was open when consulted: its implementation was built and exercised, not merged. Its body attributes 342/85 ms to the public byte pilot; the upstream evidence table and supplied q52 context place that observation in this internal app pilot A.

## Sources

- [Public interop review evidence table](https://github.com/Effect-TS/effect/issues/8690), containing the anonymized pilot measurements.
- Supplied private q52 request, for the loader-size and delivery comparison context; no private identities or filesystem locations are reproduced.
- [Browser delivery PR #1604](https://github.com/overengineeringstudio/effect-utils/pull/1604).
- [Earlier composition](./e1-composition.md) and [producer ownership](./e5-existing-bindings.md): earlier experiments, not this later aggregate pilot.
