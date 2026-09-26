# 0002 Untrusted Runs Ingest Only on an Explicit Trust Signal

Status: accepted

Accepted 2026-09-25 (decision q13; Johannes). The admission rule is
provider-neutral; q33 deferred the fork implementation in favor of an
initial trusted-run-only, private-network upload path.

## Context

A public repository's fork-PR CI runs produce attacker-controlled telemetry
bytes. Decision 0033 already treats fork code as untrusted for cache tiers;
the same posture must hold for telemetry ingestion, without losing coverage
for genuinely interesting external contributions.

## Evidence and Argument

- Fork runs can upload artifacts under their own token without any secret
  reaching the runner — the trust decision belongs to the _receiver_, not the
  runner.
- Ingested telemetry is data-only poison (misleading or bulky spans), not
  code execution — provided the decoder is bounded (Rust, size caps, no
  shell) and provenance is queryable.
- The livestore label-gated snapshot lane is working prior art: a trusted
  `pull_request_target:labeled` event records authorization without executing
  fork code; the secretless job packages; a trusted validator re-checks the
  live label against the exact PR head (repository, branch, SHA) before
  anything is published — the workflow-run PR association alone was empty for
  forks, so head reconciliation is mandatory.

## Options

| Option                                         | Tradeoff                                                                        | Outcome                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| Ingest tagged, behind an explicit trust signal | Full coverage on demand; query filtering required on the tag                    | Accepted                                |
| Skip fork runs entirely                        | Matches 0033 posture with zero work; no telemetry for external contributors' CI | Rejected by Johannes                    |
| Separate tenant for forks                      | Clean isolation; needs unverified multi-tenancy on the fleet stack              | Not now; revisit if poison becomes real |

## Decision

Untrusted runs may ingest only when an explicit, provider-level trust signal
authorizes it — on GitHub: a PR label. This fork path is deferred, not part of
initial delivery: trusted runs join the private network with ephemeral
federated OIDC identity and use an application-scoped upload capability;
fork runs remain spool-only. When fork admission is added, a trusted adapter
grants a short-lived, write-only capability bound to the exact live PR head;
the build and uploader see a generic capability and stay provider-neutral.
Ingested untrusted records are tagged `ci.pr.fork=true` so queries can filter
(05 stamps the agreed key; its later migration to the OTel CICD key family
is tracked as [OQ4](../../open-questions.md)).

## Consequences

- Initially, ordinary fork runs are spool-only: no capability, no upload,
  no data loss. The deferred path cannot use trusted-run OIDC credentials.
- The trust gate lives at the record boundary (02), not in the decoder; the
  decoder's own bounds (BUCK.OBS.REC-R07) are defense in depth.
- One word, three gates: this is _ingest-admission_ trust, distinct from
  otel-scrape's trusted sink (privacy) and 0033's cache tiers (write
  authority).
