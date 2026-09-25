# Ingest and Archive Spec

This document specifies the ingest pipeline, archive layout, retention, and
the dotfiles contract. It builds on [requirements.md](./requirements.md); its
inputs are sealed run records ([02](../02-run-record/spec.md)) and its
derivations are the adapter's span model ([03](../03-event-log-adapter/spec.md))
and the views ([04](../04-trace-views/spec.md)).

## Status

Draft.

## Scope

**Defines:** the ingest sequence, id derivation, chunking, archive layout and
retention, provider-neutral tagging, and the deployment-ownership boundary.

**Does not define:** backend deployment (dotfiles), the trust-signal adapter
(02), view rules (04).

## Ingest Sequence

```text
sealed run record (content-addressed store or local path)
  1. verify manifest digests; bounded decode (untrusted records: 02 rules)
  2. read sidecar lines (01); assign task/command nesting
  3. decode event logs (03) -> span model + daemon-wait join (batch-scoped)
  4. derive views + metrics (04); trace ids = f(record identity) only
  5. push OTLP traces in chunks < ~3.5 MB; push bounded metrics to Mimir
  6. stamp provider-neutral run attributes (cicd.* / vcs.* / ci.provider)
  7. archive raw record + write index rows; record trace ids for discovery
```

Steps 2–7 are identical locally and on the fleet dev host: the same binary,
the same code path, environment supplying only endpoints (BUCK.OBS-ING-R01 /
BUCK.OBS-R03). Re-ingesting the same record reproduces byte-identical traces
(measured ×3 at the span-id level in the replay baseline below).

## Archive Layout

```text
<evidence-prefix>/<repository>/YYYY/MM/DD/run-<run-id>/attempt-<n>/
  manifest.json        the sealed record's manifest (identity = its sha256)
  metadata.json        run/attempt/event/conclusion (provider-neutral; a
                       provider URL may appear, never required)
  spans/               the span spool, unchanged
  buck2-events/        raw *_events.pb.zst, unchanged
index.sqlite           reconciliation index: (repo, run, attempt, job) ->
                       bundle digest, byte count, trace ids, ingest status,
                       archive path
incoming/              atomic staging for in-progress ingests
```

Retention timer: removes raw event logs older than 365 days (then optional
normalized copies), skips `incoming/` and active manifests, reports bytes and
files removed, keeps tombstone rows at the boundary. A daily reconciliation
compares index rows with the filesystem and marks missing bundles — the index
never becomes authoritative over the store.

## Volume Model

Measured per full CI run: ~3.9 MB sealed record; both views ~61 MB OTLP JSON
(~67 k spans) into Tempo (30 d); raw archive ~125 GiB/yr at 90 runs/day
before overhead — inside the ≤115 GiB/yr corridor budget at the raw-log line
item, with the both-views Tempo cost unmeasured
([OQ1](../../open-questions.md)).

## Backend Quirks (designed around)

- Int-typed attributes do not match TraceQL equality: run ids and attempts
  are pushed as strings.
- Fresh pushes are invisible to attribute search until a block is cut
  (measured ≥ 22 min; trace-by-id works immediately): discovery uses the
  recorded deterministic ids.
- Large single bodies are rejected by the gateway: chunk below ~3.5 MB.

## Dotfiles Contract

| Concern                                                                                       | Owner                 | This tree supplies           |
| --------------------------------------------------------------------------------------------- | --------------------- | ---------------------------- |
| Ingest binary + converter + id rules                                                          | effect-utils          | the adapter crate, this spec |
| Ingester service/schedule, auth front, store ACL/lifecycle, index deployment, retention timer | dotfiles fleet config | layout + semantics above     |

## Conformance

- Parity: one record ingested from a laptop and from the fleet dev host
  yields identical trace ids and spans.
- Idempotency: three consecutive ingests of one record return stable span
  counts with no duplicates.
- Fork ingest: an untrusted-tagged record decodes under caps and carries the
  trust marker; queries can filter it.
- Evidence: [replay baseline](./.experiments/2026-09-25-ci-to-tempo-replay-baseline.md),
  [delivery bakeoff](../02-run-record/.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md),
  [decision 0001](./.decisions/0001-ingest-parity-and-retention.md).
