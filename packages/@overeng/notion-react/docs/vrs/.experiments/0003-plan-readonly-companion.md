# Experiment: read-only plan() parity with sync()

- **Date:** 2026-08-25
- **Related:** R37, R38, T11

## Question

Can a read-only `plan()` predict exactly what `sync()` would apply — including
root-page metadata drift that sync handles outside its internal diff — without
duplicating sync's logic and without issuing a single write?

## Method

`sync()`'s pre-flight was extracted into shared module-level helpers
(`resolvePendingPages`, `topLevelDrifted`, `selectDiffBase`,
`rootPageUpdateOpFor`) and `plan()` composed from the identical path. Against
the Notion-shaped mock fixture: (a) cold and warm-incremental plans are
compared to the subsequent sync's applied tallies; (b) a post-sync plan is
asserted empty, including a `<Page>` + `<ChildPage>` + icon scenario where an
icon change must plan as exactly one `pages.update`; (c) the mock request log
is asserted GET-only during a `'live'` plan and untouched during
`'cache-only'`; (d) an out-of-band append is planted behind the cache's back
and both staleness modes are compared; (e) `onEvent` sequences are captured
for both modes.

## Result

Cold and warm plans match the subsequent sync's applied block and page tallies
exactly. The post-sync plan is empty in every scenario, and the icon-change
plan carries exactly one root `updatePage` — omitting the root op would have
passed the block-level fixpoint while missing real metadata drift. `'live'`
plans issue only GETs and detect the out-of-band append as
`fallbackReason: 'cache-drift'` with removes for the foreign block;
`'cache-only'` issues zero requests and reports a (wrong, but by-contract)
empty plan for the same state. Events: `'live'` emits
`OpIssued`/`OpSucceeded` (kind `'retrieve'`) + one `PlanComputed`;
`'cache-only'` emits `PlanComputed` only. Full suite green with sync behavior
unchanged.

## Conclusion

Sharing sync's pre-flight as extracted helpers (rather than reimplementing a
"read-only diff" externally) satisfies R37 by construction — the two paths
cannot disagree about a given observed state. The root `updatePage` must be
part of `SyncPlan.ops` for the fixpoint oracle to be trustworthy. The
`'cache-only'` blind spots are inherent (they need the live child list), so
R38 documents them instead of approximating.

## VRS Impact

R37 and R38 added; T11 records the TOCTOU stance (a plan can go stale, the
applied result cannot). The spec gains the plan() section describing the
shared helpers and event semantics.
