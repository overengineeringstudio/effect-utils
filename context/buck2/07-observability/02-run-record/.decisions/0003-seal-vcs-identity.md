# 0003 Seal VCS Identity into the Run Record

Status: accepted

Accepted 2026-09-26 (q38; Johannes).

## Context

A provider run object can have no PR association even for a PR run, and a merge checkout reports the merge revision rather than the source head. Resolving PR → run solely from the provider after ingest is therefore unreliable. Trace identity must also exist before the manifest can be sealed.

## Options

| Option | Tradeoff | Outcome |
| --- | --- | --- |
| PR number from adapter environment, git revisions at seal | Portable evidence and reliable association without a provider lookup | Accepted |
| Provider API resolves PR on ingest | Can return an empty association | Rejected |
| Include manifest digest in trace id | Circular dependency on a not-yet-sealed record | Rejected |

## Decision

The manifest and ingest index carry `vcs.change.id` when a PR number is available from the adapter environment. At seal time git resolves the checked-out head or, for merge checkouts, the PR head and base parents and the merge revision. The manifest calls the merge fact `mergeRevision`; the index calls it `merge_revision`, both repository-local. Missing facts are omitted, not guessed from a provider run object. The trace identity remains derived before sealing from the pipeline-run and command identity; the manifest digest depends on the sealed evidence, never on a trace id. See [requirements](../requirements.md) and [schema](../spec.md).

## Consequences

PR lookup remains possible even if the provider returns no associated PR. An absent head/base reference cannot be replaced with a claimed provider SHA. Full-view id derivation belongs to the ingest/view spec, not the record manifest. The exported OTel attribute for the merge revision is unresolved ([DQ1](../spec.md)); these repository-local field names are not a claim of a standard semantic convention.
