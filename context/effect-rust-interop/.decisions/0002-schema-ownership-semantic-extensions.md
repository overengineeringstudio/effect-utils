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

## Amendment 1

The generator and integer bakeoffs are resolved, superseding the baseline and pending bakeoff in the original Consequences section. [B1](../.experiments/b1-schema-compiler.md) found no existing stack meeting all six must-haves. Choose [the owned TS compiler](./0007-owned-schema-compiler.md): live Effect SchemaAST, reuse of Effect's emitter, schemars 1.x plus the Rust helper crate, strict cross-engine regex, and a required versioned vocabulary.

[B2](../.experiments/b2-integer-wire.md) selects canonical decimal-string JSON with required integer widths; [the binary decision](./0011-binary-bulk.md) selects Borsh bulk frames. [Generated Rust](./0009-generated-rust-shape.md) is A-stream, not Typify plus a second validator. Shared authoring ownership and executable parity remain unchanged.

## Amendment 2

[Annotation-first authoring](./0014-annotation-first-authoring.md) refines the width and codec surface: plain Effect Schema plus namespaced annotations replaces `Wire.*`; bounded `Schema.Int` infers storage with optional width pinning. Bounded bigint infers u64 for a nonnegative minimum and i64 otherwise, with optional pinning; the IR always records and validates the selected width. Effect-owned schemars implementations come from the admitted IR, not rediscovery through derives. [Typed direct transport](./0017-typed-direct-inprocess-transport.md) adds an in-process representation without changing the process/storage JSON contract. [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) and [PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) are open implementation sources, not merged releases.
