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
