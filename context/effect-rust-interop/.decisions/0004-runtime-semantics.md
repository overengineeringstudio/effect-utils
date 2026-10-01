# Decision: Runtime cancellation, panics, and ownership

## Status

Status: accepted

## Context

Effect interruption and scoped release need an honest Rust/host boundary; stock bindings do not guarantee panic settlement or output lifetime.

## Decision

Interruption waits for Rust jobs/handles to quiesce; host capabilities declare abortable or settle-only. The foundation owns generated instance factories, scheduler trap observation, and pending jobs. A trap fails affected Effects as defects, poisons/retires the scope, and rebuilds fresh state by default without replay. Native exports require unwind and generated catches; abort builds are rejected. Data is owned/copied by default, with explicitly marked Rust borrowed/scoped alternatives.

## Evidence and Argument

The [lifecycle experiment](../.experiments/e3-runtime-semantics.md) passed 10,000 healthy cancel cycles per exercised runtime/backend but found pending stock wasm Promises and native process aborts. The [ownership experiment](../.experiments/e5-existing-bindings.md) found freed/corrupted pixels and views detached after memory growth.

## Options

| Option                                                        | Tradeoff                                            |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Quiescence, foundation containment, owned defaults (selected) | Strong Rust boundary, generated lifecycle machinery |
| Best-effort cancellation and raw views                        | Less glue, leaks and invalid lifetimes remain       |
| Every host API must abort                                     | Stronger host guarantee, excludes settle-only APIs  |
| Stock panic glue                                              | Simpler, pending Effects or process aborts          |
| Dedicated isolation everywhere                                | Strong isolation, added transport/execution cost    |

Best-effort cancellation can leak Rust work. Requiring every host API to abort excludes useful settle-only APIs. Stock panic glue can hang or abort; global exception hooks cannot establish module ownership. Raw data views export hidden lifetime hazards.

## Consequences

Recovery is configurable with a solid containment default. Healthy-cancel counts are not poisoned-rebuild reclamation proof. Subprocesses provide hard crash isolation; recreating a native Layer does not unload an addon. Latency/bulk chunk profiles are configurable; borrowing is admitted only with explicit scope constraints.

## Specification

[Runtime lifecycle and panic containment](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).

## Amendment 1

[B3](../.experiments/b3-panic-reclamation.md) selects in-process lexical rebuild by default, with retire-only and dedicated Worker execution explicit. Init fails initial Layer construction only; failed rebuild is a defect, not a new method-level Init failure. Input streams expose Sinks and output streams expose Streams. Native catches cover future polls, AsyncTask compute/resolve/reject, and owned cleanup before settlement; containment is restricted to unwind panics. See [the boundary API decision](./0008-idiomatic-boundary-api.md).

## Amendment 2

[W](../.experiments/w-workerd-memory.md) resolves local workerd retention as delayed GC, not a foundation leak. **Retirement guarantees unreachability, not prompt release.** The runtime Layer is isolate-scoped, not per-request. Large-linear-memory product admission remains open pending Cloudflare production and mitigation measurements. Pressure hints and retired-bytes budgets are not selected defaults; see [the workerd decision](./0012-workerd-memory-contract.md).
