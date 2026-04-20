# Cookbook — Styling strategies

The web preview ships two stylesheets that layer on top of each
other: a pruned derivative of react-notion-x's (`vendored-notion.css`)
and a small set of overrides and additions (`styles.css`). The
single, bundled entry point is
`@overeng/notion-react/web/styles.css` — importing it gets you both
in the right order.

This page is a decision guide for which stylesheet(s) you need and
how to extend them.

## Decision table

| I want to…                                                           | Import                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Render the web preview with Notion-faithful defaults                 | `@overeng/notion-react/web/styles.css`                     |
| …and also render equations                                           | + `@overeng/notion-react/web/katex.css`                    |
| Ship my own design system; opt out of Notion styles                  | Nothing. Import the components, write your own CSS.        |
| Layer my overrides on top of the package defaults                    | `@overeng/notion-react/web/styles.css`, then my own CSS    |
| Only use the Notion renderer (no web preview)                        | Nothing — CSS is web-preview only.                         |

## Why two files

`vendored-notion.css` is a stripped-down copy of react-notion-x's
stylesheet with unused rule groups removed and design tokens rescoped
to `.notion-page` (so they don't leak onto `:root`). See
[`src/web/PRUNING.md`](../../src/web/PRUNING.md) for the exact list of
what was removed.

`styles.css` is the override layer: it fills gaps the pruned stylesheet
does not cover (to-do checkboxes, `column_list` flex layout, tightened
preview padding) and tweaks a handful of tokens. Import order matters —
`vendored-notion.css` first, then `styles.css`. Both are bundled into
the single `@overeng/notion-react/web/styles.css` export so consumers
don't manage the order themselves.

## Scoping — `.notion-page`

The web `<Page>` component wraps its children in
`<div class="notion-page">`. All styles are scoped under that class.
Rendering blocks without a `<Page>` wrapper produces unstyled output;
this is intentional — it prevents the library's tokens from leaking
into an unrelated surrounding document.

```tsx
import { Page, Heading1, Paragraph } from '@overeng/notion-react/web'
import '@overeng/notion-react/web/styles.css'

export const Preview = () => (
  <Page>
    <Heading1>Hello</Heading1>
    <Paragraph>World</Paragraph>
  </Page>
)
```

## Going headless

You don't have to use the web renderer at all. The components under
`@overeng/notion-react/web` share prop shapes with the Notion-host
components under `@overeng/notion-react` via
`src/components/props.ts`. Drift between surfaces is a type error, so
you can write your own DOM renderer against those prop shapes and
leave the package's CSS out of your bundle.

## Storybook

The package's own Storybook uses the bundled stylesheet directly:

```sh
pnpm --filter @overeng/notion-react storybook
```

It's the canonical visual reference for every block. If a visual
regression ever shows up, re-run Storybook before reaching for the
CSS — the stories are the source of truth for what the web preview is
supposed to look like.

## See also

- [Concepts → Theming](../concepts/theming.md) — override model,
  `.notion-page` wrapper, dark mode.
- [`src/web/PRUNING.md`](../../src/web/PRUNING.md) — what the
  vendored stylesheet drops and why.
- [`src/web/LICENSE-NOTICE.md`](../../src/web/LICENSE-NOTICE.md) —
  upstream attribution.
