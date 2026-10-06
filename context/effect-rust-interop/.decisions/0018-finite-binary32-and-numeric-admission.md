# Decision: Finite binary32 and representation-aware numeric admission

## Status

Status: accepted

## Context

Typed direct transport and image/byte processing need numeric schemas that distinguish binary32 rounding from integer exactness. A global JSON-number rule would either reject legitimate floats or admit noncanonical integer spellings.

## Decision

Admit explicit finite binary32 through `EffectRust.F32` and Rust `#[wire(f32)]`. Round numeric input to nearest binary32; reject NaN, infinities and overflow. Canonical JSON uses the ECMAScript shortest representation of the widened binary32 value, matching `JSON.stringify(Math.fround(x))`. Preserve negative zero in direct/Borsh transport and normalize it to zero only in canonical JSON.

JSON numeric admission is schema-aware. Float fields admit numeric integer tokens, fractions and exponents subject to binary32 rounding/finiteness, including integer tokens outside the JS safe-integer interval. Integer fields retain safe canonical integer tokens: fractions and exponent spellings such as `1.0` and `1e0` remain invalid. Wide integer JSON remains canonical decimal strings.

The native parsed-object boundary normalizes only finite, safe integral JS doubles before integer contract decoding, with exact width/bounds validation. Fractional and unsafe doubles still fail integer admission. This repairs representation differences in native JS values; it does not normalize or weaken strict JSON-text input.

## Evidence and Argument

[Open PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) documents the f32 policy and contains schema-aware nullable numeric-token vectors, direct/Borsh negative-zero coverage and nonfinite/overflow rejection. [Open PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) documents native safe-integral normalization, including u32/i32 bounds, both safe-integer extremes, negative zero and fractional/unsafe rejection. Neither PR is represented as merged.

## Options

| Option                                                      | Tradeoff                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| Explicit f32 plus schema-aware numeric admission (selected) | Predictable rounding without weakening integers            |
| Treat all numeric JSON as canonical integers                | Rejects valid float fractions/exponents                    |
| Relax every integer spelling                                | Loses lexical parity and canonical wire policy             |
| Normalize every native double                               | Silent precision loss or fractional truncation             |
| Implicit arbitrary floating-point policy                    | Unspecified precision, overflow and negative-zero behavior |

## Consequences

A value can be valid for a float field and invalid for an integer field; the schema owns that distinction. Integer safety guards are representation-specific, not a global prohibition on large float tokens. Binary32 rounding may change a wider input value and is therefore explicit in the contract.

## Specification

[JSON control plane](../spec.md#json-control-plane) and [binary bulk](../spec.md#binary-bulk).
