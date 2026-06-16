# `put` is block-level reconciliation by id, not Markdown search-replace

> **Superseded by [0016](./0016-refuse-lossy-pages.md).** Reconciliation existed
> only to edit pages containing opaque blocks. Those pages are now refused, so the
> push is a guarded body replace (decision 0012), not a block-op sequence.
> Retained for history — the live findings here (three mismatched Markdown
> surfaces, `child_database` uncreatable, recreate-move mints a new id breaking
> inbound references) are the evidence behind the refusal in 0016.

Live critique proved the body has three mismatched Markdown surfaces — the
**rendered** body `cat` emits (`[embedded db]()`), Notion's **endpoint** Markdown
that `update_content` searches (`<database …>…</database>`), and the design's
**`<notion-block id>`** token, present in neither. So a push modeled as Markdown
string-replace is unsound: deleting the rendered token 400s, moving an opaque
block is impossible by text, and a multi-update `update_content` batch silently
partial-applies (a non-matching update is dropped while the call returns `ok`).

Decision: `put` is a **block-level reconciliation**. It parses the edited buffer
into a desired block sequence and diffs it against the live remote block tree by
id, emitting block-API operations:

All operations below are **live-validated** on the pinned `2026-03-11` API
(experiments.md; tmp/notion-vim/reconciler-feasibility.md):

| Desired vs remote                                     | Operation                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| representable block, content changed                  | `PATCH /blocks/{id}` (id retained) — content built by the renderer-symmetric converter (decision 0015)                                                                                                                                                                                                                                                                                                                                      |
| new block (no id)                                     | positional insert: `PATCH /blocks/{parent}/children` with `position:{type:'after_block',after_block:{id:<prev>}}` (or `start`/`end`) — the `2026-03-11` form; `after` is the deprecated name. Insert-above a `child_database` works                                                                                                                                                                                                         |
| opaque block kept (id present)                        | preserve (no-op); a placeholder represents the whole subtree, preserved by parent id                                                                                                                                                                                                                                                                                                                                                        |
| opaque block / representable block absent from buffer | archive by id (`DELETE /blocks/{id}`; normal editing, decision 0010)                                                                                                                                                                                                                                                                                                                                                                        |
| opaque block repositioned                             | **recreate where lossless** — recursively fetch `/children` (never inline), **strip read-only `null` fields** (else append validation fails), re-append at the new position; paginate (>100 children) and respect nesting-depth limits. **Refuse** (exit 11) for `child_database` (uncreatable via the block API) and for an original `synced_block`/block with inbound references (recreate mints a **new id**, breaking those references) |

Representable content is converted via the renderer-symmetric converter (decision
0015), **not** `markdownToBlocks` (which is lossy) and **not** `update_content`
string-replace (the placeholder token is absent from both Notion Markdown
surfaces). The post-push `semanticEquivalent` gate runs with URL canonicalization
(decision 0007).

## Status

superseded by 0016 (was: accepted)

## Consequences

- This is the **universal** push engine (decision 0014) — both streaming and the
  file-based path reconcile by id; the file-based path adds a 3-way block merge
  from its base snapshot.
- Representable-content fidelity is the binding constraint, handled by the
  renderer-symmetric converter (decision 0015), not the block API.
- Notion has no move-by-id primitive; recreate-move is the only reposition, lossy
  for some types (refuse per the table) by platform limitation.
- The reconciler needs a sound fidelity classifier (R38) to know which blocks are
  opaque (id-matched) vs representable (content-matched).
- Decision 0005's earlier "no reconciliation needed" applied only to _preserving
  untouched_ blocks during a sibling edit, not to move/delete/insert.
