# 0001 Run Record Is the System of Record

Status: accepted

Accepted 2026-09-25 (decisions q18 and q20; Johannes), on the CI-agnostic
delivery bakeoff scorecard.

## Context

Telemetry must reach fleet storage from CI runners that cannot join the fleet
network, without the delivery path growing CI-provider coupling (the "CI is
unspecial" principle, BUCK.OBS-R03). Three shapes competed: direct OTLP export
from the runner, a provider-neutral sealed bundle uploaded content-addressed,
and replaying CI-provider artifacts from the fleet host (the earlier B7
baseline).

## Evidence and Argument

- The portable-record prototype sealed a real run's corpus (230 files,
  4.09 MB raw → 3.78 MB tar.zst), uploaded with one provider-neutral PUT, and
  verified every digest after extraction with zero mismatches; backfill is a
  store scan
  ([experiment](../.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md)).
- Direct OTLP fails the durability side today: the shell `otel-span` ignores
  `OTEL_EXPORTER_OTLP_HEADERS` (measured — no Authorization on the wire),
  drops payloads on endpoint failure without a flush protocol, and carries no
  raw event logs for the archive. It works as a _fast path_ later, not as the
  record.
- CI-provider artifact replay measured 10.4 s/run and 8 API requests after
  trigger but couples the trigger, artifact format, retention, and downloader
  to one provider — the baseline, not the target
  ([05 experiment](../../05-ingest-and-archive/.experiments/2026-09-25-ci-to-tempo-replay-baseline.md)).
- The scorecard ranked identical-local/CI-path first, then provider coupling:
  the record scored 5/5 on both; direct OTLP 5/3; replay 1/1.

## Options

| Option                                                                        | Tradeoff                                                                   | Outcome                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| Run record + provider-neutral upload; direct OTLP as optional fast path later | Local/CI parity, backfill, archive in one mechanism; minutes-level latency | Accepted                 |
| Direct OTLP only                                                              | Lowest latency; weak backfill, no raw-log archive, auth/flush gaps         | Rejected as primary      |
| CI-provider artifact replay                                                   | Proven and quick; maximal provider coupling                                | Rejected (baseline only) |

## Decision

The run record — manifest + span spool + native evidence — is the system of
record. Every pipeline run writes the same record locally and in CI; one
provider-neutral `upload` command seals and PUTs it content-addressed; ingest
converts, exports views, and archives (05). Direct OTLP export becomes an
optional low-latency fast path only after `otel-span` supports standard auth
headers and a real flush protocol ([OQ3](../../open-questions.md)). No
CI-provider artifact replay is built.

## Consequences

- effect-utils owns the record format, manifest schema, uploader, and
  deterministic trace ids; the dotfiles fleet config owns the ingester,
  auth front, store ACL/lifecycle, index, and retention timer.
- Fork runs without a trust signal are spool-only by design (see
  [0002](./0002-untrusted-run-trust-signal.md)); no secret reaches an
  untrusted runner.
- The CI span-artifact upload step and any compatibility replay are named
  deletions once the upload path lands (BUCK.OBS.REC-R08).
