# 0002 Durable Ingest, Service Boundary, and Tempo Readback

Status: accepted

Accepted 2026-09-26 (Johannes, q39, q44, q45). Refines [decision 0001](./0001-ingest-parity-and-retention.md) without changing its local/fleet parity or retention split. The [ingest-service bakeoff](../.experiments/2026-09-26-ingest-service-bakeoff.md) records measurements and caveats; [05 spec](../spec.md) is normative.

## Context

Upload alone did not guarantee that a sealed record would quickly become a clickable, complete trace. A crash can occur between durable record placement and enqueue, or after a chunk is accepted but before its checkpoint. Tempo can show duplicate ids after a fast repush and can lose accepted spans in a shared run trace across idle gaps. The same index needed for discovery can hold durable work.

## Evidence and Argument

The [service bakeoff](../.experiments/2026-09-26-ingest-service-bakeoff.md)
found a 2.74 s sequential p95 for the SQLite queue candidate and demonstrated
crash, outage, missed-enqueue and poison recovery. Restate added a second
stateful server and one replay duplicated 1,713 spans; the path unit hit its
start limit. Tempo accepted 6,255 spans but retained 5,232 across idle gaps.

## Decision

- Verify and durably place the upload, then write the record index row and a pending job in **one `index.sqlite` transaction**. Wake a bounded worker immediately; sweep the durable store and index periodically to recover missed enqueues. Lease, retry with capped backoff, and dead-letter failed jobs. Upload returns after durability, not after conversion. Target job end → clickable *complete* trace ≤30 seconds p95 **plus upload time** (q39).
- Build a single Rust `buck2-evidence` BuildProduct in effect-utils `rust/buck2-tools`, with `seal`, `upload`, `ingest`, `serve`, `drain`, `backfill`, and `retention`, sharing the in-process event adapter. The same ingest implementation runs locally and in the service. The resolver is served by the same unit on a **second Unix socket**. Dotfiles owns the hardened unit, archive dataset, retention timer, and two managed Tailscale Services: tailnet-OIDC/capability-gated upload and read-only resolver (q44).
- Checkpoint OTLP chunks. Before replay of a possibly in-flight chunk, read back by deterministic trace id and push only absent spans. Acknowledgement is not completion: read back the expected span ids before switching to `ingested`; retry missing spans deterministically. If completeness cannot be established, keep the explicit `missing_spans` state and count rather than advertising a complete trace (q44/q45).
- Keep the shared per-run caller trace. Dotfiles tunes Tempo live-store idle/live windows above expected inter-job gaps and verifies the isolated repro against fleet Tempo. The [upstream issue](https://github.com/grafana/tempo/issues/8002) records the defect; the ingester still reconciles via readback because gaps can outlast tuning (q45).

## Options

| Option | Outcome | Rationale |
| --- | --- | --- |
| One Rust service, SQLite queue and readback reconciliation | Accepted | One durable index, immediate drain, no second orchestration server |
| Synchronous ingest or polling-only trigger | Rejected | Ties CI completion to conversion or misses the latency target |
| Dedicated Restate server | Rejected | Another stateful server; one server-crash replay duplicated 1,713 spans |
| Shared Hypermerge Restate server | Rejected | Shared lifecycle and resource limits couple unrelated automation |
| systemd path-unit drain | Rejected | Backend outage tripped unit start limit; no automatic recovery |
| Tempo tuning without readback repair | Rejected | Longer gaps can still lose spans silently |
| Per-job traces instead of the shared run trace | Size fallback | Avoids same-ID idle gaps but loses the selected whole-run waterfall |

## Consequences

`index.sqlite` is both resolver index and queue authority. The service must observe queue age, attempts, dead letters, readback deficits, and worker failures. Deterministic content does not itself imply duplicate-free short-window replay; the checkpoint/probe pair is required. The read-only resolver must not share the upload socket or gain queue mutation routes. Experiment latency excludes tailnet upload, which remained unmeasured.

## Amendment 1 — Cumulative Readback and Attempt Closure (q50)

Accepted 2026-09-26 (Johannes; review of PR #1414 and companion fleet PR).
One shared run trace accumulates jobs over time. A successful readback of
only the latest job cannot establish trace completeness: after each later
write, reconcile the **union** of every expected span ID in that trace and
revert an earlier `ingested` record to `missing_spans` if its IDs vanish.
Publishing a complete run trace requires cumulative readback at the same
trace-group generation as the index transition.

The CI finalizer uploads 02's attempt-close record through the normal
uploader. The ingester emits the sole root only after all roster jobs are
ingested or marked missing, with deterministic error spans for absent jobs.
If closure or a listed job remains outstanding, six hours after the last
upload the persisted sweep emits one root and labels the attempt
`incomplete`. Without a roster it cannot infer unobserved jobs or overwrite
that root if closure arrives late. The ≤30-second p95 plus upload target is
for a completed job's full view, not for a run root still in progress.