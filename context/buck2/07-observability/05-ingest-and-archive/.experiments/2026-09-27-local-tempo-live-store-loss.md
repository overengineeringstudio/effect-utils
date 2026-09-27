# Local Tempo Live-Store Loss

## Observation

A local `pipeline-run -- devenv tasks run buck2:quick` exited successfully, sealed its evidence record, and completed one-shot `ingest --local` with immediate readback. Its critical trace `e07f75ee9d6124e46a23c274fe2510a2` had 784 expected span ids (16 spooled spans plus 768 converted Buck action spans). Later by-id inspection found only 18: the 16 spooled spans and two independently exported spans. The same run's full-view trace `318b5d661d705ac319f8a6f7a6f9da05` retained 13,810 spans. Immediate readback therefore did not prove persistence after the local ingester exited.

An on-fleet Tempo 3.0.3 spaced-burst replay sent 6,255 spans across gaps of 20 seconds. Subsequent by-id readback found 5,232, losing 1,023 middle-burst tail spans. A no-read control retained 6,036 of 6,255, so reads are not a necessary condition for loss. A two-minute `max_trace_idle` avoided the earlier isolated reproduction; fleet tuning remains owned by dotfiles and must be measured before deployment. Fleet block-scan tools could not resolve either of the recent E2E traces, so they do not confirm a durable block count. Upstream report: [grafana/tempo#8002](https://github.com/grafana/tempo/issues/8002).

## Decision and Boundary

For a tailnet local run with an evidence upload endpoint, use the same durable service as CI: upload the sealed record and one-job local attempt-close. The entrypoint writes the local root only into its job spool. The service treats the close as a declaration that the root is carried by that record, ingests it once, then periodically verifies the whole run trace and repairs missing record spans. It must never independently synthesize a second root. If no endpoint is configured or upload fails, retain the spool, log the failure, and fall back to one-shot local ingest; this offline path remains best-effort against later Tempo loss. Neither path changes the child command's exit status.

This evidence describes observed behavior, not a guarantee that every loss is caused by `max_trace_idle`. The scratch replay audited HTTP success but not OTLP `partialSuccess` bodies; a collector rejection is not ruled out for the no-read control. An HTTP-successful push and a momentary by-id readback are insufficient completion criteria; persisted cumulative readback and explicit missing-span status remain necessary.
