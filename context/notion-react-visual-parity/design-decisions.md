# Visual-parity design decisions

Companion to `analysis.md`. Adopt rnx DOM patterns where they affect rendering
or accessibility; skip what is purely internal to rnx (RecordMap, hooks,
context).

## Adopt verbatim

- **Check SVG** for to-do (copy `<svg viewBox="0 0 14 14"><path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z"/></svg>` from `react-notion-x/src/icons/check.tsx`, MIT). Inlined into `web/blocks.tsx` rather than a separate file — single use, avoids per-icon files.
- **To-do checkbox markup**: `<span class="notion-property notion-property-checkbox">` wrapping `<div class="notion-property-checkbox-{checked,unchecked}">[<svg/>]</div>` — the vendored CSS rules `.notion-property-checkbox*` already exist for this exact shape.
- **Callout**: `<div class="notion-callout">` (not `<aside>`), icon as `<div class="notion-page-icon-inline">{icon}</div>`, color suffix `_co` for callouts (vendored CSS uses `.notion-{color}_co` for callout backgrounds, separate from text colors).
- **Toggleable header**: same `<details class="notion-toggle"><summary>{header}</summary><div>{children}</div></details>` shape rnx uses. Drops our distinct `notion-toggle-heading` class so the vendored `.notion-toggle` rule applies.

## Adapt

- **Inline color naming**: rnx writes `notion-{c}` (fg) and `notion-{c}_background` (bg). Switch ours to that. Slightly awkward (`_background` literal), but matches the vendored CSS we already pay for.
- **Toggle inner div**: drop `notion-toggle-body` class and emit a plain `<div>{children}</div>` so `.notion-toggle > div` from vendored CSS applies. The class was a CSS hook with no styling attached.
- **Heading inner span**: wrap heading text in `<span class="notion-h-title">` (matches vendored CSS for heading typography). Skip the anchor `<div class="notion-header-anchor">` and `<a class="notion-hash-link">` — rnx ties them to per-block UUIDs we don't have.
- **Paragraph tag**: switch `<p>` to `<div>`. Less semantic, but matches Notion's actual export and rnx's rendered DOM, and avoids `<p>`-specific margin collapsing.
- **Child page**: keep our minimal markup (we don't have rnx's `PageLink` router) but rename outer class from `notion-child-page` to `notion-page-link` so the vendored hover/spacing CSS applies. Keep emoji icon.

## Diverge (intentionally)

- **No anchor + hash link icon on headings** — rnx generates them from block IDs we don't model. Cosmetic only; we lose the hover-revealed `#` link.
- **Native `<details>` disclosure marker** — drop our `summary::before { content: '▸' }` override entirely. Browsers render a chunkier triangle natively (this is what rnx ships and what the user identified as the desired look).
- **Table outer wrap** — keep `<div class="notion-simple-table-wrap">`. rnx wraps tables one level higher (in the parent block); we don't have that scaffolding, so keep our wrap for horizontal-scroll behavior. Documented divergence.
- **Heading semantic levels** — rnx demotes h1→`<h2>` because the page title takes the document's `<h1>`. We're a sub-document renderer with no enclosing page title; keep `<h1>` for true h1 blocks.
- **No KaTeX, no LazyImage, no PageLink/router** — out of scope for v0.x; minimal stand-ins remain.
- **No Storybook screenshot loop in this PR** — `demo-replica` is actively iterating on the Storybook surface. Visual verification deferred to a follow-up; this PR is a structural DOM change validated by `tsc` + the existing Storybook demos that demo-replica will re-screenshot.

## Out of scope (track separately)

- Bookmark rich previews (title / description / thumbnail / favicon) — task #76.
- Mention / equation richer renderers.

## Round-2 decisions (umbrella #83 / effect-utils#589)

### List grouping (rendering-time, not reconciler)

`Page` and `Column` wrap their `children` in a `groupBlocks(children)`
pass that walks the React children array and merges consecutive
`BulletedListItem` / `NumberedListItem` into a single `<ul>` / `<ol>`.
Identity is checked via component reference (`child.type ===
BulletedListItem`). List items themselves still render a self-contained
one-item list when used outside a grouping container — no API change.

This sidesteps the reconciler-level grouping originally tracked by #62:
the DOM preview is a pure-React view, so a React-level pass is
sufficient.

### TOC uses surrounding heading context

`Page` collects sibling headings (via the same children-walking pass)
into a `TocEntry[]` and passes it to `groupBlocks`, which swaps any
`<TableOfContents/>` for a `RenderedTableOfContents` populated with
anchor links. Heading blocks emit an `id` derived from slugified plain
text so anchors resolve. TOC inside a `Column` receives an empty list
— acceptable v0.1 limitation.

### Checkbox CSS lives in our override, not vendored CSS

react-notion-x prunes `.notion-property-checkbox*` from its vendored
`styles.css`, so round-1's markup (already adopting rnx's shape) had
no styling. The fix is CSS-only: add the 14px rounded-square rules to
`web/styles.css`.

### `.notion-column-list` styled in our override

rnx styles `.notion-row` (their internal flex wrapper) but leaves
`.notion-column-list` unstyled. Mirror `display: flex; gap: 1em;
align-items: flex-start` plus sensible child flex rules in
`web/styles.css`.

### Bookmark adopts rnx `<a><div>...` shape

Round-1 left the bookmark as a plain `<a class="notion-bookmark">`
with text content — the vendored CSS expects a nested `<div>` with
`.notion-bookmark-link` / `.notion-bookmark-link-text` to render as a
bordered card. Mirror the nesting.
