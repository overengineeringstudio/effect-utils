# Decision: Generated scoped stateful resources

## Status

Status: accepted

## Context

Internal app pilot B (stateful matcher) needed caller-owned Rust state rather than free functions and byte streams. A pilot-local generator duplicated lifetime and serialization policy; resource IR makes that policy shared.

## Decision

Expose inherent impls through `#[effect_rust::resource]`. Constructors are public synchronous `new(...) -> Self`; generated acquisition is `Effect.Effect<Resource, never, Scope.Scope>`. Validation and panic defects at construction are not recoverable domain errors.

Each resource has one FIFO semaphore serializing receiver methods and close. Independent resources can proceed independently. Resources are generation-affine and reuse the runtime generation registry: a trap poisons siblings and pending calls, and rebuild creates fresh resources without reviving stale handles or replaying operations.

Retiring poisoned wasm disables finalizers and discards the instance; do not claim Rust destructors ran. Native retirement closes owned resources after guarded unwinding. Reject consuming, async, generic, static, reserved-close, and owned-resource-return methods at macro expansion rather than invent ambiguous ownership rules.

## Evidence and Argument

[The stateful matcher experiment](../.experiments/pilot-b-stateful-matcher.md) motivated the gap. [PR #1605](https://github.com/overengineeringstudio/effect-utils/pull/1605) implements scoped resources and records FIFO, panic, sibling, isolation and stale-generation scenarios. It remains an open implementation PR. [PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) exercises resources through the later direct boundary without replacing these lifetime rules.

## Options

| Option                                                       | Tradeoff                                              |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| Shared resource IR and scoped generation registry (selected) | Typed lifecycle with one poison authority             |
| Pilot-local generators                                       | Less foundation surface, repeated lifecycle machinery |
| Concurrent mutable methods                                   | Lower queueing, invalid overlapping Rust access       |
| Revive old handles after rebuild                             | Apparent continuity, stale-instance aliasing          |

## Consequences

Close is serialized with calls and tied to caller scope. A fresh generation restores availability, not the identity or state of a poisoned resource. Resource acquisition does not weaken unwind-only native containment or owned-data defaults.

## Specification

[Runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).
