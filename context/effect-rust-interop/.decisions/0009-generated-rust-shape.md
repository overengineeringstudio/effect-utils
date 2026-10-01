# Decision: Generated Rust shape and invariants

## Status

Status: accepted

## Context

Current-round q9 and q16, q19–q21, q23 resolve the idiomatic generated Rust API. Correct values alone do not settle construction invariants, error paths, tooling, or evolution.

## Decision

Generate A-stream: plain serde structs/enums, validating private-field newtypes, and streaming tagged-union decoding with wire-name paths. Default to exhaustive types; `#[non_exhaustive]` plus constructors is owner opt-in. Buck emits one defining crate per contract set so non-exhaustiveness applies to consumers.

Use natural Rust u64/i64 with wire adapters, a `TimestampMillis` newtype enforcing millisecond precision, and `Patch<T> { Absent, Null, Value(T) }` for optional-nullable fields. Require an owner identifier for every constrained string. Decode in one pass; public raw fields or a second validate() phase must not permit invalid constrained values.

## Evidence and Argument

[R](../.experiments/r-generated-rust.md) compared six shapes, all with zero disagreements on 125 vectors. A-stream produced nested paths for 72/89 rejections versus 59/89 for derived unions, with the same 22-crate footprint. Evolution gave three targeted compile errors for exhaustive consumers; non-exhaustive consumers kept compiling but silently classified new variants as unknown. Plain chrono values demonstrably lost sub-millisecond precision at encoding.

## Options

| Option                        | Tradeoff                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| A-stream (selected)           | Ordinary Rust, readable generated source, strongest paths    |
| Non-exhaustive default        | Version-skew convenience, migration errors hidden            |
| nutype                        | More dependencies and weaker diagnostics                     |
| garde                         | Two-phase validation, invalid values constructible           |
| Contract proc-macro expansion | Worse review/go-to-definition; external expansion not linted |
| Option<Option<T>>             | Compact, easy to confuse absent and null                     |

## Consequences

Constrained-string names are source-owned, not guessed from fields. DateTime rejects sub-millisecond values rather than truncating. Generated source is inspectable; this does not reject the separate thin-adapter export attribute. Canonical wire ordering and strictness are [decision 0010](./0010-json-control-plane.md).

## Specification

[Generated Rust](../spec.md#generated-rust).
