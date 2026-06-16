# Block-level reconciliation is the universal push engine for both streaming and file-based paths

> **Superseded by [0016](./0016-refuse-lossy-pages.md).** With opaque-block pages
> refused, neither path needs block reconciliation: the streaming `put` is a
> guarded body replace, and the file-based path keeps its existing **Markdown**
> three-way merge + guarded `replace_content` (it is not rewritten onto a block
> engine). Retained for history.

Block-level reconciliation by id (decision 0011) is **the one push engine** for
every body write — the streaming `put` and the file-based `sync` alike. The
file-based path's `replace_content`/three-way-Markdown-merge fallback is retired:
it is the exact string-replace that live testing proved destroys a
`child_database`/`table_of_contents` (they render lossily yet classify
`complete`, so no refusal fires).

- **File-based path** keeps its state store, so it does a **3-way block merge**
  (base snapshot ↔ local ↔ remote, reconciled by block id) — strictly stronger
  than streaming's 2-way guard.
- **Streaming path** does the 2-way guarded reconciliation (base hash from
  `cat`).
- Any residual `replace_content` is **hard-gated behind a sound fidelity verdict
  (R38)** so it can never run over a body containing an opaque block.

## Why

The alternative (scope reconciliation to streaming only) would leave the mature
file-based path with the same silent-data-loss bug and contradict the
already-stated "benefits the file-based path equally." The project targets the
full long-term ideal with no data-loss class, so unifying on one engine is the
elegant, correct choice even though it rewrites the file-based push.

## Status

superseded by 0016 (was: accepted)

## Consequences

- R30/R31 are universal (not streaming-scoped); the spec's file-based Push Flow
  and Merge policy are rewritten to route through reconciliation.
- The reconciler is shared code; the file-based path supplies a base snapshot for
  a 3-way merge, the streaming path supplies only the base hash for a 2-way
  guard.
- `--allow-delete-ns` and the lossy-refusal carve-outs shrink to the genuinely
  unrepresentable cases once placeholders + sound classification land everywhere.
