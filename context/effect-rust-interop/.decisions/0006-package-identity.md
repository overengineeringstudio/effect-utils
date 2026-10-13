# Decision: Package identity

## Status

Status: accepted

## Context

The boundary needs one public name for its Effect package and Rust companion, without suggesting a general foreign-language framework. This records current-round q1.

## Decision

Use `@overeng/effect-rust` and Rust crate `effect-rust`, housed in effect-utils. Both APIs must be idiomatic in their own language, not a port of Effect to Rust.

## Evidence and Argument

The names match the existing `@overeng/effect-*` package convention and name both sides of the boundary. Name availability was checked before selection; that historical check is not a future registry-reservation guarantee.

## Options

| Option                 | Tradeoff                                             |
| ---------------------- | ---------------------------------------------------- |
| effect-rust (selected) | Specific, matches repository naming                  |
| effect-interop         | Implies unrelated target languages are in scope      |
| effect-ffi             | Undersells schema generation and subprocess delivery |

## Consequences

Generated imports and helper types share one foundation identity. Other language policies and neutral-IDL research do not expand this package's scope.

## Specification

[Scope](../spec.md#scope).
