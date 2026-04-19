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

- Bullet/numbered list grouping (one `<ul>` for adjacent items) — needs reconciler-level work, see #62.
- Bookmark / embed / asset rich rendering.
- Mention / equation richer renderers.
