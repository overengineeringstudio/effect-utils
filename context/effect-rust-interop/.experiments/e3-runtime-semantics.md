# Experiment: E3 — Streams, cancellation, and panics

Evidence summary of an experiment on a loaded Linux x86_64 development host on 2026-09-30. Timings and throughput are directional, not quiet-host baselines or service-level guarantees. The record summarizes observed prototypes; it does not claim that the production foundation is implemented.

## Question

What do interruption, host callbacks, concurrent jobs, and panics actually guarantee across the runtime matrix?

## Hypothesis

Scoped jobs, owned chunks, and explicit cancellation can bridge Effect and Rust safely; panic behavior needs foundation-owned containment.

## Method

Exercise input/output streams, real Rust-to-host filesystem and HTTP callbacks, concurrent handles, native CPU tasks, healthy cancel loops, and synchronous/asynchronous/mutable-borrow panic probes. Use Node and Bun wasm/native, Chromium wasm, and local workerd wasm. Native fatal probes execute in isolated child processes.

## Result

| Probe                                      | Observed result                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Healthy cancel cycles                      | 10,000 per runtime/backend; zero live Rust handles/futures at each checkpoint; flat wasm linear memory       |
| Abortable filesystem / HTTP                | Actual desktop file reads stopped; actual HTTP response-body cancellation stopped in every exercised runtime |
| Settle-only host Promise                   | Host work continued after Rust state was released; completion was not Rust quiescence evidence               |
| Stock wasm scheduled async panic           | JS trap escaped while the exported Promise remained pending                                                  |
| Experimental scheduler fence               | All waiting Effects failed as defects in desktop probes; poisoned Rust state still required retirement       |
| Mutable-borrow wasm panic                  | Further mutation and free rejected; unrelated successful hashing did not prove instance health               |
| Native unwind plus catches                 | Explicit/macro sync and exported-future containment survived exercised probes                                |
| Native uncaught / CPU task / abort profile | Node and Bun terminated with SIGABRT                                                                         |

For a 16 MiB Chromium input stream, 4 KiB chunks cost 112.740 ± 3.401 ms versus 43.740 ± 1.694 ms at 64 KiB and 38.840 ± 1.111 ms at 1 MiB (10 samples). This includes Effect scheduling, copying, and hashing, not ABI alone. Multiple wasm instances on the same JS thread did not create CPU parallelism; JS workers did. Native compute required cooperative token checks.

## Conclusion

Healthy Rust cancellation and bounded streams worked; stock panic handling did not establish reliable settlement or recovery.

## Intent Impact

Cancellation means Rust stopped and handles released before interrupt completes; host capabilities declare abortable or settle-only. Generate module-local factories, pending-job registries, and panic boundaries. Offer configurable latency/bulk chunks and bounded concurrent work. Panics remain defects.

## Limits

Healthy cancellation does not prove JS/native whole-heap or repeated poisoned-instance reclamation. The async panic fence was not proven in Chromium/workerd. No production Cloudflare, hard cancellation latency bound, or general Rust source-level debugger session is claimed.

## Related decision

[Runtime semantics decision](../.decisions/0004-runtime-semantics.md).

## Amendment 1

E3's browser/workerd panic-fence gap is historical. [B3](./b3-panic-reclamation.md) subsequently exercised poisoned generations across all four portable runtimes; [W](./w-workerd-memory.md) separates complete unreachability from delayed host collection. [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) reports built poisoning/retirement, synchronous settlement, and retirement-aware finalizers. [PR #1605](https://github.com/overengineeringstudio/effect-utils/pull/1605) separately exercises scoped resources, sibling poisoning, stale rejection, and rebuild; [#1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) reports actual Chromium/workerd typed-transport smokes. These open PRs are implementation evidence, not merged status or prompt reclamation guarantees.
