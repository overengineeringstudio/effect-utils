# Opaque blocks render as inline id-carrying placeholders; the body is a block tree, not a string

> **Superseded by [0016](./0016-refuse-lossy-pages.md).** The editor refuses
> pages containing opaque blocks rather than placeholdering and reconciling them,
> so there is no `<notion-block id>` token. Retained for history: it records why
> the placeholder approach was attempted and the live finding (placeholder token
> absent from both Notion Markdown surfaces) that made reconciliation necessary —
> and ultimately not worth it.

The body is a Notion **block tree**, not a flat string. Most blocks render as
clean Markdown and are matched by content + position. Blocks the Markdown cannot
losslessly represent — the API `unsupported` type and known-but-lossy blocks
(`child_database` → `[embedded db]()`, `table_of_contents` → `[TOC]`,
`synced_block`, …) — render as a **stable inline placeholder carrying the block
id**:

```
<notion-block id="00000000-0000-4000-8000-000000000000"/>
```

The placeholder carries identity only; the block's content stays authoritative
on the remote. This makes the body self-describing: nothing is invisible, so a
round-trip never silently drops content.

Live validation (experiments.md, tmp/notion-vim/vrs-critique-results.md)
corrected the original push story: the placeholder is a **client-side** token
present in neither Notion's rendered nor endpoint Markdown, so it cannot be
targeted by `update_content` string search-replace. Preservation/edit/delete of
placeholdered blocks therefore happens through **block-level reconciliation by
id** (decision 0011), not Markdown search-replace.

Because every block has a stable id and opaque blocks are id-anchored, the body
is always representable (Markdown or placeholder) — so the exit-3 lossy refusal
is reduced to genuinely unrepresentable edge cases (e.g. endpoint truncation),
not the common unknown-block case.

## Status

superseded by 0016 (was: accepted, push mechanism corrected by live critique —
see decision 0011)

## Consequences

- The body-fidelity classifier must flag **every** not-losslessly-representable
  block, not only `unsupported`-typed ones (R38) — otherwise the renderer won't
  id-anchor a `child_database` and the reconciler will destroy it.
- The renderer migrates to `<notion-block id="…"/>` (the current `''` emission
  and the endpoint's `<unknown alt="…"/>` token are the pre-implementation state,
  tracked in impl-delta.md — not part of the target).
