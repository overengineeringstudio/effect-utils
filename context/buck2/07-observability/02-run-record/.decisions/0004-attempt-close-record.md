# 0004 Attempt-Close Record Completes CI Job Inventory

Status: accepted

Accepted 2026-09-26 (Johannes, q50; closes the missing-job/root-timing review finding).

## Context

Each CI job uploads its own Run Record, but the ingester alone writes the
shared run root. Without an authoritative completion signal or expected-job
roster, a failed job that never uploads can leave the root unwritten forever.

## Evidence and Argument

The seeded-run bakeoff showed that a first-job provisional root freezes wrong
bounds and that duplicate root IDs persist. A CI dependency graph knows every
job's conclusion even when the job emitted no evidence. A final always-run job
can report that inventory without depending on any job's artifacts; the same
uploader can carry the close record under the same admission and durability
rules as job records.

## Options

| Option | Outcome | Reason |
| --- | --- | --- |
| Always-run attempt-close record plus bounded timeout | Accepted | Explicit roster, one completed root, recovery if finalizer cannot upload |
| First job emits a provisional root | Rejected | Immutable wrong bounds and duplicate roots |
| Infer completion from observed job uploads alone | Rejected | Failed/missing job never appears in the observed set |

## Decision

The final CI job depends on all work jobs and always runs. It uploads a
provider-neutral `buck2-attempt-close/v1` record through the same uploader,
listing their matrix-qualified expected job keys and conclusions; the
finalizer excludes itself because it produces only this close record. One
record belongs to each pipeline attempt, not to a job's native evidence.
The ingester finalizes the single root only when the close record arrives and
every listed job is ingested or marked missing; missing jobs get error spans.
If closure or a listed job remains outstanding, a six-hour idle timeout after
the last upload finalizes the attempt as `incomplete`, not silently successful.
The state and recovery sequence are owned by [05](../../05-ingest-and-archive/spec.md).

## Consequences

The queue/index must distinguish job evidence from attempt closure and retain
missing-job inventory. Duplicate close uploads are idempotent; conflicting
rosters for one attempt fail visibly. Local runs retain their entrypoint-owned
root and do not need a CI attempt-close record.
