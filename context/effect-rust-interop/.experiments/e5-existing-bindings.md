# Experiment: E5 — Existing first-party bindings and ownership

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

Do real existing first-party bindings expose lifecycle and ownership needs beyond the byte-engine pilot?

## Hypothesis

The foundation boundary is useful beyond hashing, including existing first-party wasm bindings (image utilities, color extraction, fuzzy matching).

## Method

Adapt actual image utilities and composed color extraction to explicit Effect service/Layer loading in Node, Bun, and Chromium. Compare encoded PNG bytes, image validity, palette composition, invalid-input panic channels, and a DOM pixel buffer before/after memory growth. Make the minimal producer-side ownership correction in the experimental Rust binding.

## Result

The original Rust producer passed a clamped view of its resized pixel storage to ImageData, then dropped that storage before JS consumed it. Chromium reproduced corrupted pixels and a detached view after subsequent wasm memory growth. Copying immediately in JS preserved already-corrupted pixels and was not a fix.

Copying into JS-owned storage while the Rust pixels were still valid preserved exact uniform RGBA pixels through memory growth and rendered to a real canvas. Encoded PNG output stayed byte-identical. Node/Bun image checks and image-to-color-extraction composition passed; invalid image panic stayed a defect in the adapted service, and corrupted initialization was typed Init.

The image path counted 96 physical / 69 nonblank-noncomment lines before versus 69 / 59 after, including the shared helper and both runtime constructors (27 physical / 10 counted-code lines fewer). Commented placeholder code contributes to the physical reduction, so this is not a production simplification estimate. Generated glue and unchanged utilities are excluded.

Raw separate wasm artifacts measured 2,428,370 B for image utilities and 1,515,113 B for color extraction: 3,943,483 B total. Both included the image dependency with default codecs; duplicate-byte attribution or a tuned aggregate minimum was not measured. Fuzzy matching was identified as the Rust-owned, stateful-handle consumer, not migrated in this experiment.

## Conclusion

An actual producer lifetime bug survived JS-side copying and was corrected only by copying before Rust storage release.

## Intent Impact

Enforce owned default outputs at the Rust producer, not merely the JS wrapper. Keep domain image policy and host DOM facades in the consumer. Follow the byte-engine pilot with image utilities/color extraction, then fuzzy matching to exercise Rust-owned stateful contracts.

## Limits

No Workers image execution, native image addon, ARM/Darwin image execution, long-running heap proof, generated schema conformance, or full application build. A scoped loader release hook does not dispose a singleton wasm memory or prove independent factories.

## Related decision

[Runtime ownership decision](../.decisions/0004-runtime-semantics.md).
