# 0002 Untrusted Runs Ingest Only on an Explicit Trust Signal

Status: accepted

Accepted 2026-09-25 (decision q13; Johannes). Provider-neutral by
construction; the first provider implementation is GitHub's PR label
(livestore prior art). May land as a follow-up if non-trivial.

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

Untrusted runs ingest only when an explicit, provider-level trust signal
authorizes it — on GitHub: a PR label. The signal is consumed by a trusted
adapter that grants a short-lived, write-only upload capability bound to the
exact PR head; the build and the uploader see a generic capability and stay
provider-neutral. Ingested untrusted records are tagged so queries can filter
(the tag is expressed through provider-neutral OTel attributes at ingest; see
[05](../../05-ingest-and-archive/requirements.md)).

## Consequences

- Ordinary fork runs are spool-only: no capability, no upload, no data loss.
- The trust gate lives at the record boundary (02), not in the decoder; the
  decoder's own bounds (BUCK.OBS.REC-R07) are defense in depth.
- One word, three gates: this is _ingest-admission_ trust, distinct from
  otel-scrape's trusted sink (privacy) and 0033's cache tiers (write
  authority).
