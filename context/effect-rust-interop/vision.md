# Vision: Effect–Rust interop foundation

## The Problem

1. **Problem 1 — Repeated boundary work:** Applications repeat loading, resource lifetime, streaming, and failure handling when consuming reusable Rust engines from Effect.
2. **Problem 2 — Contract drift:** Independently maintained cross-language models disagree on valid inputs and silently lose semantic information.
3. **Problem 3 — Composition cost:** Independently packaged engines duplicate runtime overhead and make deployment behavior depend on application-specific glue.
4. **Problem 4 — Hidden lifetime failures:** Cancellation, panics, and borrowed data can leave work pending or expose invalid data after a call returns.

## The Vision

- Consumers reuse domain engines without owning boundary machinery (Problem 1).
- Each shared contract has one authority and equivalent observable semantics in both languages (Problem 2).
- Applications compose only the engines they need with explicit deployment tradeoffs (Problem 3).
- Completion, interruption, and failure have dependable lifetime boundaries (Problem 4).

## What This Is Not

- A rewrite of Effect applications or their domain policies.
- A mandate to implement every operation in Rust.
- A universal converter for arbitrary functions, host objects, or schema predicates.
- A promise of hard isolation or zero-copy transfer on every deployment.

## Success Criteria

1. The admission matrix executes the same byte-engine contract in every supported runtime without consumer-specific boundary patches.
2. Every admitted contract passes the same accept/reject and semantic round-trip vectors in both languages, including full-width integers.
3. An application composes multiple engines without duplicated per-engine runtime instances within a bundle group.
4. Cancellation releases Rust jobs and handles before interruption completes; panic probes settle every affected Effect without exposing a poisoned instance.
