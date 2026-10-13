# Experiment B3: Poison, retire, rebuild, and isolation

## Question

Does retirement settle poisoned jobs and reclaim generation state, and what fault class can native delivery actually contain?

## Hypothesis

A lexical wasm factory, module-owned scheduler fence, and generation job registry can settle poisoned work and sever retired state; generated native catches can contain admitted unwind panics.

## Method

Each lexical factory created an instance, glue state, views, finalizers, and registry from one reusable compiled Module, without ESM cache-busting. Node 24.20, Bun 1.4.2, Chromium 153, and local workerd each ran 1,000 cycles alternating 500 async scheduler traps and 500 mutable-borrow traps, with genuine pending host calls and a live output stream. Every tenth host Promise remained unresolved until the end to expose callback retention. Native boundaries and a dedicated Worker alternative were exercised separately.

## Result

Every portable runtime recorded 4,000 defect exits, 1,000 failed streams, 1,000 rejected stale handles, 1,000 correct fresh digests, and zero final jobs/handles. No failed operation was replayed.

| Runtime                  | Finalized memories / 1,001 |    Late RSS range MiB | Finite-run gate                       |
| ------------------------ | -------------------------: | --------------------: | ------------------------------------- |
| Node                     |                      1,001 |                  9.78 | Pass                                  |
| Bun                      |                      1,001 |                  2.59 | Pass                                  |
| Chromium                 |                      1,001 |                  3.73 | Pass                                  |
| workerd original         |                        640 |                 48.23 | Not established                       |
| workerd stripped repeats |            957 / 900 / 927 | 13.89 / 12.34 / 25.54 | Final release/plateau not established |

The screen required late RSS range ≤16 MiB, heap range ≤4 MiB, and final object reclamation where forced GC was available. Fresh linear memory was 1.125 MiB. A negative control retaining instance/module references left ten retired memories pinned by opaque callbacks at 100 cycles, demonstrating sensitivity to actual retention.

Lower-load interleaved post-trap factory timings, mean ± SD: Node 0.135 ± 0.234 ms, Bun 0.064 ± 0.090 ms, Chromium 0.090 ± 0.235 ms. Workerd's amortized batch cost was 0.151 ± 0.026 ms and included different work/HTTP overhead, so is not directly comparable.

Native Node/Bun caught sync exports, future polls after host awaits, AsyncTask compute/resolve/reject, and owned cleanup. Abort builds were rejected before load; double panics killed isolated children with SIGABRT. A compile-owned ELF x86_64 attestation plus a digest-pinned private load snapshot rejected dishonest metadata and source-artifact swapping. Other platform attestation was not implemented in this experiment.

One thousand native contexts with touched 1 MiB allocations closed with zero owned counters. Node RSS plateaued at 48.64 MiB (start 47.11); Bun moved 29.84→35.57 MiB without an established whole-process plateau.

Dedicated Workers passed 1,000 poison cycles. Node/Bun each observed 1,013 exits, active=0, peak=1. Serialized 4 KiB calls cost 15.805 ± 1.309 / 18.441 ± 3.935 microseconds; replacements plus first hash cost 23.976 ± 1.369 / 9.517 ± 0.965 ms. Bun Worker late RSS range was 16.46 MiB, narrowly outside the original screen, despite balanced exits. Chromium ended with no Worker targets but has no observed-exit event equivalent.

## Conclusion

[Decision 0008](../.decisions/0008-idiomatic-boundary-api.md) selects lexical in-process rebuild with explicit retire-only/Worker options and unwind-only native guarantees. [W](./w-workerd-memory.md) subsequently separates workerd reachability from delayed GC; B3 alone did not prove its leak or prompt reclamation.

## Intent Impact

Refines the recovery default and native guarantee; does not replace production memory admission with healthy counters.

## Limits

The workload is a finite-run screen, not absence-of-all-leaks or prompt RSS return. Correctness/memory ran under heavy load; desktop/Worker timings came from moderately utilized 32-CPU hardware (load about 18–25), remain directional, and are fixture costs, not bounds. Native Effect defect mapping was not exercised in the native slice; wasm Layer mapping was. OOM and arbitrary native process faults were not exercised. A JS Worker never supplies native process-crash containment, and local workerd has no standard dedicated-Worker option. Debug-section stripping reduced wasm from 9,145,745 to 260,830 bytes without algorithm changes; desktop/browser runs did not all use the same artifact size.

## Specification

[Runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).
