# Representable edits use a renderer-symmetric bidirectional Markdown↔block converter

> **Superseded by [0016](./0016-refuse-lossy-pages.md).** The converter existed
> only to feed the client-side reconciler. With reconciliation gone, the
> representable-body push goes through Notion's own `replace_content` parser
> server-side, so no client Markdown→block converter is built. Retained for
> history: the lossy-`markdownToBlocks` finding here is _why_ a client-side
> reconstruct path was unsafe, which is part of the case for refusing in 0016.

The reconciler's hard part is turning edited representable Markdown back into
block ops. Notion has no fragment-convert endpoint, and the existing
`markdownToBlocks` / `parseInlineMarkdown` is **lossy** (live-proven: silently
drops code fences, quotes, to-dos, images, nesting, and inline `code` /
`[link]` / `~~strike~~`; only `**bold**`/`*italic*` survive). The renderer emits
all those forms, so reconstructing edited content through the current converter
silently corrupts.

Decision: build a **renderer-symmetric bidirectional converter** — the exact
inverse of the block-tree renderer for every representable block type — and run a
single per-block-by-id reconciler over it. Opaque blocks are id-anchored and
manipulated by raw block ops (no conversion); everything else round-trips through
the converter. The rejected alternative was a hybrid that routes representable
edits through Notion's `update_content` (its own Markdown engine) — less
converter work, but two transport mechanisms, whole-region (non-surgical)
patches, and continued coupling to `update_content`'s quirks. The single
converter is the more elegant, durable long-term choice.

## Why

A faithful Markdown↔block bijection (modulo opaque blocks, which are referenced
by id) is the clean foundation: surgical per-block edits, no `update_content`
coupling, and a **property-testable invariant** — `render(parse(md)) == md` and
`parse(render(block)) == block` for every representable block type — that
prevents the silent-corruption drift the lossy converter causes.

## Status

superseded by 0016 (was: accepted)

## Consequences

- The converter and renderer must be kept symmetric; this is enforced by
  round-trip property tests over every representable block + inline mark, not by
  discipline.
- Block types the converter cannot yet round-trip are treated as opaque
  (id-anchored placeholder) until the converter covers them — fail-safe, never
  silent corruption.
- This is the largest single implementation item; it lives in its own impl-delta
  group and gates a sound representable-content push.
