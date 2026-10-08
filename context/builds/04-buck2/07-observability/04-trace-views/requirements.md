# Trace Views Requirements

This subsystem owns the two stored Buck command views, view threshold and cap,
and exact command summaries. It refines BUILD.BUCK.OBS-R05 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUILD.BUCK.OBS.VIEW-A01 Local native evidence:** the event log remains local
  evidence for post-hoc conversion; there is no archived run record or
  on-demand remote regeneration contract.
- **BUILD.BUCK.OBS.VIEW-A02 Query semantics:** consumers query stored spans only —
  a view that was not exported cannot be searched.

## Acceptable Tradeoffs

- **BUILD.BUCK.OBS.VIEW-T01 Both views until measured:** exporting the full view
  everywhere raises measured backend storage volume ~11× versus critical-only; accepted
  by q24 pending measured volume evidence.

## Requirements

- **BUILD.BUCK.OBS.VIEW-R01 Two identified views:** Each locally converted Buck
  command yields a critical and a separate deterministic full view. With
  valid caller context, the critical view nests in its job trace beneath
  the task/command spans, and the full-view root links to its command span.
  Without caller context, the critical view has an independent command
  trace derived from the Buck UUID; its full view is another independent
  trace, with no invented caller link. Both are sent at eligible job/local
  task-run end; a fork retains only its local spool. Neither view is a
  read-time transformation.
- **BUILD.BUCK.OBS.VIEW-R02 Critical view rule:** the critical view retains the
  critical path and its stage children, all spans at or above the view
  threshold, all their ancestors, and exact whole-command summary attributes
  (action, cache-hit, critical-path counts), under a hard **view cap of
  1,200 spans**; the threshold rises only as far as the cap requires (never
  truncation by input order). Default threshold 1 s.
- **BUILD.BUCK.OBS.VIEW-R03 No read-time caps:** consumers see the same stored
  trace; no per-consumer projection at read time (consumers would disagree
  and unstored spans are unqueryable).
- **BUILD.BUCK.OBS.VIEW-R04 Local regenerability:** While its local native event
  log is retained, a command's full view can be regenerated locally. Backend
  retention or spool loss is not repaired by a remote archive.
- **BUILD.BUCK.OBS.VIEW-R05 Command summaries are exact:** both views carry the
  command's exact aggregate counts (actions, cache hits, critical-path
  actions); the cache ratio never depends on retained child spans.
- **BUILD.BUCK.OBS.VIEW-R06 Bounded metric labels (refines BUILD.BUCK.OBS-R05):**
  Canonical OTel metrics are `buck2.command.duration` (s),
  `buck2.critical_path.duration` (s), `buck2.action.count` (unitless),
  `buck2.action.execution.duration` (s), and
  `buck2.action.queue.duration` (s). Labels are closed enums:
  `subcommand`, `category`, `execution_kind`, and `cache_hit`.
  No target, identifier, digest, run id, trace id, or host label appears.
  Local conversion emits these bounded metrics for long-term trends in the consumer-selected metric backend;
  the Prometheus translation is defined once in the [spec](./spec.md).
- **BUILD.BUCK.OBS.VIEW-R07 Dropped children are visible:** retained parents carry
  a dropped-children count; the view never pretends omitted spans are
  queryable.
