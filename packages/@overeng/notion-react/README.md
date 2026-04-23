# @overeng/notion-react

React component library and `react-reconciler`-based renderer that produces
Notion blocks. Write Notion pages as JSX; the renderer translates to
`NotionBlocks.append` / `update` / `delete` calls against the Notion API.

Full design docs: [`docs/vrs/vision.md`](./docs/vrs/vision.md) ·
[`requirements.md`](./docs/vrs/requirements.md) ·
[`spec.md`](./docs/vrs/spec.md).

## Scope

This library renders React → Notion **blocks**. Notion **databases**
(creating/updating DBs, rows, schema, views) are out of scope — use
[`@overeng/notion-effect-client`](../notion-effect-client) directly for
database operations.

### Sub-pages

`<ChildPage>` renders a reference to an existing Notion page. Creating a
new sub-page is a page-level op (`pages.create`), not a block-level op,
and is not driven by this library today. Use the two-step pattern:

```ts
// 1. Create the page via @overeng/notion-effect-client
const subpage = yield* NotionPages.create({
  parent: { page_id: parentId },
  properties: { title: [{ type: 'text', text: { content: 'My Subpage' } }] },
})

// 2. Render its id from JSX (read-only reference)
<ChildPage blockKey={subpage.id} title="My Subpage" />
```

Integrated JSX-driven sub-page creation may follow in a later version.

## Why

Notion pages are trees, but the Notion API is imperative:
`blocks.append` / `blocks.update` / `blocks.delete` against block ids.
Calling that surface directly forces every writer to either (a) wipe and
re-append the page each run — visible churn, O(blocks) cost — or (b)
hand-roll a keyed diff, a cache schema, and a kill-switch. This library
is that shared, principled layer: JSX in, minimum Notion ops out.

Success means re-rendering the same JSX is a no-op, a one-line change is
a single `update`, and adding a new block type is one component + one
projection.

## Getting Started

```tsx
import { Effect } from 'effect'
import { Heading1, Paragraph, Toggle, renderToNotion, sync, FsCache } from '@overeng/notion-react'

const Page = ({ phases }: { phases: { id: string; title: string; body: string }[] }) => (
  <>
    <Heading1>Q2 Launch Plan</Heading1>
    {phases.map((p) => (
      <Toggle key={p.id} blockKey={p.id} title={p.title}>
        <Paragraph>{p.body}</Paragraph>
      </Toggle>
    ))}
  </>
)

// First-time append
const program1 = renderToNotion(<Page phases={phases} />, { pageId: 'page-uuid' })

// Incremental, cache-backed
const cache = FsCache.make('.notion-cache.json')
const program2 = sync(<Page phases={phases} />, { pageId: 'page-uuid', cache })
```

Both entry points return
`Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient>`. Provide
`NotionConfig` and an `HttpClient` via the Effect runtime of your choice.

## Keys: `key` vs `blockKey`

The library uses **two orthogonal key concepts**. They look similar but
live on different sides of the renderer and solve different problems.

| Concept         | Who reads it                    | What it identifies                        | Lifetime            |
| --------------- | ------------------------------- | ----------------------------------------- | ------------------- |
| React `key`     | React (inside react-reconciler) | A sibling's fiber across renders          | Current render pass |
| `blockKey` prop | `@overeng/notion-react` diff    | A Notion block across renders & processes | Persisted in cache  |

### React `key` — sibling reconciliation

Exactly what you know from React-DOM. Stable across renders, unique
among siblings, lets React match up fibers so component state and hook
state survive re-renders. Required any time you render a list. If you
omit it you get React's usual index-keyed matching plus the usual
warnings.

```tsx
{
  items.map((item) => (
    <Toggle key={item.id} title={item.title}>
      …
    </Toggle>
  ))
}
```

React `key` never reaches the Notion diff — it's stripped by React
before the element reaches the host-config.

### `blockKey` — Notion block identity

`blockKey` is our host-level prop. It is what the reconciler's diff uses
to match a rendered candidate block to a previously-synced Notion block
stored in the cache. If `blockKey` matches between runs, the existing
Notion block id is reused (update-in-place); if it doesn't match, the
block is treated as brand new (insert) and the previous one (if any) is
removed.

```tsx
<Toggle blockKey={item.id} title={item.title}>
  …
</Toggle>
```

If you omit `blockKey`, siblings fall back to positional keys
(`p:0`, `p:1`, …). That works when the list is append-only, but
mid-sibling inserts degrade to a tail-reorder (remove + re-insert of
every following block) because positional keys shift.

Use `blockKey` whenever:

- the collection can grow or shrink in the middle,
- items can reorder,
- the same tree is re-rendered across process restarts (cache survives,
  so `blockKey` must too).

### Do I need both?

Usually yes — they're cheap and answer different questions:

```tsx
<Toggle key={item.id} blockKey={item.id} title={item.title}>
  …
</Toggle>
```

Rule of thumb: **React `key` is for React, `blockKey` is for Notion.**
Same identifier for both is fine and common. You can also namespace
`blockKey`s across multiple renderers sharing one cache file via the
`blockKey(businessId)` helper (returns `"b:<id>"`).

### When it matters — minimum-op behaviour

With stable `blockKey`s, the diff satisfies:

- Resyncing identical JSX ⇒ 0 Notion ops
- Changing one block's props ⇒ 1 `update`
- Appending one sibling ⇒ 1 `append`
- Removing one sibling ⇒ 1 `remove`
- Inserting a sibling mid-list ⇒ 1 `insert`

Without `blockKey` on a middle insert, the diff sees every later
positional key as "changed" and falls back to remove + re-insert of the
tail.

## Manual-edit semantics

The React tree is the source of truth. When a user edits a synced block
directly in Notion, the next `sync()` overwrites that edit with the
tree's projection — this is by design, not a bug. If you need content
that tolerates manual edits, keep it outside the synced region (e.g.
below the last block the library manages, or on a separate page).

## Cache

Any backend that implements `NotionCache` works:

```ts
interface NotionCache {
  readonly load: Effect<CacheTree | undefined, CacheError>
  readonly save: (tree: CacheTree) => Effect<void, CacheError>
}
```

Shipped: `FsCache` (atomic-rename JSON file), `InMemoryCache` (in-process,
tests). SQLite / Redis / other backends can be added downstream without
forking.

## Errors

`NotionSyncError` (tagged, with `reason: string` + optional `cause`) is
the only error channel surfaced to callers. `SyncResult` carries a
`fallbackReason` when the sync took a fallback path
(`"cold-cache"`, `"schema-mismatch"`, …). See the
[fallback table in spec.md](./docs/vrs/spec.md#fallback-decision-table-r16).

## Storybook preview (`@overeng/notion-react/web`)

> **Preview surface — not a production Notion renderer.** DOM structure,
> CSS hooks, and component props under `src/web/` may change without
> deprecation. It exists so authors can iterate on block / inline
> components visually in Storybook. It is **not** pixel-parity with
> Notion, not an end-user renderer, and not an API-stable target. See
> R21 + T05 in [`docs/vrs/requirements.md`](./docs/vrs/requirements.md).

```bash
pnpm --filter @overeng/notion-react storybook
```

The web mirrors share prop shapes with the Notion-host components via
`src/components/props.ts` — drift between the two surfaces is a
TypeScript error.

### Non-goals

Mirrors [`docs/vrs/vision.md`](./docs/vrs/vision.md) "What This Is Not":

- Not a Notion editor
- Not a collaborative renderer
- Not a public-facing / SEO-friendly renderer
- Not pixel-parity with Notion
- Not an API-stable preview target (expect churn until v1.0)

If you need a production Notion-styled web renderer, reach for
`react-notion-x` or a dedicated package — don't depend on
`@overeng/notion-react/web`.

## Further reading

For more, see [`docs/`](./docs/README.md) — audience-segmented guides for
beginners, integrators, and contributors. Quick links:

- [Getting Started](./docs/getting-started.md)
- Concepts: [keys and identity](./docs/concepts/keys-and-identity.md),
  [reconciler](./docs/concepts/reconciler.md),
  [theming](./docs/concepts/theming.md)
- [API overview](./docs/api.md) · [Cookbook](./docs/README.md#integrator--im-wiring-this-into-an-app) ·
  [Migration](./docs/migration.md)
- Contributors: [contributing](./docs/contributing.md) ·
  [testing](./docs/testing.md) ·
  [internals](./docs/internals/architecture.md)

Source material:

- Block + inline component reference: `src/components/`
- Host-config + diff internals: `src/renderer/`
- Design questions (open): [`spec.md#open-design-questions`](./docs/vrs/spec.md#open-design-questions)
