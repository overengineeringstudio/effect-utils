# Decision: Typed direct in-process transport

## Status

Status: accepted

## Context

Internal app pilot B (stateful matcher) exposed generated-service overhead on short domain calls. Profiling found avoidable representation conversion, repeated codec construction, and asynchronous machinery around synchronous exports. Removing validation would change the contract rather than solve those costs.

## Decision

Use typed direct transport for wasm/native in-process calls. Rust adapters traverse structured JS values through serde without JSON text or an intermediate `serde_json::Value` tree. Wide integers remain bigint, timestamps are integral epoch milliseconds, bytes are Uint8Array, and containers remain structured. Derive direct and JSON validation from the same IR, preserving bounds, missing/null/present distinctions, excess-field policy, array lengths and tags.

Synchronous exports use lazy, interruption-aware `callSync`, retaining panic and generation behavior without allocating an AbortController, job, callback fiber or per-call tracing span. Promise/job exports retain the asynchronous path. Prepare directional encoders/decoders once at service construction, including borrowed-only and frame-only services.

Expected errors carry typed structured `rustError` values rather than JSON hidden in messages. Unexpected throws and panic envelopes remain defects. Native asynchronous workers carry Rust values; JS handles and result/error encoding remain on the owning JS thread.

A service-construction cohort guard rejects a second physical Effect copy before entering Rust. Require dependency deduplication rather than tolerate broken cross-copy identity.

Canonical JSON remains unchanged for process and storage boundaries: decimal-string wide integers, RFC3339 timestamps, strict integer lexemes and canonical ordering. Direct is not a relaxed JSON wire mode.

## Evidence and Argument

[The direct-boundary experiment](../.experiments/q53-direct-transport.md) and [open PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) record profiling, real generated-service measurements, shared vectors and lifecycle smokes. The PR explicitly rejects merely trimming stringification, relaxing contracts, special-casing benchmarks and wrapping every export asynchronously. This is implementation evidence, not a merged release claim.

## Options

| Option                                               | Tradeoff                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Typed direct plus separate canonical JSON (selected) | Less conversion, one additional representation with shared semantics |
| Remove JSON stringification only                     | Retains value-tree and representation conversions                    |
| Trusted/raw calls for hot paths                      | Lower overhead by opting out of contract enforcement                 |
| Universal asynchronous wrapper                       | Uniform implementation, avoidable synchronous lifecycle cost         |
| Permit multiple physical Effect copies               | Broken service/schema identity becomes runtime-dependent             |

## Consequences

In-process and persistent wires intentionally have different scalar representations, not different admitted contracts. Synchronous calls cannot promise event-loop preemption. Cohort failure is early and actionable; it is not a fallback to another runtime or decoder.

## Specification

[Errors and API sketch](../spec.md#errors-and-api-sketch-r05-r10r15) and [runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).
