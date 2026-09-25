# Event-Log Adapter Spec

This document specifies the adapter's decode pipeline, schema policy, span
model, and daemon-wait join. It builds on [requirements.md](./requirements.md);
what it consumes is [02-run-record](../02-run-record/spec.md) and what it
feeds is [04-trace-views](../04-trace-views/spec.md).

## Status

Draft.

## Scope

**Defines:** decode pipeline and framing, vendored-schema layout and bump
procedure, fallback, the span model's identity rules, and the daemon-wait
join algorithm.

**Does not define:** view selection rules (04), ingest transport (05), the
upstream contribution itself (tracked, not gated).

## Decode Pipeline

```text
*_events.pb.zst
  -> streaming zstd decode
  -> varint length-delimited records
       record 1: buck.data.Invocation header (command_line_args[0] = writer version)
       2..n:    CommandProgress { BuckEvent | PartialResult | CommandResult }
  -> vendored prost types (data.proto + error.proto + host_sharing.proto
                           + subscription.proto + daemon.proto, ~190 KB)
  -> span model: span tree, v2 names, per-invocation salted ids,
     in-band critical_path2 / slowest_path from BuildGraphExecutionInfo
  -> truncation: stop at last complete record; flag `truncated`
```

Performance envelope (measured on the largest fleet CI log, 711 KB
compressed / 12,622 spans): 42 ms wall / 13.7 MB RSS streaming decode — at
the zstd floor, ~165 MB/s warm, batchable (22 logs in 343 ms in one process),
2.5 MB static-linked binary depending only on libc/libgcc. The fallback
(`log show`) costs 59 ms but pins a 136 MB Buck binary and re-keys with the
_reader's_ proto (a measured misrendering hazard), so it is fallback-only.

## Span Model

- **Names (v2):** `buck2.command <subcommand>`, `buck2.action <category>`,
  `buck2.stage <executor stage>`, `buck2.materialization`, plus
  `buck2.critical_path=true` membership attributes and instant error events.
- **Identity:** OTLP span id = `sha256("<log-uuid>:<buck-span-id>")[:16]`
  (salting, [01](../01-run-identity/spec.md)); trace id and parent come from
  the sidecar / task nesting; the adapter never invents identity.
- **Completeness:** the decoded field set is a superset of the `log show`
  JSONL (same bytes, typed); cache-upload results, action digests, execution
  kinds, stage timings, and materialization byte counts all map (per-field
  corpus hit counts recorded in the decode bakeoff).

## Schema Bump Procedure

1. On a Buck version bump: fetch the pinned tag's protos, regenerate.
2. Diff field numbers _and declared types_ against the previous pin
   (the 2026-04 → 2026-08 drift was field-number-additive but retagged
   `did_cache_upload: bool → cache_upload_result: enum` at stable numbers).
3. Replay the cross-version corpus (older writers' logs; the fleet keeps
   them in the archive) and the truncation fixtures.
4. Land regeneration + diff + corpus results as one change.

## Daemon-Wait Join

```text
inputs:  all logs of one pipeline run (the run record guarantees the batch)
scope:   peers = ConcurrentCommands.trace_ids[] from each log (exact,
         daemon-provided); time-overlap is never the default scope
exact:   a DiceBlockConcurrentCommand span covering a gap -> emit the wait
         with the event's own current_active_trace_id as owner
inferred: gap (default >= 1 s; 500 ms opt-in) in waiter W with no W-owned
         action inside; candidate producers = peer actions overlapping the
         gap, identity absent from W, ending within 10 ms of wake-up;
         primary = the causal end (<= wake-up, closest), others co-producers
tiers:   exact <= 0.1 ms alignment · high <= 1 ms · medium <= 10 ms
always:  gap summary attributes on the command span (count, total ms, max ms)
         — the per-log floor that needs no batch
ids:     wait span id derived from waiter invocation key + gap start
         (deterministic; re-joins idempotent)
```

Measured on a 43-log corpus: precision 0.957 / recall 1.0 at 500 ms; P = R =
1.0 at 1 s (six true sub-second waits traded away); ms-level cost inside the
Rust adapter (the Python prototype did 41 logs in 3.0 s). Known blind spot: a
_busy_ waiter (lanes starved while others run) shows no silent gap — only
the upstream dice-hook track can fix that class; it is filed in parallel and
does not gate this design.

## Fallback and Failure Behavior

| Condition                        | Behavior                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| Unknown fields                   | Skip; count bytes/fields per log (recorded data loss)          |
| Framing damage / schema conflict | Fall back to `buck2 log show` with the matching binary; alert  |
| Truncated log (crash)            | Decode readable prefix; mark truncated; inferred end semantics |
| Missing sidecar line             | Independent trace keyed by the log's own uuid                  |

## Conformance

- Corpus sweep: every archived log decodes with zero errors across writer
  versions; the 15/15 reader×writer cross-matrix stays green on bumps.
- Truncation fixtures: cut logs at 60–69% decode every complete record.
- Join: reproductions for exact (DiceBlock), inferred single-producer,
  multi-producer (causal primary + co-producer link), and negative
  (serial/cached) cases; end-to-end trace readback with the wait span
  parented and linked.
- Evidence: the five bakeoffs below and decisions
  [0001](./.decisions/0001-direct-decode-rust-crate.md)–
  [0003](./.decisions/0003-daemon-wait-at-ingest.md).
