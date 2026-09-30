# Decision: Schema ownership and semantic extensions

## Status

Status: accepted

## Context

Shared contracts originate in either language, while runtime validation needs to preserve semantics richer than ordinary generated types.

## Decision

Choose one Rust or Effect owner per contract, generate runtime codecs and types for the other side, and run shared accept/reject plus semantic round-trip vectors. Preserve DateTime, integer widths, and brands with semantic custom keywords and generated codecs on both sides; no hand mirrors.

## Evidence and Argument

The [schema experiment](../.experiments/e2-schema-conformance.md) showed 14 of 30 Effect-owned vectors disagreeing with Typify alone, 8 with added JSON Schema validation, and 3 of 18 Rust-owned vectors failing at full-width u64. Missing source semantics cannot be recovered by downstream types.

## Options

| Option                                                   | Tradeoff                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Per-owner generation with semantic extensions (selected) | Preserves authoring ownership; requires bidirectional codecs |
| Portable subset only                                     | Easier compiler, less expressiveness                         |
| Owner-only final validation                              | Accept/reject disagreement remains                           |
| Universal Effect owner                                   | Forces Rust engines into a TS authoring dependency           |
| Neutral IDL                                              | Separate expressiveness and codegen research                 |

A portable-subset-only policy loses desired authoring expressiveness. Owner-only final validation permits disagreement elsewhere. A universal Effect owner does not fit Rust-owned engines. A neutral IDL needs a separate expressiveness/codegen evaluation ([#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547)).

## Consequences

Typify plus validation and the Effect 4 compiler are a baseline, not a settled best-in-class result. Bake off generators and full-range u64/i64 transport; losslessness is mandatory, throughput next, readability and size last. A custom compiler is acceptable if the ecosystem falls short.

## Specification

[Schema ownership and semantic codecs](../spec.md#schema-ownership-and-semantic-codecs-r02r04-r14).
