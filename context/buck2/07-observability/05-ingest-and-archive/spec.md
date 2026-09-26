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

1. `buck2-evidence seal` captures the env-supplied VCS change id and git PR
   head/base and separate merge checkout revisions at seal time (02). Upload
   distinguishes `buck2-run-record/v1` job evidence from
   `buck2-attempt-close/v1` attempt closure, verifies each payload and its
   digest, durably stores it, then commits its index row and pending queue
   work in one `index.sqlite` transaction. A sweep can find an object
   whose process died between store placement and enqueue. Identical
   digest uploads do not enqueue duplicate work; conflicting close rosters
   for the same attempt fail visibly.
2. The immediate worker reads sidecar lines (01), assigns task/command
   nesting, converts event logs through the in-process adapter (03), joins
   daemon wait in the batch, and derives critical/full views plus bounded
   metrics (04). It stamps `cicd.*`/`vcs.*`,
   lane-owned `buck2.vcs.merge.revision`, and `ci.provider`; untrusted
   runs also carry `ci.pr.fork=true`. Local `ingest` uses the same converter
   and uploader path as the service, with endpoints provided by configuration.
3. Persist a plan of expected `(trace_id, span_id)` and OTLP chunks below
   ~3.5 MB; checkpoint each successful chunk. On retry, before re-pushing
   any uncheckpointed/in-flight chunk, read its trace by deterministic id,
   skip spans already present, and only send missing spans. Tempo can retain
   duplicate span ids if the same chunk is re-pushed within ~5 seconds;
   deterministic ids alone do not guarantee duplicate-free replay.
4. After every push into a shared trace, fetch by ID and compare against
   the **union** of expected `(trace_id, span_id)` pairs contributed by all
   jobs in that attempt plus its eventual root and synthetic missing-job
   spans. Recheck the entire union after later job/root writes and once
   more at the index-state publication boundary. Persist a trace-group
   generation with the expected set; the transition to `ingested` succeeds
   only if the readback covered that same generation. If older spans vanish
   after a later write, revert their formerly `ingested` job records to
   `missing_spans`, selectively re-push missing IDs, and keep the run trace
   pending until the aggregate converges. A successful later job alone can
   never make the shared run trace complete. Backend search is not an
   acceptance gate. Push bounded metrics to Mimir.
5. The index records sealed VCS identity, per-view ids, archive location,
   byte count, state, attempts, error, attempt-close roster and trace-group
   expected IDs/generation. Full job views can be clicked after their own
   complete readback, under the job-end ≤30 s p95 plus upload target; the
   shared run trace remains explicitly pending until attempt closure and
   cumulative readback. A missing job is reported even if its trace has
   synthetic error spans.

   Resolver-facing states include `pending`, `sealed`, `uploaded`,
   `ingesting`, `ingested`, `missing_spans`, `incomplete`, `expired`. The
   queue dead-letter and last error are separate failure details. Only a
   view verified as `ingested` redirects as complete; the shared trace
   cannot inherit a completed job view's status.

## Attempt Completion (BUCK.OBS.ING-R10)

```text
job records -> durable index -> close roster -> expected jobs accounted for
                                  └─ missing evidence -> error job spans
                              -> one CI root -> cumulative readback
no close or unsettled roster -> ~6 h after last upload -> incomplete root
```

The final CI job depends on all work jobs and always uploads 02's
attempt-close record through the normal uploader. Store their expected
matrix-qualified job keys and conclusions with the attempt, separately
from per-job evidence.

Do not infer a missing record merely because the close record arrives before
a delayed job upload. A `skipped`/`cancelled` job known not to have executed
can be marked missing immediately; a listed job with unknown upload outcome
remains pending until it arrives or the persisted deadline expires. Once
every listed job is ingested or marked missing, emit each missing job's
deterministic error span and exactly one root bounded by known run/job times
and close time. Keep the provider conclusion and evidence outcome separately:
a success conclusion cannot hide absent evidence. Checkpoint root identity
and completion in the durable queue/index state to prevent duplicate roots.

If no close record arrives **or** a listed job remains unaccounted for, the
sweep closes the attempt approximately six hours after its **last** upload.
With a roster, mark outstanding listed jobs missing and synthesize their
error spans; without one, synthesize only known jobs and never invent a
complete inventory. Emit one root and mark the attempt `incomplete`. A
close/job record arriving after timeout is retained as late evidence but
cannot rewrite the already-published root; the attempt stays visibly
incomplete for review. Restart preserves the deadline rather than resetting
the idle timer. Job-specific full views remain discoverable meanwhile.

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
Job end to a clickable **job full-view** trace targets ≤30 s p95 plus
upload time; the shared run trace stays pending until attempt closure.
An unconverged trace is never reported as complete merely to meet the
latency target.

## Archive Layout

```text
<evidence-prefix>/<repository>/YYYY/MM/DD/run-<run-id>/attempt-<n>/job-<key>/
  manifest.json        the sealed record's manifest (identity = its sha256)
  metadata.json        run/attempt/event/conclusion (provider-neutral; a
                       provider URL may appear, never required)
  spans/               the span spool, unchanged
  buck2-events/        raw *_events.pb.zst, unchanged
<evidence-prefix>/<repository>/YYYY/MM/DD/run-<run-id>/attempt-<n>/
  attempt-close.json  optional CI roster/conclusions, content-addressed
index.sqlite           job records: (repo, run, attempt, job) -> digest,
                       bytes, sealed VCS fields, per-view ids and status;
                       attempts: close digest, expected jobs/conclusions,
                       last-upload/deadline, completion, trace-group generation;
                       jobs + push checkpoints + expected span ids
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
- Shared trace regression: ingest two jobs into one run trace, observe a
  complete first job, then lose one of its spans on the second upload. The
  union readback reverts first-job status to `missing_spans` and `/t/<id>`
  never advertises the shared run as complete until it converges.
- Attempt closure: a failed job without an upload appears as a synthetic
  error span after close; if closure or a listed job remains outstanding,
  the restart-safe six-hour last-upload timer emits one root and
  `incomplete`, never a duplicate root.
- Incomplete backend readback never redirects as complete; missing ids are
  selectively repushed and persistent loss shows `missing_spans`.
- Future fork ingest, when separately authorized: an untrusted-tagged record
  decodes under caps and carries `ci.pr.fork=true`; queries can filter it.
- Evidence: [replay baseline](./.experiments/2026-09-25-ci-to-tempo-replay-baseline.md),
  [ingest bakeoff](./.experiments/2026-09-26-ingest-service-bakeoff.md),
  [decision 0001](./.decisions/0001-ingest-parity-and-retention.md),
  [decision 0002](./.decisions/0002-durable-ingest-and-tempo-readback.md).
