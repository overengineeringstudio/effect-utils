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

The manifest and ingest index carry `vcs.change.id` when a PR number is available from the adapter environment. At seal time git resolves the PR head and base revisions separately from the checked-out merge commit. Missing facts are omitted, not guessed from a provider run object. Trace identity derives before sealing from pipeline-run and command identity; the manifest digest depends on sealed evidence, never a trace id. See [requirements](../requirements.md) and [schema](../spec.md). Amendment 1 names the merge field.

## Consequences

PR lookup remains possible even if the provider returns no associated PR. An absent head/base reference cannot be replaced with a claimed provider SHA. Full-view id derivation belongs to the ingest/view spec, not the record manifest.

## Amendment 1 — VCS Revision Semantics (q49)

Accepted 2026-09-26 (Johannes). `vcs.ref.head.revision` names the PR head,
`vcs.ref.base.revision` its base, and the merge-checkout commit is
`buck2.vcs.merge.revision`, a Buck2 observability lane-owned vendor attribute
in the manifest, index, and exported trace. Do not alias the merge commit as
the PR head. Revisit the vendor key only if OTel semconv gains a matching
merge-revision attribute. This closes the former DQ1 without claiming a
nonexistent standard key.
