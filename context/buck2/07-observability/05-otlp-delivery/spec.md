# OTLP Delivery Spec

This document specifies the direct OTLP delivery and local retry path. It builds on [requirements.md](./requirements.md); [01](../01-run-identity/spec.md) defines trace identity, [02](../02-local-spool/spec.md) captures native evidence, [03](../03-event-log-adapter/spec.md) decodes it, and [04](../04-trace-views/spec.md) shapes exported views and metrics.

## Status

Draft.

## Scope

**Defines:** producer-side OTLP batch formation, late tailnet join, direct export to dev3 Alloy, local retry and failure behavior.

**Does not define:** a record manifest, upload endpoint, ingest worker, archive, SQLite index, resolver, Tempo readback, or fleet backend deployment.

## Job-End Delivery (BUCK.OBS.ING-R01/R08)

```text
job build + Buck native evidence
  -> 03 decode -> 04 Buck views + bounded metrics
  -> #1477 join task/command/critical spans into the one job trace
  -> persist OTLP batches in local retry spool
  -> trusted CI: late tailnet join -> single job-end export burst
                          OTLP/HTTP -> dev3 Alloy :4318 -> Tempo/Mimir
     forks or unreachable endpoint: keep local spool; do not export
attempt close: CI finalizer -> pipeline-run link trace -> same delivery path
```

The CI workflow joins the tailnet **after** build work and span joining, immediately before export. Joining before build can change DNS/routes and break Buck; [the observed upload-mode incident](https://github.com/overengineeringstudio/effect-utils/actions/runs/36452247266) motivates the late join. A single burst means one export phase per completed job, possibly several bounded HTTP requests; it is not a per-task streaming export or a repeated workflow step. A retry of failed chunks is recovery from that phase, not another capture/conversion run. At attempt close, the always-run finalizer depends on work jobs and emits the deterministic pipeline-run root with links to known job roots; it does not need their artifacts or native evidence.

The endpoint is a configured tailnet-reachable dev3 Alloy OTLP/HTTP receiver at port 4318. POST trace and metric payloads to the standard OTLP/HTTP `/v1/traces` and `/v1/metrics` routes; preserve OTLP trace IDs and span IDs from 01/04. Split serialized payloads into requests below the observed ~3.5 MB collector body limit; splitting must not alter span ancestry or metric labels. Dotfiles configures Alloy and ACL; endpoint addresses never enter portable trace attributes or fixtures. In CI, `CI_EVIDENCE_MODE=upload` selects export for same-repo PR and main jobs, which reach the endpoint under their tailnet ACL; any other value spools only. Ordinary forks receive no such access and remain spool-only. Local runs export when the configured endpoint is reachable on the tailnet and otherwise spool. No CI-provider artifact, GitHub API, upload service, or public ingress carries telemetry.

## Local Retry (BUCK.OBS.ING-R03/R09)

```text
encoded OTLP chunk: write durable local pending bytes -> send -> acknowledge
                                       failure/ambiguous response -> retain
restart/retry: read retained bytes -> resend -> acknowledge -> release chunk
```

The producer persists a self-contained chunk before its first send,
including OTLP signal type, byte count, destination configuration reference,
and stable local identity; endpoint credentials do not enter the spool.
An HTTP 2xx response acknowledges a chunk only after decoding its
signal-specific OTLP response body and confirming absent or zero
`partial_success.rejected_spans` / `partial_success.rejected_data_points`.
A malformed or unreadable response is ambiguous and leaves the chunk pending.
Any nonzero rejection keeps the **whole original chunk** pending, reports
the rejected count/message locally and retries with bounded backoff; it
cannot silently discard rejected data. Network failure, timeout, server
rejection, lost acknowledgement, missing endpoint and tailnet admission
failure also retain the chunk. Permanent errors surface locally without
changing the Buck result. Retries resend the same bytes, preserving trace
and span IDs rather than minting new identity. Already accepted spans (or
metric points) may be duplicated after a partial acceptance or ambiguous
acknowledgement: deterministic IDs keep span identity stable but do not
guarantee Tempo deduplication. Local spool lifetime bounds recovery. No
server-side queue, readback repair, reconciliation sweep, or status backed
by Tempo queries exists.

## Identity, Attributes, and Retention (BUCK.OBS.ING-R02/R04/R05/R06/R10)

Each job exports exactly one job trace (a local invocation exports its
local equivalent). Its root carries `cicd.pipeline.run.id`; task spans,
Buck command spans, and seeded critical-view spans nest inside it rather
than forming separate per-task traces. The close root links started jobs'
derived root identities with unverified links. Full-view roots link to the
caller command span and use the `SHA-256(UTF-8(Buck UUID + ":full"))`
first-16-byte trace ID (04). Without caller context, 04's independent
command trace applies. These IDs can be computed without backend search or
an index. Run IDs and attempts are **strings** in OTLP attributes because
integer-typed fields were not reliably searchable with TraceQL. The producer
carries available `cicd.*`, `vcs.*`, `buck2.vcs.merge.revision`,
`ci.provider` and `ci.pr.fork` attributes; fork traces are not exported
under current admission. Metric labels stay bounded as required by 04,
never run IDs or revisions.

Tempo keeps traces for 30 days; Mimir keeps bounded trend metrics under fleet policy. There is no one-year native-log archive. When the producer's local spool is gone, this specification promises neither trace replay nor reconstruction from another host. Tempo search lag is a UI/search property, not an exporter acceptance gate; by-ID visibility also cannot be inferred from an HTTP success.

## Ownership and Conformance

| Owner        | Contract                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| effect-utils | Buck capture, adapter, views, batch encoder, local pending spool, and direct OTLP retry                                 |
| dotfiles     | Alloy tailnet :4318 ACL/routing and Tempo/Mimir retention                                                               |
| CI adapter   | Job-end late join and one export phase; always-run attempt-close trace; no fleet read permission for comment generation |

- A trusted PR job that completes Buck then joins the tailnet sends its single job trace (with nested task and command spans) plus linked full views in one bounded burst; a fork sends none and leaves pending bytes locally.
- A 2xx response with `partial_success.rejected_spans > 0` (or
  `rejected_data_points > 0` for metrics) retains the whole chunk and
  reports the rejected count. Retrying sends identical bytes/IDs; the
  accepted portion may duplicate. A zero-rejection response acknowledges
  the chunk; neither outcome changes the Buck result.
- A job root is discoverable by `cicd.pipeline.run.id`; the attempt-close
  root links started jobs' derived root IDs as unverified locators, without
  fabricating unstarted jobs or merging all jobs into one trace.
- The historical experiments and decisions remain evidence, superseded where amended: [replay baseline](./.experiments/2026-09-25-ci-to-tempo-replay-baseline.md), [ingest bakeoff](./.experiments/2026-09-26-ingest-service-bakeoff.md), [0001](./.decisions/0001-ingest-parity-and-retention.md), [0002](./.decisions/0002-durable-ingest-and-tempo-readback.md). The [q18 delivery bakeoff](../02-local-spool/.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md) records the earlier bundle choice that [root decision 0004](../.decisions/0004-tempo-only-delivery-and-job-report.md) supersedes.
