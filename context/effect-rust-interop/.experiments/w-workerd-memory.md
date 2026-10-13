# Experiment W: workerd reachability versus release latency

## Question

Is workerd retaining retired generations, or releasing unreachable memory late enough to endanger product admission?

## Hypothesis

B3's missing finalizations are delayed host GC rather than retained foundation references, but that distinction can still expose an admission hazard.

## Method

Direct workerd 2026-09-26 (V8 15.4.80.5) ran the B3 factory/registry with passive and forced GC, mid-request heap snapshots, WeakRefs, backing-store virtual mappings, RSS/smaps, idle probes, growth storms, scope variants, and a positive retention control. A production-like local config omitted inspector/GC flags. Node 24.20, Bun 1.4.2, Chromium 153, older workerd builds, and ten bisect builds were comparators. The heap analyzer traversed strong edges and was independently validated.

## Result

| Observation                                                 | Result                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Mid-request snapshots, 100/200 opaque retired host Promises | Only startup/current memories reachable                                              |
| Positive incomplete-release control                         | 12 reachable memories, including ten retired; retaining callback→instance path found |
| Forced-GC 3×1,000-cycle run                                 | Final JS-live one per run; semantic assertions all pass                              |
| 10,000 passive cycles, late RSS                             | 166.5–196.2 MiB; up to 1,139 mapped stores                                           |
| Last good / first bad workerd                               | 2026-05-05 V8 14.7.173.16 / 2026-05-06 V8 14.8.180                                   |
| 4 MiB touched growth × 2,000-generation storm               | 1,965 MiB peak; 1,749 MiB resident after storm                                       |
| Retire-time ArrayBuffer hint on same storm                  | 481 MiB peak; not a selected default                                                 |
| Production-like 30-second idle probe                        | 359 JS-live memories; RSS 194.96 MiB unchanged                                       |

After 200 passive cycles there were 78 JS-live memories / 77 mapped stores. One GC reduced JS-live to two but left 77 stores mapped; five seconds idle changed nothing; the second GC unmapped to one. The backing-store lag was not present in every bisect build and was not separately bisected.

Pinned workerd produced zero external-memory-pressure mark-compacts; older workerd produced about 150 on the same storm. V8 14.8 removed the atomic external-memory fallback while workerd forces no incremental marking and disables idle tasks. Source inspection plus runtime probes supports that mechanism; attributing every downstream memory effect to one source change remains an inference.

Per-request Layers and healthy re-instantiation produced the same garbage mechanism without traps. Isolate-scoped runtime avoids healthy per-request retirement but does not prevent poisoned-generation storms. Feeding growth through JS ArrayBuffer input produced more GC pressure (425 MiB peak versus guest-internal growth 1,381 MiB). Pressure hints reduced peaks but retained roughly 80–160 MiB additional allocator residue after collection; batched hints were less effective.

## Conclusion

No retired foundation generation was reachable under complete release; two GCs reclaimed its stores. [Decision 0012](../.decisions/0012-workerd-memory-contract.md) closes local retention, specifies unreachability rather than prompt release, and selects isolate-scoped Layers. Large-linear-memory admission, actual Cloudflare limits/recycling, and mitigation measurements remain [DQ8/DQ9](../spec.md#design-questions).

## Intent Impact

Closes the retention question, not release-latency or production admission; avoids a speculative factory fix and default GC hint.

## Limits

No real Cloudflare deploy or upstream issue was executed by W. The subsequent decision authorizes a temporary deployment and generic upstream report; authorization is not an observed result. These are correctness/memory studies under load 45–640, not performance guarantees. Heap snapshots themselves forced GC and left 50–56 MiB allocator residue, so post-snapshot RSS is not used as passive-reclamation evidence. Retired-bytes/rebuild budgets were not measured. Pressure-hint gains are fixture-specific, GC-heuristic-dependent, and untested in production.

## Specification

[Runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).

## Amendment 1

The DQ8/DQ9 references above name the historical split. The refreshed specification consolidates production memory admission and its mitigation evidence under DQ8; this does not resolve production admission or add a production measurement to W. Later local precompiled-module execution in [#1604](https://github.com/overengineeringstudio/effect-utils/pull/1604) and [#1610](https://github.com/overengineeringstudio/effect-utils/pull/1610) proves their exercised runtime behavior, not prompt workerd garbage collection.
