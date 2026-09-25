# Run Record Spec

This document specifies the run record's layout, capture wiring, and
seal/upload lifecycle. It builds on [requirements.md](./requirements.md); the
identity that keys it is [01-run-identity](../01-run-identity/spec.md), and
its conversion/archive at the far end is
[05-ingest-and-archive](../05-ingest-and-archive/spec.md).

## Status

Draft.

## Scope

**Defines:** record contents, spool layout, manifest schema, seal/upload
semantics, and the untrusted-run trust signal.

**Does not define:** the ingester service, object-store deployment, or
retention (05 / dotfiles); decode mechanics (03).

## Record Layout

```text
<spool-dir>/<run-key>/
  manifest.json                 sealed last; the record's content identity is
                                sha256 over the canonical manifest
  spans/<worker>.jsonl          the existing otel-span spool format, unchanged
  buck2/<command>.pb.zst        explicit per-command event-log copies (byte-identical
                                to the default log; the second write costs < 10 ms)
  buck2/<command>.buck-trace-id per-command file holding the Buck trace id
                                (written by the upstream --write-build-id flag)
  buck2/<command>.report        build reports, where produced
```

`run-key` identifies (repository, run, attempt, job) — provider-neutral: the
CI system supplies these as environment/configuration, exactly as a local
run supplies its own.

## Manifest Schema (v1)

```json
{
  "schema": "buck2-run-record/v1",
  "producer": { "converter": "<version>", "sealedAt": "<rfc3339>" },
  "run": {
    "repository": "<owner/name>",
    "runId": "<provider run id>",
    "attempt": 1,
    "event": "push",
    "worker": { "os": "linux", "arch": "x64" },
    "fork": false,
    "trusted": true
  },
  "files": [{ "path": "buck2/171713_build.pb.zst", "bytes": 711142, "sha256": "…" }]
}
```

Every field is provider-neutral; a provider contributes only attribute values.
The manifest never contains hostnames, host paths, usernames, or credentials
(BUCK.OBS.REC-R05), and it never contains trace ids: record identity is the
manifest digest, and trace ids derive from a **pre-manifest identity**
(repository, run, attempt, job, Buck trace id, view kind — see 05), so the
digest cannot depend on them. Discovered trace ids live in the ingest index.

## Lifecycle

```text
write   run begins; spool + capture write concurrently (01 wiring)
seal    at run end: enumerate, digest, freeze manifest; record becomes immutable
upload  content-addressed PUT (<prefix>/sha256/<digest>, conditional create);
        bounded exponential backoff; spool retained until 2xx/409 + local verify
        no credential -> spool-only (a state, not a failure)
ingest  far side (05): convert -> views -> Tempo/Mimir; archive raw record
```

Re-uploads of identical bytes are no-ops by construction; missed uploads are
backfilled by scanning the store's index, not by re-running builds.

## Trust Signal (untrusted runs)

- Ordinary untrusted runs (e.g. public-repo fork PRs) receive no upload
  credential: their record stays local (spool-only), by design.
- Authorization is a provider-level, human-granted signal — on GitHub, a PR
  label — consumed by a _trusted_ adapter that never checks out or executes
  untrusted code. It grants a short-lived, write-only capability bound to the
  exact PR head (repository, branch, SHA re-checked live, per the livestore
  label-gated prior art: association must be reconciled by head identity, not
  by event metadata).
- The uploader and the build remain provider-neutral: they see a generic
  capability, never label syntax. Ingested untrusted records carry
  `ci.pr.fork=true` so queries can filter (05 stamps it;
  BUCK.OBS.REC-R07 bounds the decode).

## Conformance

- Same-record check: a local pipeline run and a CI-shaped run of the same
  command produce structurally identical records modulo attribute values.
- Upload idempotency: two uploads of one sealed record commit once; a
  no-credential run reports spool-only with the record intact.
- Trust: a fork-shaped run without the signal never uploads; with the signal,
  the capability binds to the exact head and a changed head invalidates it.
- Evidence: [delivery bakeoff](./.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md),
  [cold-CI capture](./.experiments/2026-09-24-cold-ci-event-log-capture.md),
  decisions [0001](./.decisions/0001-run-record-system-of-record.md),
  [0002](./.decisions/0002-untrusted-run-trust-signal.md).
