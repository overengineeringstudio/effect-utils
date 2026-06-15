# `edit` is promoted to the `notion` umbrella root; `cat`/`put` stay under `notion md`

`cat`, `put`, and `edit` live in the notion-md Effect command tree, so they
appear as `notion md cat|put|edit` for free via the existing umbrella dispatch
(and as `notion-md …` standalone). On top of that, `edit` is re-exposed as a
top-level alias **`notion edit <page>`**.

Rationale: "open my Notion page in `$EDITOR`" is the marquee cross-cutting verb
a user reaches for (cf. `kubectl edit`, not `kubectl resource edit`); burying it
under `notion md edit` hurts discoverability. The `cat`/`put` primitives are
body/page operations and stay namespaced under the markdown surface.

The `edit` command itself lives in notion-md (the package stays self-contained
and `notion-md edit` works alone); notion-cli only re-exposes it.

## Status

accepted

## Consequences

- notion-cli docs (`docs/glossary.md`, `requirements.md`, `spec.md`) record the
  dispatched `cat`/`put`/`edit` surface and the `notion edit` alias.
- `<page>` accepts a page id or full Notion URL everywhere, resolved through
  `parseNotionUuid` from `@overeng/notion-core`.
