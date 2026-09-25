# CI-agnostic delivery bakeoff (ReplayTrigger track)

Date: 2026-09-25 · Prototypes ran locally in scratch directories (no CI
provider contact, no deployment, no secrets); corpus from the cold-CI capture
run (3 jobs, 15 event logs, 230 files, 3.90 MB source corpus).

## Question

Can the build emit and deliver telemetry through the _same_ path as a local
run, with the CI provider supplying only environment/configuration? Compare:
(1) direct OTLP export from the runner, (2) a portable sealed record uploaded
content-addressed by one provider-neutral command, (3) CI-artifact replay from
the fleet host (the earlier B7 baseline). Scoring priority: identical
local/CI path first, then provider coupling, fork trust, latency,
reliability/backfill, operational cost.

## Method

- Source reads of the current CI telemetry touchpoints (spool setup via CI
  env, job summary, artifact upload, run/job naming) and of the fleet-side
  deployment surface (metrics exporter, observability funnel design,
  collector auth posture) to establish the coupling baseline and what
  dotfiles would own.
- Direct-OTLP probe: the shipped `otel-span` run with CI-like environment
  against a loopback receiver (one run), a 503 endpoint with a spool
  configured (one run), and an `OTEL_EXPORTER_OTLP_HEADERS` auth probe.
- Portable-record probe: seal the 230-file corpus (manifest with per-file
  path/size/SHA-256), compress tar.zst, one content-addressed PUT to a
  loopback receiver, extract and verify all digests.
- Baseline numbers from the B7 replay measurement; livestore's label-gated
  fork lane read as prior art for the trust signal.

## Result

- **Direct OTLP:** exit 0 with one 1,640-byte POST under CI-like env — the
  command path is already identical. But the shipped helper ignores
  `OTEL_EXPORTER_OTLP_HEADERS` (receiver saw zero authorized requests), and a
  503 endpoint with a spool leaves a 571-byte file with no flush protocol.
  No raw event logs for the archive. Latency best (seconds); durability and
  archive worst (1/5).
- **Portable record:** one PUT, 3,775,542 compressed bytes, 230 manifest
  files, zero digest mismatches after extraction. Idempotent by digest;
  backfill = store scan; carries the raw logs for the 1-year archive. Scored
  5/5 on local/CI parity and provider coupling; 4/5 latency (minutes-level).
- **CI-artifact replay:** 10.4 s post-trigger and 8 API requests per run work,
  but trigger, artifact format, retention (14 d), and downloader are all
  provider-specific; extending the existing metrics exporter would conflate
  two responsibilities. 1/5 on both top criteria.
- Scorecard (1–5; coupling reverse-scored): record wins or ties every
  criterion except latency; direct OTLP 5/3 on the top two; replay 1/1.
- Archive design that fell out: a dated, human-navigable evidence layout
  (`YYYY/MM/DD/run-<id>/attempt-<n>/`), digest-named bundle identity, an
  ingest-side reconciliation index, a 365-day raw-log retention timer, and
  spool-retained-until-acknowledged upload semantics (3.90 MB/run measured →
  ~125 GiB/yr at 90 runs/day before overhead).

## Conclusion

Adopt the portable run record as the system of record with one provider-neutral
upload command; keep direct OTLP as an optional fast path only after the
delivery contract gains standard auth-header support and a real flush
protocol; build no CI-artifact replay. Decisive reason: CI should be as
unspecial as local execution — the record gives that property without any
CI-provider artifact API. Confidence: high (working prototypes for both
leading candidates, measured baseline, deployment surface read).

## VRS Impact

Settled [BUCK.OBS.REC-R01..R05](../requirements.md) and
[decision 0001](../.decisions/0001-run-record-system-of-record.md) (q18);
the trust-signal design ([decision 0002](../.decisions/0002-untrusted-run-trust-signal.md),
q13) and the ingest/archive contract (05, q14) build on it. Open lifecycle
details recorded as [OQ5](../../open-questions.md).
