# Decision: Strict canonical JSON control plane

## Status

Status: accepted

## Context

Current-round q5–q6, q17–q18, q22, and q24 resolve full-width integers and parser-level parity. Object vectors cannot catch duplicate keys, lexical integer differences, or recursion limits.

## Decision

Use canonical base-10 decimal strings for u64/i64, mandatory width metadata, bounded bigint in Effect, and natural Rust integers. No exponent, fraction, leading zero, plus sign, whitespace, or negative zero; reject missing width at generation.

Both sides enforce strict I-JSON: valid Unicode, finite numbers, no duplicate keys, canonical integer tokens, and maximum nesting depth 128. Unknown fields are rejected everywhere. Encoders sort keys canonically, except `_tag`/the owner's discriminator first; decode rejects tag-last rather than falling back to buffered Value. This **tag-first choice remains pending the friction bakeoff DQ7**, as expressly requested; it is not an unconditional ergonomics conclusion.

## Evidence and Argument

[B2](../.experiments/b2-integer-wire.md) gave all four lossless paths complete tested full-range parity; optionally annotated number defaults failed 13/39 checks per runtime. Strings were the fastest eligible JSON representation. [R](../.experiments/r-generated-rust.md) exposed five JSON-text disagreements, sorted-versus-insertion order, and path loss when a discriminator arrived late.

## Options

| Option                                      | Tradeoff                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Decimal strings + strict profile (selected) | Readable and lossless; custom duplicate/lexical checking            |
| Source-aware numeric JSON                   | Lossless only with specialized parsing; slower on the fixture       |
| lossless-json                               | Portable numeric wire, extra library and encode cost                |
| Optional width annotations                  | Fails full-range requirement                                        |
| Ignore unknown fields                       | Forward compatibility, typo acceptance and weaker parity            |
| Buffer tag-last                             | Accepts more producers, loses nested paths and streaming guarantees |

## Consequences

Reader-first evolution is needed for strict unknown fields. Canonical ordering is the interop wire contract, not ownership of a domain's hashing format. Rust retains its own tag key; the Effect error enum's outer tag and reason tag are distinct semantic axes. DQ7 measures tag-first producer/tooling friction before that policy is finalized.

## Specification

[JSON control plane](../spec.md#json-control-plane) and [DQ7](../spec.md#design-questions).

## Amendment 1

The tag-order friction bakeoff resolves the historical DQ7 and supersedes q24: accept any input key order, stream when the discriminator is first, and use buffered fallback otherwise. Our encoders emit the owner discriminator first, then canonically sorted remaining keys. This accommodates PostgreSQL jsonb and other key-reordering producers without creating separate strict-wire/tolerant-store modes. [The friction experiment](../.experiments/t-tag-order-friction.md) records the performance/memory tradeoff; [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) is the open foundation implementation.

## Amendment 2

[Annotation-first authoring](./0014-annotation-first-authoring.md) admits exact bounded `Schema.Int` with inferred storage and optional width pinning. Bounded bigint infers u64 for nonnegative minima and i64 otherwise, with an optional pin; selected width is always explicit in the IR and bounds-validated. This supersedes the author-supplied width requirement, not canonical decimal-string u64/i64 JSON. Schema-aware optional-key omission replaces own-undefined with absence only where declared by the schema.

[Finite binary32](./0018-finite-binary32-and-numeric-admission.md) makes numeric JSON admission schema-aware: float fields admit integer tokens, fractions and exponents with finite binary32 rounding; integer fields still reject `1.0`, `1e0` and unsafe numeric values. Native parsed-object safe-integral normalization does not change strict JSON text. [PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) implements this refinement in an open PR. Its typed direct bigint/epoch-millis representation is separate; canonical JSON remains the process/storage wire.
