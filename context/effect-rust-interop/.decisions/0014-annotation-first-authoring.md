# Decision: Annotation-first Effect contract authoring

## Status

Status: accepted

## Context

The first foundation vocabulary duplicated idiomatic Effect schemas with `Wire.*` constructors. Later decisions q36–q38 and q44–q46 distinguish domain authoring from transport representation without losing admitted semantics.

## Decision

Author contracts with plain Effect Schema, namespaced string-key annotations, and small `EffectRust` helpers only where stock Schema cannot express the boundary policy. Remove the `Wire.*` authoring surface rather than retain compatibility aliases. Keep `ContractJson`, `Borsh`, and `Columns` as transport operations, not a parallel schema language.

Admit fully bounded `Schema.Int` with its exact original bounds. Infer the smallest admitted integer storage width, with an optional `[EffectRust.width]` pin; a pin must fit the contract rather than widen acceptance. A width change changes binary layout and requires a frame version bump. Bounded bigint contracts infer u64 when the minimum is nonnegative and i64 otherwise, with an optional width pin and bounds checked against the selected range. The IR always records the selected width; canonical decimal-string JSON remains unchanged.

For schema-declared optional object keys, encode own-property `undefined` as omission, recursively. This is not generic undefined dropping: required keys and array elements do not acquire omission semantics, and null is accepted only when the field schema admits it. Optional-nullable TS fields use raw `Schema.optionalKey(Schema.NullOr(T))`; generated Rust retains `Patch<T>` to distinguish absent, null, and present values.

Effect-owned Rust types can expose optional schemars `JsonSchema` implementations emitted from the same admitted IR and definitions. Do not re-derive a weaker contract from generated field types or maintain hand-authored schema bridges.

## Evidence and Argument

[The annotation-first experiment](../.experiments/wa-annotation-first.md) produced equal IR and 137 agreeing vectors per side for its fixtures. It did not establish generalized bounded-subrange implementation coverage. [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) is the open foundation implementation; [Effect issue #8690](https://github.com/Effect-TS/effect/issues/8690) explains why stock JSON codecs/export/import cannot silently replace the stricter derived boundary.

## Options

| Option | Tradeoff |
| --- | --- |
| Plain Schema plus annotations (selected) | Idiomatic ownership; extra layout/codec policy remains explicit |
| Mandatory Wire vocabulary | Easy recognition, duplicate authoring language |
| Tagged Patch ADT in TS | Symmetric spelling, non-idiomatic optional fields |
| Mandatory width for bounded number fields | Predictable layout, unnecessary authoring friction |
| schemars derives over emitted types | Less compiler output, can lose source constraints |

## Consequences

Annotations cannot authorize unknown predicates or lossy transformations. Storage inference and validation are separate; changing bounds does not silently weaken acceptance. Ordinary Effect schema semantics and the stricter compiler-derived transport remain distinguishable. This decision supersedes the TS Patch representation and the blanket author-supplied width requirement for bounded numeric contracts, not Rust Patch or wide-integer losslessness.

## Specification

[Schema ownership and semantic codecs](../spec.md#schema-ownership-and-semantic-codecs-r02r04-r14).
