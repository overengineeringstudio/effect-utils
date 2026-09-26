# Ingest and Archive Spec

This document specifies the ingest pipeline, archive layout, retention, and
the dotfiles contract. It builds on [requirements.md](./requirements.md); its
inputs are sealed run records ([02](../02-run-record/spec.md)) and its
derivations are the adapter's span model ([03](../03-event-log-adapter/spec.md))
and the views ([04](../04-trace-views/spec.md)).

## Status

Draft.

## Scope

**Defines:** the ingest sequence and queue, id derivation, chunking and
readback repair, archive layout and retention, provider-neutral tagging,
and the deployment-ownership boundary.

**Does not define:** backend deployment (dotfiles), the trust-signal adapter
(02), view rules (04), or the resolver presentation (06).

## Ingest Sequence and Identity

```text
seal -> upload socket -> verify -> durable record -> index.sqlite
                                      | same transaction: index + jobs
                                      v
                         worker -> adapter -> OTLP chunks
                                      |         |
                                      +-- checkpoint / by-id readback
                                      v
                         ingested | missing_spans | retry/dead letter
                                      |
                              resolver read socket
```

1. `buck2-evidence seal` captures the provider-neutral VCS change id
   (PR number when present, supplied as environment by the provider adapter)
   and head/base/merge revisions from git at seal time (02's record schema).
   Upload verifies the manifest and every member digest, bounded-decodes
   untrusted records (02), durably stores the record, and commits an
   `uploaded` index row plus a pending `jobs` row in one SQLite transaction.
   The store is durable before the transaction, so a sweep can find records
   whose process died between store placement and enqueue. Repeated uploads
   for the same digest cannot enqueue duplicate work.
2. The immediate worker reads sidecar lines (01), assigns task/command
   nesting, converts event logs through the in-process adapter (03), joins
   daemon wait in the batch, and derives critical/full views plus bounded
   metrics (04). It stamps `cicd.*`/`vcs.*`/`ci.provider`; untrusted runs also
   carry `ci.pr.fork=true`. Local `ingest` uses the same converter and
   uploader path as the service, with endpoints provided by configuration.
3. Persist a plan of expected `(trace_id, span_id)` and OTLP chunks below
   ~3.5 MB; checkpoint each successful chunk. On retry, before re-pushing
   any uncheckpointed/in-flight chunk, read its trace by deterministic id,
   skip spans already present, and only send missing spans. Tempo can retain
   duplicate span ids if the same chunk is re-pushed within ~5 seconds;
   deterministic ids alone do not guarantee duplicate-free replay.
4. After push, fetch each affected trace by id, compare expected span ids
   with returned ids, and selectively re-push missing spans. Do not mark
   `ingested` until readback converges for the view; expose an
   unconverged result as `missing_spans` with counts. Backend search is not
   an acceptance gate. Push bounded metrics to Mimir.
5. The index records VCS identity from the sealed record, the per-view ids,
   archive location, byte count, state, attempts and error. The resolver
   can expose an `ingested` id as a clickable trace, `pending` while work
   remains, and an explicit `missing_spans` state for incomplete readback.

   Resolver-facing status vocabulary is `pending`, `sealed`, `uploaded`,
   `ingesting`, `ingested`, `missing_spans`, `expired`; the queue's
   dead-letter state and last error are separate failure details, not a
   false `ingested` transition. Only `ingested` redirects to a trace.

**View ancestry and trace ids (BUCK.OBS.ING-R02/R06).** With a caller
context the critical view stays in the caller trace: its trace id equals
the caller trace id and `buck2.command` is parented under the pre-derived
command span id from the sidecar. For each Buck UUID `u`, the full-view
trace id is the first 16 bytes of
`SHA-256(UTF-8(u + ":full"))`, rendered as the 32-hex-character OTLP
trace id; its `buck2.command` root links to the caller command span.
Without caller context both views are unparented: the critical-view trace
id is the first 16 bytes of `SHA-256(UTF-8(u + ":critical"))`, and the
full-view trace id uses `:full` as above. Both render as 32 lowercase hex
digits. With caller context its trace encodes pipeline run/attempt identity;
the Buck UUID carries command/job identity. Do not add
repository/run/attempt/job again to the hash input, derive it from the
manifest digest, or call an API to mint it. Record both view ids per
command in the index and summary.

**Worker and recovery (BUCK.OBS.ING-R08/R09).** `index.sqlite` uses WAL;
`jobs` rows track lease, attempt count, next attempt, last error, and
dead-letter state. One service process owns the queue and wakes its sole
ingest worker on commit. Expired leases are reclaimed after restart;
transient failures back off exponentially with a bounded cap, and permanent
decode/validation failures dead-letter rather than blocking other records.
A periodic store/index sweep (10–30 s in the bakeoff) repairs missed
enqueues and due work; `drain` and `backfill` expose operator recovery.
Job end to a clickable complete trace targets ≤30 s p95 plus upload time;
the upload is not held open for conversion. An unconverged trace is never
reported as complete merely to meet the latency target.

## Archive Layout

```text
<evidence-prefix>/<repository>/YYYY/MM/DD/run-<run-id>/attempt-<n>/job-<key>/
  manifest.json        the sealed record's manifest (identity = its sha256)
  metadata.json        run/attempt/event/conclusion (provider-neutral; a
                       provider URL may appear, never required)
  spans/               the span spool, unchanged
  buck2-events/        raw *_events.pb.zst, unchanged
index.sqlite           reconciliation index: (repo, run, attempt, job) ->
                       digest, bytes, sealed VCS fields, per-view trace ids,
                       state, missing count, archive path; jobs + pushes
store/sha256/<digest>/  durable verified upload before archive placement
incoming/              atomic staging for in-progress uploads
```

The `job-<key>` path component keeps every job of one run in its own
directory with its own manifest — two jobs of a run never share or overwrite
an archive path — and matches the index key exactly, so per-job backfill
resolves one row.

## Volume Model

Measured per full CI run: ~3.9 MB sealed record; both views ~61 MB OTLP JSON
(~67 k spans) into Tempo (30 d); raw archive projection ~125 GiB/yr at
~90 runs/day (~351 MB/day) before overhead, inside the ≤150 GiB/yr corridor
budget (BUCK.OBS-R06, per q32 superseding q14's earlier figure) and
re-measured under [OQ1](../../open-questions.md), which also carries the
unmeasured both-views Tempo cost.

## Backend Quirks and Recovery (BUCK.OBS.ING-R09)

- Int-typed attributes do not match TraceQL equality: run ids and attempts
  are pushed as strings.
- Fresh pushes are invisible to attribute search until a block is cut
  (measured ≥22 min): discovery uses indexed ids and by-id readback.
- Large single bodies are rejected by the gateway: chunk below ~3.5 MB.
- Tempo 3.0.3 can acknowledge all 6,255 spans in a shared run trace while
  persisting only 5,232 when jobs arrive in bursts separated by 20 seconds
  and by-id reads occur during the gaps; direct block inspection confirmed
  loss. A 2-minute `max_trace_idle` avoided the isolated reproduction.
  Dotfiles owns tuning live-store idle/live windows above expected inter-job
  gaps and verifying the same repro against fleet Tempo; this does not
  replace readback and selective deterministic repair for longer gaps.
  When repair cannot converge, preserve `missing_spans` and its count.
  The isolated reproduction is filed as [Tempo issue 8002](https://github.com/grafana/tempo/issues/8002).

## Service and Dotfiles Contract (BUCK.OBS.ING-R07/R08)

```text
effect-utils: rust/buck2-tools/buck2-evidence (Buck BuildProduct)
  seal | upload | ingest | serve | drain | backfill | retention
  in-process event adapter; same ingest path on laptop and fleet
dotfiles: one hardened service + two Unix sockets
  upload socket   -> OIDC-gated managed Tailscale upload Service
  resolver socket -> read-only managed Tailscale resolver Service
  archive dataset, index.sqlite, daily retention timer, Tempo tuning
```

`serve` hosts the upload endpoint, one immediately draining worker and sweep,
and read-only resolver routes in one unit. The upload Service checks the
tailnet OIDC identity and application capability before forwarding to the
upload socket; the resolver Service forwards only read routes through its
separate socket and cannot mutate records or queue state. No public TCP
write listener is necessary. Dotfiles owns the dedicated service account,
socket ownership/modes, writable dataset restriction, systemd hardening,
quota/lifecycle and two Service mappings, not the converter or index schema.
The daily `retention` invocation removes raw logs after about a year while
keeping the ≤150 GiB/year planning corridor; retained index metadata
continues to explain expired evidence.

## Conformance

- Parity: one sealed record ingested locally and by the service yields the
  same trace ids and spans; the caller critical trace remains parented and
  the full root links to the caller command span.
- Recovery: concurrent duplicate uploads enqueue once; a crash after store
  placement and before enqueue is swept; a crash mid-push checkpoints
  completed chunks and probes the in-flight chunk before repush, with no
  duplicate span ids on readback.
- Incomplete backend readback never redirects as complete; missing ids are
  selectively repushed and persistent loss shows `missing_spans`.
- Fork ingest: an untrusted-tagged record decodes under caps and carries
  `ci.pr.fork=true`; queries can filter it.
- Evidence: [replay baseline](./.experiments/2026-09-25-ci-to-tempo-replay-baseline.md),
  [ingest bakeoff](./.experiments/2026-09-26-ingest-service-bakeoff.md),
  [decision 0001](./.decisions/0001-ingest-parity-and-retention.md),
  [decision 0002](./.decisions/0002-durable-ingest-and-tempo-readback.md).
