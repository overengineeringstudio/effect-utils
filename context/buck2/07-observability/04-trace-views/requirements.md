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
  neither is a read-time transformation of the other. With a caller
  context, the critical view lives in the caller's trace and the full view
  is a separate deterministic trace whose root links to the caller command
  span (placement per [05](../05-ingest-and-archive/requirements.md)
  ING-R02).
- **BUCK.OBS.VIEW-R02 Critical view rule:** the critical view retains the
  critical path and its stage children, all spans at or above the view
  threshold, all their ancestors, and exact whole-command summary attributes
  (action, cache-hit, critical-path counts), under a hard **view cap of
  1,200 spans**; the threshold rises only as far as the cap requires (never
  truncation by input order). Default threshold 1 s.
- **BUCK.OBS.VIEW-R03 No read-time caps:** consumers see the same stored
  trace; no per-consumer projection at read time (consumers would disagree
  and unstored spans are unqueryable).
- **BUCK.OBS.VIEW-R04 Regenerable full detail:** the full view of any
  archived run can be re-derived from its run record on demand (the record,
  not the trace store, is forensic truth).
- **BUCK.OBS.VIEW-R05 Command summaries are exact:** every view carries the
  command's exact aggregate counts (actions, cache hits, critical-path
  actions); the cache ratio never depends on retained child spans.
- **BUCK.OBS.VIEW-R06 Bounded metric labels (refines BUCK.OBS-R05):** the
  canonical metric names are the OTel dotted forms with units —
  `buck2.command.duration` (s), `buck2.critical_path.duration` (s),
  `buck2.action.count` (unitless), `buck2.action.execution.duration` (s),
  `buck2.action.queue.duration` (s) — with closed-enum labels
  (`subcommand`; `category`, `execution_kind`, `cache_hit`). The
  Prometheus/Mimir translation (`buck2_command_duration_seconds`,
  `buck2_critical_path_duration_seconds`, `buck2_action_count_total`,
  `buck2_action_execution_duration_seconds`,
  `buck2_action_queue_duration_seconds`) is stated once in the
  [spec](./spec.md). No target, identifier, digest, run id, trace id, or
  host label ever appears.
- **BUCK.OBS.VIEW-R07 Dropped children are visible:** retained parents carry
  a dropped-children count; the view never pretends omitted spans are
  queryable.
