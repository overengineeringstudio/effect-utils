# `@overeng/notion-react` docs

`@overeng/notion-react` turns a React tree into Notion block mutations:
write a page as JSX, and the library emits the minimum sequence of
`append` / `insert` / `update` / `remove` calls against the Notion API to
make the page match the tree. Re-rendering the same JSX is a no-op; a
one-line change is one `update`.

The package lives between "use the raw Notion client" (too imperative)
and "write your own reconciler" (everyone re-invents the cache, the diff,
and the fallbacks). This directory is the reader-facing projection of
the design. The authoritative design docs live in
[`../context/vrs/`](../context/vrs/) — `vision.md`, `requirements.md`,
`spec.md`.

## Reading paths

### Beginner — "I just want to render a Notion page"

1. [Getting Started](./getting-started.md) — install, a 20-line example,
   first render.
2. [Concepts → Keys and identity](./concepts/keys-and-identity.md) —
   why `blockKey` matters and when you need it.
3. [Cookbook → Styling strategies](./cookbook/styling-strategies.md) —
   which CSS to import if you render the page in a browser.

### Integrator — "I'm wiring this into an app"

1. [Concepts → Reconciler](./concepts/reconciler.md) — how a render pass
   becomes a sequence of Notion ops.
2. [Concepts → Theming](./concepts/theming.md) — CSS surface, overrides,
   dark mode.
3. [API overview](./api.md) — the exported surface.
4. [Cookbook → Custom blocks](./cookbook/custom-blocks.md) — `<Raw>` and
   shaping your own block components.
5. [Cookbook → Partial trees](./cookbook/partial-trees.md) — rendering a
   subtree without owning the whole page.
6. [Migration notes](./migration.md) — breaking changes between versions.

### Contributor — "I'm changing the package"

1. [Contributing](./contributing.md) — dev setup, edit/test loop.
2. [Testing](./testing.md) — unit / mock-client / live E2E layers.
3. [Internals → Architecture](./internals/architecture.md) — module
   layout and data flow.
4. [Internals → Reconciler internals](./internals/reconciler-internals.md)
   — host-config shape, LCS diff, cache schema.

## Scope

In scope: Notion **blocks** — page content as a tree of typed blocks,
reconciled incrementally. Out of scope: Notion **databases** (schema,
rows, views) — use
[`@overeng/notion-effect-client`](../../notion-effect-client) directly
for those.
