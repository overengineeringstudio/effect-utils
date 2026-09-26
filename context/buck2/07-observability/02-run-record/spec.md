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

`run-key` identifies (`PIPELINE_RUN_ID`, matrix-qualified job key) using
the [pre-manifest grammar](../01-run-identity/spec.md): the same
provider-neutral identity is available locally and in CI. Encode both
components for the spool directory rather than using their slash-bearing
wire values as path segments. A repeated matrix job name with different
dimensions never shares a record or span identity.

## Manifest Schema (v1)

```json
{
  "schema": "buck2-run-record/v1",
  "producer": { "converter": "<version>", "sealedAt": "<rfc3339>" },
  "run": {
    "repository": "<owner/name>",
    "pipelineRunId": "ci/forge/repo%2Fmodule/421/2",
    "runId": "421",
    "attempt": 2,
    "jobKey": "<matrix-qualified job key>",
    "event": "pull_request",
    "worker": { "os": "linux", "arch": "x64" },
    "fork": false,
    "trusted": true
  },
  "vcs.change.id": "1401",
  "vcs.ref.head.revision": "<40-hex head commit>",
  "vcs.ref.base.revision": "<40-hex base commit>",
  "mergeRevision": "<40-hex merge checkout commit>",
  "files": [{ "path": "buck2/171713_build.pb.zst", "bytes": 711142, "sha256": "…" }]
}
```

Every field is provider-neutral; a provider contributes only attribute values.
The adapter supplies `vcs.change.id` (the PR number, if present) via the
environment. At seal time, git resolves `vcs.ref.head.revision` and
`vcs.ref.base.revision` from the checkout's PR head/base refs (for a merge
checkout, second and first parents respectively). The repository-local
manifest field `mergeRevision` comes from the checked-out merge commit;
the ingest index carries it as `merge_revision`. No OTel semantic-convention
key is asserted for merge revision. For a non-PR checkout, absent
change/base/merge facts are omitted rather than inferred from a provider
API; the checked-out commit is the head revision. The manifest and the
ingest index both carry these facts; a provider run's PR association may
be empty and cannot serve as the recovery source.

The manifest never contains hostnames, host paths, usernames, or credentials
(BUCK.OBS.REC-R05), and it never contains trace ids: record identity is the
manifest digest. Trace ids derive from the pre-manifest
[`PIPELINE_RUN_ID` and command identity](../01-run-identity/spec.md), not
the digest; discovered trace ids live in the ingest index. The Buck wrapper
UUID itself derives from caller trace and command span before sealing.

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

- Initial delivery is for trusted runs only. Trusted CI joins the private
  network ephemerally via federated OIDC and writes to an authenticated
  service with an application-scoped capability; the uploader still accepts
  only a generic destination and credential. There is no public upload
  ingress in this initial mode.
- Fork ingestion is deferred, not silently authorized by a PR label today.
  Ordinary fork runs receive no upload credential and remain spool-only.
  When enabled, a trusted adapter may grant a short-lived write-only
  capability after a provider-level, human-granted signal (on GitHub, a PR
  label). The trusted adapter never checks out or executes untrusted code
  and rechecks the exact live PR head (repository, branch, SHA) before
  granting the capability. Fork runners cannot use the trusted-run OIDC
  join path.
- The uploader and build remain provider-neutral: they see a generic
  capability, never label syntax. Ingested untrusted records carry
  `ci.pr.fork=true` so queries can filter (05 stamps it;
  BUCK.OBS.REC-R07 bounds the decode).

## Design Question

- **DQ1 Merge revision export:** The record's `mergeRevision` and index's
  `merge_revision` are repository-local fields. Which standard, if any,
  should carry that value when exporting OTel attributes? Resolve only
  after checking the current VCS semantic conventions and downstream
  query expectations; do not advertise an invented merge-revision
  attribute as standardized.

## Conformance

- Same-record check: a local pipeline run and a CI-shaped run of the same
  command produce structurally identical records modulo attribute values.
- VCS seal: on a PR merge checkout the manifest and index agree on the
  env-supplied change id, git head/base parents, and merge commit even when
  the provider run object has no PR association. A push checkout omits
  unavailable change/base/merge fields rather than inventing them; the
  trace id remains unchanged if the manifest's file digest changes.
- Upload idempotency: two uploads of one sealed record commit once; a
  no-credential run reports spool-only with the record intact.
- Trust: without a credential a fork run stays spool-only; after the
  deferred admission path is enabled, a label is insufficient unless the
  capability binds to the exact live head, and a changed head invalidates it.
- Evidence: [delivery bakeoff](./.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md),
  [cold-CI capture](./.experiments/2026-09-24-cold-ci-event-log-capture.md),
  decisions [0001](./.decisions/0001-run-record-system-of-record.md),
  [0002](./.decisions/0002-untrusted-run-trust-signal.md),
  [0003](./.decisions/0003-seal-vcs-identity.md).
