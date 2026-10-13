# Experiment WA: Annotation-first Effect contracts

Non-normative evidence from a disposable prototype using Effect 4.0.0-rc.118. This record distinguishes an authoring experiment from the built foundation.

## Question

Can idiomatic Effect schemas preserve the admitted fixture without a mandatory parallel authoring vocabulary?

## Hypothesis

Plain Effect Schema plus metadata for facts the compiler cannot infer can preserve the existing admitted contracts without requiring a parallel `Wire.*` authoring vocabulary.

## Method

Rewrite all seven shared roots as plain schemas. A memoized AST visitor adapts known nodes/checks to the existing admitted representation, reusing its lowering, Rust emitter, and strict decimal/timestamp codecs. Compare acceptance, canonical text, and complete IR against the existing fixture; execute freshly emitted Rust. Separately smoke an ordinary Effect JSON codec, an infrastructure-shaped scenario, a framed Borsh round-trip, and a registered transformation preserving the Patch ADT.

## Result

| Probe                           | Observed result                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Shared TypeScript vectors       | 137/137; 39 accepted, 98 rejected; zero disagreements; identical IR                                           |
| Fresh generated Rust vectors    | 137/137 passed                                                                                                |
| Registered Patch transformation | Six cases per side; absent/null/value retain Absent/Null/Value; invalid wire forms reject                     |
| Ordinary Effect codec           | Bigint domain value retained; optional-field undefined omitted; required undefined and optional null rejected |
| Framed TypeScript/Rust smoke    | Identical bytes `0403020102000c000000ffffffffffffffff`; wrong version rejected                                |

The pinned built-ins were insufficient on their own: BigInt JSON decoding normalized `"00"`, `"01"`, and `"-0"`; DateTime decoding truncated sub-millisecond text and normalized invalid calendar dates; a `parseOptions` annotation did not enforce excess-field rejection; stock optional-undefined JSON conversion produced null rather than the selected omission behavior. Encoded-side validation and schema-aware boundary policy remain necessary.

The separate rough-edge prototype exercised 273 TypeScript tests, 137 original plus 88 new freshly emitted Rust vectors, and real raw/generated Node/Bun wasm/native smokes. Known trimmed/nonempty checks, portable built-in patterns, and literal tagged-constructor defaults were admitted without admitting opaque predicates or arbitrary defaults. Safe-number contracts and optional-undefined policy were still decision questions at that snapshot.

## Conclusion

The fixture does not require a second schema language: known AST checks and small annotations can reach the same IR and boundary semantics. This is not proof of arbitrary Effect schema portability or that stock `Schema.toCodecJson` supplies the whole strict wire profile.

## Intent Impact

Separate domain-schema authoring from transport operations; retain compiler-owned strict boundary validation and reject opaque semantics rather than blessing them with metadata.

## Limits and current evidence

WA reused the existing emitter/codecs; parity is not independent-parser verification. It covered exact fixture integer intervals, not arbitrary bounded integer subranges; rejected rather than widened unsupported intervals. Proposed API names in the report were previews, not implemented exports. The built foundation in [#1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) is separate evidence; [#1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) adds typed direct transport while retaining distinct canonical JSON. Both PRs were open when consulted, not merged.

## Sources

- Supplied private WA report, inference table and runnable-prototype results; supplied private rough-edge report, per-edge outcomes and exercised verification. Private evidence is summarized without repository identities or filesystem locations.
- [Public Effect interop review](https://github.com/Effect-TS/effect/issues/8690), for the separately reported upstream AST/codegen gaps; it is not a rerun of this pinned prototype.
- [Earlier schema conformance](./e2-schema-conformance.md) and [compiler bakeoff](./b1-schema-compiler.md).
