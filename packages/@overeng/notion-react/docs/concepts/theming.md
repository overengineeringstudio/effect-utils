# Theming

This page covers the web preview surface only. The Notion renderer
itself produces block-type tagged payloads — Notion's own client styles
them. The web renderer exists for local iteration in Storybook and is
**not** API-stable (see T05 in
[requirements.md](../../context/vrs/requirements.md)).

## CSS surface

The web renderer ships two stylesheets:

| File                                 | What it contains                                       |
| ------------------------------------ | ------------------------------------------------------ |
| `@overeng/notion-react/web/styles.css` | Pruned Notion base styles + overrides (see below)    |
| `@overeng/notion-react/web/katex.css`  | KaTeX styles, loaded only if you render equations    |

`styles.css` re-exports a pruned derivative of react-notion-x's
`styles.css` (vendored into `src/web/vendored-notion.css`) and layers
the package's own overrides on top. Importing `styles.css` gets you
both. See [`src/web/PRUNING.md`](../../src/web/PRUNING.md) for what
was stripped and why.

```ts
import '@overeng/notion-react/web/styles.css'
// Optional — only if your content contains <Equation /> or <InlineEquation />.
import '@overeng/notion-react/web/katex.css'
```

## The `.notion-page` wrapper

Every `<Page>` from `@overeng/notion-react/web` emits a root
`<div class="notion-page">`. All styles are scoped under that class so
the CSS doesn't leak into the surrounding document.

Consumers of `vendored-notion.css` who render blocks *without* a
`.notion-page` wrapper will see unstyled output — this is intentional.
The upstream stylesheet puts design tokens on `:root`, which would
bleed into any document that imports it; we rescope them to
`.notion-page`.

## Overrides

Add your own rules under `.notion-page` (or a more specific ancestor)
after the package's stylesheet:

```css
/* your-app.css */
.notion-page {
  --notion-font: "Inter", system-ui, sans-serif;
  max-width: 960px;
}

.notion-page .notion-callout {
  border-radius: 8px;
}
```

Per-block class names mirror Notion's (`.notion-text`,
`.notion-h1..h4`, `.notion-bulleted-list`, `.notion-callout`,
`.notion-code`, `.notion-toggle`, …). See `src/web/blocks.tsx` for the
exhaustive list — drift between host and web component prop shapes is
a type error, so the class set tracks the block set.

## Dark mode

Dark-mode tokens come from the vendored stylesheet and key off
`.notion-page.dark-mode`:

```tsx
<Page>
  <body className={isDark ? 'dark-mode' : ''}>
    <Page>…</Page>
  </body>
</Page>
```

Or toggle the class on the `.notion-page` root directly. The shipped
overrides (`styles.css`) do not hard-code color outside the token set,
so overriding a CSS variable on `.notion-page.dark-mode` is enough to
retheme in dark mode.

## Custom callout colors

`<Callout>` accepts Notion's full color palette as a string. Pass the
Notion color token and the web renderer maps it to the matching
`.notion-<color>_background` class:

```tsx
<Callout color="green_background" icon="🌱">Shipping soon.</Callout>
<Callout color="yellow_background" icon="⚠️">Breaking change.</Callout>
```

Supported values match Notion's API: `default`, `gray`, `brown`,
`orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`, plus
each as `_background`.

## Syntax highlighting and math

Code blocks render through [`shiki`](https://shiki.matsu.io) and
equations through [`katex`](https://katex.org). Both are optional peer
dependencies — skip installing them if you don't render those blocks.

The first `<Code language="...">` in a tree lazy-loads the Shiki
highlighter for that language. Equations lazy-load KaTeX's bundle.

## When to import what

See the decision table in
[Cookbook → Styling strategies](../cookbook/styling-strategies.md).

## See also

- [`src/web/PRUNING.md`](../../src/web/PRUNING.md) — what was removed
  from the vendored stylesheet and why.
- [`src/web/LICENSE-NOTICE.md`](../../src/web/LICENSE-NOTICE.md) —
  upstream attribution for the vendored CSS.
