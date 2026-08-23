# Experiment: page-create crash recovery

- **Date:** 2026-08-23
- **Related:** A09, T06, R28

## Question

Can a retry preserve a server-minted sub-page id and avoid duplicating the
inline body when execution stops after `pages.create` but before inline block
retrieval completes?

## Method

A Notion-shaped failure-capable fixture accepts one keyed `<ChildPage>` with an
inline paragraph, then fails the first post-create child retrieval. The test
reads the cache at the failure boundary and retries from that exact state. A
second variant changes the paragraph text before retry. Assertions cover page
and block mutation counts, page id stability, body cardinality, and final
content.

## Result

The failure checkpoint contains the created page id, no guessed child block
ids, and one immutable pending-inline descriptor. Same-intent retry issues zero
page or block mutations and retains one page with one paragraph. Changed-intent
retry retains the same page, adopts the existing paragraph id, and issues one
block update with no create, append, remove, or duplicate body.

The adversarial type-mismatch path fails closed rather than associating an
unexpected live block with a cached key.

## Conclusion

Immediate identity checkpointing plus retry-time inline adoption satisfies
R28. Page-id-only checkpointing is insufficient because it loses the evidence
needed to distinguish auto-created inline descendants from missing content;
archive-and-recreate is unnecessary and would break stable page identity.

## VRS Impact

A09 defines `pages.create` as irreversible identity allocation. T06 accepts the
additional durable save. R28 and the page-driver spec require checkpoint-before-
retrieval and adoption-before-diff. The ontology names the temporary pending
inline resolution state.
