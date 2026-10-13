# Decision: Honest workerd retirement and memory admission

## Status

Status: accepted

## Context

Current-round q31–q34 refine the original reclamation gate. Reachability, GC timing, backing-store unmapping, and production memory limits are different questions.

## Decision

Close the local retention question: **retirement guarantees unreachability, not prompt release**. Use an isolate-scoped runtime Layer on workerd, reused across requests. Keep memory admission open for large-linear-memory products pending actual Cloudflare behavior and mitigation measurements.

Do not ship the ArrayBuffer pressure hint or retired-bytes budget as defaults. A temporary Cloudflare deployment experiment and a generic public upstream workerd issue are authorized; authorization is not evidence that either happened.

## Evidence and Argument

[W](../.experiments/w-workerd-memory.md) heap snapshots found only live generations; a positive retention control found 12 reachable memories and its retaining path. Two GCs unmapped retired stores. The workerd regression bisects to 2026-05-06 / V8 14.8; a 4 MiB-growth × 2,000-generation storm peaked at 1,965 MiB and retained 1,749 MiB after the run. There is no idle collection. A pressure hint reduced that peak to 481 MiB but relies on GC heuristics and leaves allocator residue.

## Options

| Option                                     | Tradeoff                                                 |
| ------------------------------------------ | -------------------------------------------------------- |
| Close leak, keep admission open (selected) | Accurate guarantee without hiding resident-memory hazard |
| Close all memory admission                 | Unsupported by production evidence                       |
| Per-request Layer                          | Creates retired generations even on healthy requests     |
| Pressure hint default                      | Lower observed peak, heuristic coupling and residue      |
| Retired-bytes budget default               | Bounds rebuilding by losing availability; not measured   |

## Consequences

Isolate scope avoids gratuitous retirement, not poison-storm accumulation. No host-controlled prompt reclamation guarantee is advertised. DQ8 asks for production observations; DQ9 measures optional mitigations. Local functional/workerd or snapshot proof alone does not admit large-linear-memory products.

## Specification

[Runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16) and [DQ8/DQ9](../spec.md#design-questions).

## Amendment 1

The remaining large-linear-memory admission question is consolidated under DQ8, including production Cloudflare observations and any optional mitigation measurements. The former DQ9 mitigation question is retired as a separate spec entry, not resolved by shipping a pressure hint or retired-bytes budget. The original reachability guarantee, isolate-scoped Layer, and absence of prompt-reclamation claims remain unchanged. See [the current design questions](../spec.md#design-questions); local evidence alone still does not establish production memory admission.
