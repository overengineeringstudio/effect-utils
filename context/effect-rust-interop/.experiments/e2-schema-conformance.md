# Experiment: E2 — Bidirectional schema conformance

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

Which semantics survive bidirectional generation, and which disagreements need source metadata or runtime validation?

## Hypothesis

Owner-derived types and codecs can preserve cross-language validation if semantic information survives export and generation.

## Method

Run 48 shared accept/reject vectors: 30 Effect-owned descriptor/deployment/audit vectors and 18 Rust-owned vectors. Compare Typify-only serde, JSON Schema validation plus Typify, Schemafy, and serde/schemars to executable Effect 4 Schema generation. Exercise missing/null, unions, nested bounds, regex, string length, transforms, excess fields, and u64.

## Result

| Direction / path                                | Disagreements                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Effect-owned -> Typify types/serde only         | 14 of 30                                                                       |
| Effect-owned -> JSON Schema validation + Typify | 8 of 30                                                                        |
| Effect-owned -> Schemafy                        | 20 of 30                                                                       |
| Rust-owned -> generated bounded Effect Schema   | 3 of 18, all accepted full-width u64 values rejected by the Effect number path |

Effect 4.0.0-rc.118 emitted executable Schema source, not interfaces only. Typify 0.7.0, schemars 0.8.22, and JSON Schema validation 0.33.0 formed the tested baseline; schemars was selected for Typify API compatibility, not as a latest-version claim.

The Effect export omitted a digest regex without the Unicode flag; validation cannot restore a missing constraint. DateTime became plain strings, case-insensitive regex semantics disappeared, UTF-16 length differed from code-point length, and optional/null policy changed through a JSON codec. JSON Schema validation repaired retained bounds and presence checks but not these export losses.

## Conclusion

Generation worked in both directions, but neither generated types nor plain JSON Schema preserved all owner semantics.

## Intent Impact

Use one owner, generated runtime codecs, shared vectors, and explicit semantic extensions. The tested generator stack is a baseline for a state-of-the-art bakeoff, not evidence of arbitrary schema equivalence. Full-width integer transport must change rather than silently narrowing Rust u64.

## Limits

No generic semantic-extension compiler, full-range integer transport solution, recursive-contract proof, or exhaustive Effect/serde semantics coverage was implemented. Generator-only changes cannot recover semantics absent from exported metadata. No performance ranking is claimed.

## Related decision

[Ownership and extension decision](../.decisions/0002-schema-ownership-semantic-extensions.md).

## Amendment 1

The limitations above describe E2's generator baseline, not the current foundation. [WA](./wa-annotation-first.md) later preserved all 137 shared vectors and identical IR using plain Effect schemas plus narrow metadata; the rough-edge study ran freshly emitted Rust for 137 original and 88 additional vectors. [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) reports a built admitted-contract compiler and scoped services. [Typed direct evidence](./q53-direct-transport.md) separately covers natural JS representations while canonical JSON remains distinct. These later results do not establish arbitrary schema equivalence or recover metadata omitted by an owner export.
