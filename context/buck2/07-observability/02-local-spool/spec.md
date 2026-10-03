# Local Spool Spec

This document specifies native-evidence capture and the local telemetry spool. It builds on [requirements.md](./requirements.md); [01](../01-run-identity/spec.md) owns trace identity and attempt closure, [03](../03-event-log-adapter/spec.md) decodes evidence, and [05](../05-otlp-delivery/spec.md) owns direct OTLP delivery.

## Status

Draft.

## Scope

**Defines:** local event-log/trace-id/report capture and ownership of retained, unsent telemetry.

**Does not define:** a manifest, sealed run record, content-addressed upload, archive, CI artifact, ingest index, or fleet service.

## Local Evidence and Spool

```text
job or local invocation
  ├─ OTEL_SPAN_SPOOL_DIR/*.jsonl       caller and derived span capture
  └─ per-command Buck evidence
      ├─ <command>.pb.zst              explicit --event-log copy
      ├─ <command>.buck-trace-id       upstream --write-build-id output
      ├─ <command>.report              build report, if produced
      └─ <command>.sidecar             UUID + caller traceparent (01)
        └─ adapter (03) -> completed OTLP batches -> local retry spool (05)
```

Paths are local implementation details, never telemetry identifiers. The parent spool location comes from `OTEL_SPAN_SPOOL_DIR`; path components for run, matrix-qualified job, and command are encoded before use as filesystem names. Different matrix legs and repeated Buck commands do not overwrite one another. Caller spans and native Buck logs are converted to durable OTLP chunks before export. Once conversion succeeds, native inputs are removed so a retry only sends unacknowledged chunks; conversion failure retains the native inputs. A completed run directory is removed after all chunks are acknowledged. Offline retry directories are capped at seven days and 512 MiB locally, not archived indefinitely.

Each traced caller invokes Buck directly with explicit `--event-log` and `--write-build-id` paths. The latter writes the Buck trace id despite the flag's historical name. The caller passes only a validated `BUCK_WRAPPER_UUID`; its sidecar associates the Buck command and caller command span without consulting a provider API. The adapter sees the event log even if export is disabled. Buck output remains authoritative when decoding fails.

## Identity Attributes (BUCK.OBS.REC-R03/R05)

| Field                      | Source                                       | Missing value                                |
| -------------------------- | -------------------------------------------- | -------------------------------------------- |
| `vcs.change.id`            | CI adapter PR number                         | Omit on non-PR runs                          |
| `vcs.ref.head.revision`    | git PR head; checked-out HEAD on non-PR runs | Omit if unresolved                           |
| `vcs.ref.base.revision`    | base parent (`HEAD^1`) of CI merge checkout  | Omit without a merge checkout                |
| `buck2.vcs.merge.revision` | checked-out merge commit                     | Omit without a merge checkout                |
| `buck2.vcs.change.is_fork` | CI adapter fork provenance                   | Explicit true for fork runs; omit if unknown |

`buck2.vcs.merge.revision` belongs to the Buck2 observability lane's repository-local lowercase dotted `buck2.vcs.*` namespace. Its value is distinct from the PR head and base; readers unaware of it ignore it without substituting another revision. The three revision values and change id are attributes on the emitted traces, not fields in a manifest or fleet index. Derived trace IDs depend only on 01's pre-delivery identity, never on these attributes or a file digest.
Fork provenance follows [05's semantic attribute contract](../05-otlp-delivery/spec.md#semantic-attribute-contract).

## Completion and Failure

```text
build -> finish command spans / decode evidence -> join task/command spans into the job trace (#1477)
      -> tailnet admission after build (trusted CI only) -> one OTLP export burst (05)
attempt closes -> CI finalizer emits a pipeline-run link trace (01)
```

The job's build and span join complete before export. The CI finalizer uses
the current attempt's Jobs API pages to derive uniquely mapped started-job
root IDs by [01's canonical key](../01-run-identity/spec.md). It neither
loads other jobs' native evidence nor uploads an attempt-close roster. A
started job that never emitted telemetry can have a link to an absent root;
the link is marked unverified, not replaced by a synthetic error span.
Forks do not join the tailnet and keep telemetry locally. Delivery failure
leaves local bytes for retry and does not alter the child exit status.
An offline local invocation likewise spools only.

## Conformance

- Repeated commands and matrix legs retain disjoint event-log/trace-id/sidecar files; the adapter can correlate each Buck command to its caller.
- A PR merge checkout emits separate PR head, base parent, and merge revision attributes even when the CI run API has no PR association; a push omits unavailable base/merge values.
- A fork or offline local invocation retains telemetry without export; a failed export retains unacknowledged chunks without changing the build result. A failed conversion retains native Buck inputs; completed conversion does not re-ingest acknowledged chunks on retry.
- The finalizer links started jobs' unverified derived identities once at
  attempt close; skipped/unstarted jobs receive no link, and there is no
  roster record or server-owned root.
- Historical evidence and amended decisions: [capture experiment](./.experiments/2026-09-24-cold-ci-event-log-capture.md), [delivery bakeoff](./.experiments/2026-09-25-ci-agnostic-delivery-bakeoff.md), [0001](./.decisions/0001-run-record-system-of-record.md), [0002](./.decisions/0002-untrusted-run-trust-signal.md), [0003](./.decisions/0003-seal-vcs-identity.md), [0004](./.decisions/0004-attempt-close-record.md).
