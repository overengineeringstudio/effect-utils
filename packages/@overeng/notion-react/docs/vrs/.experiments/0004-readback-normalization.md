# Experiment: readback normalization into one comparable hash space

- **Date:** 2026-08-25
- **Related:** R39, R40, T12

## Question

Can server-observed block JSON and rendered candidate trees normalize into a
single canonical form whose hash equality certifies "the live page matches the
render" — without reusing (and thereby invalidating) the deployed
`CacheNode.hash` space, and without a context-free observed hash?

## Method

A spike normalized four block types (paragraph, heading_2,
bulleted_list_item, callout) into a shared `NormalizedReadbackNode` form:
rich-text run coalescing, explicit annotation frames, empty-run dropping,
default folding, callout-icon envelopes. It was then extended to the full
first-class component surface (25 block types incl. table/table_row cells,
code captions, media sources, mention/equation leaves, child_page identity)
plus page-metadata comparison. Probes: (a) mock roundtrips
(render → sync → observe → compare) per block type; (b) hand-written
realistic response-shape fixtures carrying the deltas the mock cannot produce
(`plain_text`/`href` decoration, re-segmented runs, provider-injected
defaults, expanded mention objects, signed-URL file envelopes); (c) negatives
(text/cell/expression/icon/checked/language tampering); (d) a gated live-API
e2e lane replaying (a) against real Notion.

## Result

All sides hash-equal through the canonical form; every tamper probe breaks
equality. Three structural findings:

1. **Separate hash space is forced.** `CacheNode.hash` is djb2 over
   request-shape projected props; the readback form must differ (defaults
   explicit, runs coalesced, derived fields dropped). Rebasing the cache hash
   onto the readback form would invalidate every deployed cache, so the two
   spaces share only the `hashStable` primitive.
2. **No context-free observed hash.** Unclaimed callout icons, unclaimed code
   language, unclaimed column ratios and table widths are provider-injected —
   whether an observed value is noise or drift depends on the candidate's
   claim. `compareReadback` therefore takes both sides.
3. **Some dimensions are unverifiable in principle** through block JSON:
   uploaded-asset content (expiring signed URLs) and built-in icon identity
   (undocumented `{type:'icon'}` rewrite, no public name↔URL mapping). These
   mask to explicit sentinels rather than comparing flaky values.

Latent sync finding (out of readback scope, reported upstream): the
root-scope interleaved apply flushes buffered block ops at each `createPage`
boundary, but the diff defers an atomic container's descendant appends until
after the sibling run — a `<Table>`/`<ColumnList>` rendered before a root
`<ChildPage>` is flushed without its inlined children and fails Notion's
atomic-create validation.

## Conclusion

One canonical form with candidate-contextual masking satisfies R39/R40; the
masked dimensions become the T12 tradeoff instead of silent flakiness.
`child_page` stays an identity boundary — per-page readback composes the same
way per-page sync does (R26).

## VRS Impact

R39, R40, T12 added; spec gains the readback-oracle section. Limitations
document the masked dimensions and the unsupported raw escape-hatch types.
