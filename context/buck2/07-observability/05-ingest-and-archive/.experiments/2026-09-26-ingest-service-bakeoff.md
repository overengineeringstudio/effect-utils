# Ingest service bakeoff

Date: 2026-09-26. Scratch deployments against Tempo 3.0.3 under variable, sometimes very high machine load. This is non-normative evidence for [decision 0002](../.decisions/0002-durable-ingest-and-tempo-readback.md), not a deployment recipe.

## Question

A Rust upload service with a SQLite jobs table in the existing ingest index, immediate workers, and a reconciliation sweep can meet the job-end → clickable trace ≤30-second p95 target (excluding upload), recover from crashes/outages, and cost less to operate than Restate or a systemd path-triggered drain.

## Method

Compared (B) one Rust process with an upload Unix socket, SQLite WAL index/queue, bounded workers and sweep; (A2) the same upload/index with a separate Restate server and durable handler; (A1) shared Restate server by inspection; and (C) a systemd path-triggered one-shot drain. The common pipeline verified sealed records, converted event logs, chunked OTLP pushes, then compared deterministic expected span ids with trace-by-id readback. The trial corpus had 35 records (27 heavy, 8 light), up to 31,141 spans per record; sequential trials and 30-record bursts were run. Failure probes killed processes mid-push and during a burst, interrupted Tempo for 60 seconds, raced six duplicate uploads, tampered with a record, injected a poison record, and placed a durable record without enqueue. Upload measurements used local Unix sockets, **not** tailnet upload.

## Result

| Candidate             | Sequential p50 / p95                | 30-record burst p95     | Finding                                                                                                   |
| --------------------- | ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| B, SQLite queue       | 2.21 / 2.74 s                       | 16.51 s (three workers) | Recovered tested crashes, outage, missed enqueue and poison cases; zero duplicates with checkpoint/probe. |
| A2, dedicated Restate | 3.30 / 4.71 s                       | 13.64 s                 | 42 journal entries per heavy record; one of two server-crash probes produced 1,713 duplicate spans.       |
| C, path unit          | 3.39 / 5.69 s (20 solo-run records) | Not measured            | Outage retriggered to `unit-start-limit-hit`; no automatic recovery.                                      |
| A1, shared Restate    | Not benchmarked                     | Not benchmarked         | Shared server activation restarts and resource throttling make ownership unsafe.                          |

B's whole-ingest concurrency limit, rather than substrate, explains its slower burst p95; A2 bounded decode but permitted more concurrent pushes/readbacks. Under B, a missed enqueue was swept and ingested in 12.4 seconds, and the outage case completed 4.5 seconds after backend return. Heavy-load measurements are directional, not a fleet latency guarantee. A separate run-trace repro showed Tempo accepted 6,255 spans, but persisted and returned only 5,232 when three job bursts were spaced 20 seconds apart with reads during the gaps. Direct block inspection confirmed the loss; raising live-store `max_trace_idle` to 2 minutes eliminated that isolated reproduction. The service bakeoff also found incomplete shared-run readback on 13/30 records in one burst; this observation predated isolation of the idle/read interaction.

A separate dedup probe pushed the same 87-span chunk twice. At 0, 1, 3, and 5 seconds, readback contained 174 entries (87 distinct ids); at 10, 20, and 40 seconds it contained 87. Disabling the checkpoint/probe guard during a mid-push crash left 852 duplicates; enabling it left none in the tested crash runs. Accepted OTLP writes and deterministic span ids are therefore insufficient evidence of a complete, duplicate-free trace.

The isolated loss is tracked upstream in [Tempo issue 8002](https://github.com/grafana/tempo/issues/8002).

## Conclusion

The SQLite candidate met the measured sequential target and recovered every
tested fault with one process and a single index/queue store. Its 30-record
burst result used three workers, not V1's specified single worker: that
burst does **not** establish the single-worker p95 under production load.
Choose the simpler service over Restate and path-unit orchestration; persist
push checkpoints, probe by id before uncertain repushes, and require complete
readback to publish a clickable trace. Tune Tempo idle/live windows but retain
selective repair and explicit `missing_spans` for failed convergence. The
production tailnet upload time and fleet load remain unmeasured.

## VRS Impact

The [05 spec](../spec.md) specifies atomic enqueue, one immediately draining
worker plus recovery sweep, checkpointed export, and complete readback.
Fleet tuning is owned by the dotfiles observability platform.
