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
  "buck2.vcs.merge.revision": "<40-hex merge checkout commit>",
  "files": [{ "path": "buck2/171713_build.pb.zst", "bytes": 711142, "sha256": "…" }]
}
```

Every field is provider-neutral; a provider contributes only attribute values.
The adapter supplies `vcs.change.id` (PR number, if present) via the
environment. At seal time git resolves `vcs.ref.head.revision` to the PR
**head** and `vcs.ref.base.revision` to its base, not to the merge checkout;
where a merge checkout exists, `buck2.vcs.merge.revision` holds its checked-out
merge commit. The Buck2 observability lane owns the repository-local lowercase
dotted `buck2.vcs.*` namespace; this selected key is stable for v1, is neither
registered OTel semconv nor an alternative spelling for `vcs.ref.head.revision`,
and is omitted if no merge checkout exists. The ingest index stores the same
value; readers unaware of this vendor key ignore it without substituting
the head revision. Revisit only if semconv adds a matching merge key, with
an explicit schema migration. For a non-PR checkout unavailable change/base/
merge facts are omitted rather than inferred from a provider API; checked-out
HEAD is the head revision. A provider run's PR association may be empty and
cannot serve as the recovery source.

The manifest never contains hostnames, host paths, usernames, or credentials
(BUCK.OBS.REC-R05), and it never contains trace ids: record identity is the
manifest digest. Trace ids derive from the pre-manifest
[`PIPELINE_RUN_ID` and command identity](../01-run-identity/spec.md), not
the digest; discovered trace ids live in the ingest index. The Buck wrapper
UUID itself derives from caller trace and command span before sealing.

## Attempt-Close Record

```text
CI jobs (each seals/uploads its own run record)
  └─ always-run final CI job, dependent on every job
       └─ same uploader -> attempt-close record -> ingest index (05)
```

The finalizer does not need any job's output artifacts. It reads the CI
adapter's job inventory and conclusions after all dependencies settle and
uploads one sealed, content-addressed `buck2-attempt-close/v1` record through
the same authenticated endpoint and conditional PUT used for job records.
This record is a distinct type, not a second per-job manifest or run root:

```json
{
  "schema": "buck2-attempt-close/v1",
  "pipelineRunId": "ci/forge/repo%2Fmodule/421/2",
  "repository": "repo/module",
  "sealedAt": "<rfc3339>",
  "expectedJobs": [
    { "key": "build[os=linux]", "conclusion": "success" },
    { "key": "build[os=macos]", "conclusion": "failure" }
  ]
}
```

The producer uses canonical matrix-qualified job keys from 01; the roster
includes all work jobs and excludes the finalizer itself (which contributes
this close record, not a job Run Record). Conclusions are the
provider-neutral values `success`, `failure`, `cancelled`, or `skipped`.
A job listed as successful but without an uploaded record still lacks
evidence. Duplicate close uploads with identical digest are no-ops;
a conflicting roster for the same `PIPELINE_RUN_ID` is an explicit integrity
error, never last-write-wins. The final CI job is always-run even if a
dependency fails; if it cannot publish, 05 applies the bounded incomplete
attempt timeout rather than assuming the attempt succeeded.

## Lifecycle

```text
write   run begins; spool + capture write concurrently (01 wiring)
seal    at job/local-run end: enumerate, digest, freeze manifest; record immutable
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

## Conformance

- A multi-job CI attempt has one job record per matrix-qualified job and
  exactly one close record listing all jobs, including failed/skipped jobs;
  a missing job upload remains visible even if its conclusion was success.
- Same-record check: a local pipeline run and a CI-shaped job run of the same
  command produce structurally identical records modulo attribute values.
- VCS seal: on a PR merge checkout the manifest and index agree on the
  env-supplied change id, PR head, base, and separate merge commit even when
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
  [0003](./.decisions/0003-seal-vcs-identity.md), and
  [0004](./.decisions/0004-attempt-close-record.md).
