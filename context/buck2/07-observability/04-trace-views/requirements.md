# Trace Views Requirements

This subsystem owns what lands in trace storage and metrics: the trace-view
family (full view, critical view), the view threshold and cap, command
summary attributes, and the bounded metrics set. It refines BUCK.OBS-R05 and
the BUCK.OBS-T02 tradeoff of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.VIEW-A01 Durable full detail:** the run record (and its archive, 05) always retains full detail; views are conveniences over it, never the
  only copy.
- **BUCK.OBS.VIEW-A02 Query semantics:** consumers query stored spans only —
  a view that was not ingested cannot be searched.

## Acceptable Tradeoffs

- **BUCK.OBS.VIEW-T01 Both views until measured:** ingesting the full view
  everywhere raises storage volume ~11× vs the critical view alone; accepted
  by decision q24 ("do this for now, dial in later if issues appear") with
  the measurement plan in [OQ1](../../open-questions.md).

## Requirements

- **BUCK.OBS.VIEW-R01 Two identified views:** Every ingested Buck command is
  exported as two separately identified traces: the **critical view** (the
  default) and the **full view**. Both are always ingested (decision q24);
  neither is a read-time transformation of the other.
- **BUCK.OBS.VIEW-R02 Critical view rule:** the critical view retains the
  critical path and its stage children, all spans at or above the view
  threshold, all their ancestors, and exact full-invocation command summary
  attributes (action, cache-hit, critical-path counts), under a hard **view
  cap of 1,200 spans**; the threshold rises only as far as the cap requires
  (never truncation by input order). Default threshold 1 s.
- **BUCK.OBS.VIEW-R03 No read-time caps:** consumers see the same stored
  trace; no per-consumer projection at read time (consumers would disagree
  and unstored spans are unqueryable).
- **BUCK.OBS.VIEW-R04 Regenerable full detail:** the full view of any
  archived run can be re-derived from its run record on demand (the record,
  not the trace store, is forensic truth).
- **BUCK.OBS.VIEW-R05 Command summaries are exact:** every view carries the
  command's exact aggregate counts (actions, cache hits, critical-path
  actions); the invocation cache ratio never depends on retained child
  spans.
- **BUCK.OBS.VIEW-R06 Bounded metrics (refines BUCK.OBS-R05):** the metrics
  set is the five closed-enum series — `buck2.command.duration`,
  `buck2.critical_path.duration`, `buck2.action.count{category,
execution_kind, cache_hit}`, `buck2.action.execution.duration{category}`,
  `buck2.action.queue.duration{category}` — named per the fleet metrics
  conventions. No target, identifier, digest, run id, build id, or host
  label ever appears.
- **BUCK.OBS.VIEW-R07 Dropped children are visible:** retained parents carry
  a dropped-children count; the view never pretends omitted spans are
  queryable.
