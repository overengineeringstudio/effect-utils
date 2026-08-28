# Experiment: recursive cache-drift recovery

- **Date:** 2026-08-28
- **Related:** R04, R16, R18, R38, T14

## Question

Can recursive renderer-owned identity observation recover an interrupted
nested sync without duplicate appends while remaining safe at opaque and
temporarily unreadable child scopes?

## Hypothesis

A warm preflight that observes only root identities cannot safely recover after
nested mutations land but their checkpoint does not. Recursively observing
renderer-owned identity scopes, then merging live and cached metadata by block
id, should reconcile the already-live descendants without duplicate appends,
return an exact CacheTree, and reach the zero-mutation fixpoint immediately.
Opaque provider-owned scopes and ambiguous promised-empty reads must remain
outside drift classification.

## Method

A captured interrupted-sync shape was replayed with a stale CacheTree containing
17 identities against a live renderer-owned tree containing 22. The candidate
also contained the 22 intended identities. The old root-only preflight and the
recursive recovery path were each run through the ordinary diff, mutation, and
checkpoint pipeline; live and cached identity counts were recorded after the
run and after one identical follow-up sync.

Focused mock probes exercised two boundary cases:

1. a `<SyncedBlock>` reporting `has_children: true` with inherited source
   content, while its renderer cache node intentionally had no descendants;
2. a renderer-owned `column_list` reporting `has_children: true` whose first
   child-list response was transiently empty, followed by the complete list.
   Request events, metrics, and final `SyncEnd.opCount` were compared with the
   fake HTTP request log.

## Result

The stale input was cache 17 / live 22. The old shallow path appended five
already-live descendants, producing live 27 while returning cache 22; the
returned cache therefore looked complete but did not describe the server. The
recursive path represented untracked live identities as temporary drift ghosts,
removed or reconciled those ghosts through the normal diff, stripped them from
all checkpoints, and returned an exact cache 22 matching live 22. An immediate
identical sync emitted zero mutations.

The opaque-scope probe performed no nested read, classified no drift, emitted
no mutation, and left inherited synchronized content untouched. The
promised-empty probe retried the list, consumed the later complete response,
and also emitted zero mutations. Every root, nested, retry, and pagination
request produced its own retrieve event pair and contributed one to metrics and
`SyncEnd.opCount`.

## Conclusion

Recursive identity observation is required for safe warm recovery, but only
inside renderer-owned scopes. A positive traversal boundary prevents inherited
synced content from becoming destructive drift, and bounded retry with
fail-closed exhaustion prevents an ambiguous empty response from becoming
replacement appends. Exact per-request accounting makes T14's added read cost
observable rather than hidden.

## VRS Impact

R04 now requires complete returned and persisted identity coverage at every
renderer-owned depth and an immediate zero-mutation resync. R38 replaces the
shallow live-plan contract with recursive owned-scope observation while keeping
`cache-only` blind. T14 accepts the additional recursive and retry reads. The
spec defines `identityTreeDrifted`, `driftedBase`, the internal drift-ghost
lifecycle, opaque traversal boundaries, promised-nonempty settle behavior, and
per-request telemetry. Vision and ontology are unchanged.
