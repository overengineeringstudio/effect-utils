# Event-Log Adapter Spec

This document specifies local post-hoc decoding, schema policy, span model,
and peer-log daemon-wait join. It builds on [requirements.md](./requirements.md)
and feeds [04-trace-views](../04-trace-views/spec.md).

## Status

Draft.

## Scope

**Defines:** local decode pipeline and framing, vendored-schema layout and
bump procedure, fallback, the span model's identity rules, and daemon-wait
attribution over available peer logs.

**Does not define:** view selection rules (04), direct OTLP transport (05),
or the upstream contribution.

## Decode Pipeline

```text
*_events.pb.zst
  -> streaming zstd decode
  -> varint length-delimited records
       record 1: buck.data.Invocation header (command_line_args[0] = writer version)
       2..n:    CommandProgress { BuckEvent | PartialResult | CommandResult }
  -> vendored prost types (data.proto + error.proto + host_sharing.proto
                           + subscription.proto + daemon.proto, ~190 KB)
  -> span model: span tree, v2 names, per-command salted ids,
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
- **Identity:** OTLP span id is the first 8 bytes of
  `sha256("<log-uuid>:<buck-span-id>")` (salting,
  [01](../01-run-identity/spec.md)); local sidecar context supplies the
  caller's job trace and command parent. Without it the adapter derives an
  independent command trace from log identity.
- **Completeness:** the decoded field set is a superset of the `log show`
  JSONL (same bytes, typed); cache-upload results, action digests, execution
  kinds, stage timings, and materialization byte counts all map (per-field
  corpus hit counts recorded in the decode bakeoff).

## Schema Bump Procedure

1. On a Buck version bump: fetch the pinned tag's protos, regenerate.
2. Diff field numbers _and declared types_ against the previous pin
   (the 2026-04 → 2026-08 drift was field-number-additive but retagged
   `did_cache_upload: bool → cache_upload_result: enum` at stable numbers).
3. Decode retained local cross-version fixtures (older writers' logs) and
   truncation fixtures; no remote archive is required.
4. Land regeneration + diff + fixture results as one change.

## Daemon-Wait Join

```text
inputs:  event logs available in the local job at post-hoc conversion
scope:   peers = ConcurrentCommands.trace_ids[] among available logs (exact,
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
ids:     wait span id derived from waiter command key + gap start
         (deterministic; re-joins idempotent)
```

The adapter converts after Buck exits and before job-end OTLP export. A job
may have multiple commands on one daemon; only locally available logs can
contribute producer evidence. A daemon-provided peer trace id absent from the
local batch stays unattributed, with a per-log gap summary. Conversion does
not await an archived record, other CI jobs, or a server-side ingester.

Measured on a 43-log corpus: precision 0.957 / recall 1.0 at 500 ms; P = R =
1.0 at 1 s (six true sub-second waits traded away); ms-level cost inside the
Rust adapter (the Python prototype did 41 logs in 3.0 s). Known blind spot: a
_busy_ waiter (lanes starved while others run) shows no silent gap — only
the upstream dice-hook track can fix that class; it is filed in parallel and
does not gate this design.

## Fallback and Failure Behavior

| Condition                        | Behavior                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| Unknown fields                   | Skip; count bytes/fields per log                                   |
| Framing damage / schema conflict | Trusted local log: matching-binary `buck2 log show` fallback; warn |
| Untrusted fork log               | No external process; retain local log and recorded failure reason  |
| Truncated log (crash)            | Decode readable prefix; mark truncated; infer end semantics        |
| Missing sidecar line             | Independent command trace keyed by log UUID                        |

## Conformance

- Corpus sweep: retained local fixtures decode across writer versions;
  the 15/15 reader×writer cross-matrix stays green on bumps.
- Truncation fixtures: cut logs at 60–69% decode every complete record.
- Join: reproductions for exact (DiceBlock), inferred single-producer,
  multi-producer (causal primary + co-producer link), and negative
  (serial/cached) cases; end-to-end trace readback with the wait span
  parented and linked.
- Evidence: the five bakeoffs below and decisions
  [0001](./.decisions/0001-direct-decode-rust-crate.md)–
  [0003](./.decisions/0003-daemon-wait-at-ingest.md).
