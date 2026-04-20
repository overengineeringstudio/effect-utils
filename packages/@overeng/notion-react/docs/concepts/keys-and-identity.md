# Keys and identity

The library uses two orthogonal key concepts. They look similar but
live on different sides of the renderer and answer different questions.

| Concept         | Who reads it                    | What it identifies                         | Lifetime            |
| --------------- | ------------------------------- | ------------------------------------------ | ------------------- |
| React `key`     | React (inside react-reconciler) | A sibling fiber across renders             | Current render pass |
| `blockKey` prop | `@overeng/notion-react` diff    | A Notion block across renders & processes  | Persisted in cache  |

React's `key` never reaches the Notion diff — React strips it before
the element reaches the host-config. `blockKey` never reaches Notion —
the reconciler uses it only for cache matching and excludes it from
the projected block payload.

## React `key` — sibling reconciliation

Exactly what you know from React-DOM. Required on any list so React
can match fibers across renders and preserve component/hook state.
Omitting it gets you React's usual index-based matching plus a warning.

```tsx
{items.map((item) => (
  <Toggle key={item.id} title={item.title}>…</Toggle>
))}
```

## `blockKey` — Notion block identity

`blockKey` is a host-level prop the reconciler reads to match a
candidate block against a prior entry in the [cache
tree](./reconciler.md). On match, the existing Notion block id is
reused and the block is updated in place. On miss, the block is
treated as new (append or insert) and any orphaned cache entry is
removed.

```tsx
<Toggle blockKey={item.id} title={item.title}>…</Toggle>
```

Without `blockKey`, siblings fall back to positional keys (`p:0`,
`p:1`, …). That works for append-only lists but degrades on
mid-sibling operations: every later positional key shifts, so the
diff emits remove + re-insert for the tail instead of a single
insert.

The derived key is prefixed internally: `k:<blockKey>` for explicit
keys, `p:<index>` for positional. The `blockKey(businessId)` helper
returns `"b:<id>"`, useful if you share a cache across multiple
renderers and want a collision-proof namespace.

```ts
import { blockKey } from '@overeng/notion-react'

blockKey('task-42') // "b:task-42"
```

## Invariants

- **Uniqueness under a parent.** Two siblings with the same `blockKey`
  under one parent throw at diff time. If you see
  `duplicate blockKey '…' among siblings`, look for unstable derived
  keys (e.g. `blockKey={index}` combined with a filtered list).
- **Stability across runs.** `blockKey` is persisted in the cache.
  Mapping the same business concept to a new key on the next run
  invalidates the match, producing a spurious remove + insert.
- **Opacity.** The value is compared as a string; it is never parsed
  by the library.
- **Type equality is part of the match.** Notion rejects block-type
  changes via `update`, so the diff treats a same-key type change
  (e.g. `Paragraph` → `Heading1` with the same `blockKey`) as a
  remove + insert. The LCS folds type equality into the match
  predicate so this stays correct even under surrounding reorders.

## Which key do I set?

| Situation                                                | React `key` | `blockKey`  |
| -------------------------------------------------------- | :---------: | :---------: |
| Static tree, no lists                                    |             |             |
| List rendered fresh each run; append-only                |     Y       |             |
| List that can reorder / grow in the middle               |     Y       |      Y      |
| Same tree re-rendered across process restarts (warm cache) |   Y       |      Y      |
| Multiple renderers sharing one cache file                |     Y       | `blockKey(id)` |

Rule of thumb: React `key` is for React, `blockKey` is for Notion.
Using the same identifier for both is fine and common.

```tsx
<Toggle key={item.id} blockKey={item.id} title={item.title}>…</Toggle>
```

## Which components accept `blockKey`?

Blocks whose identity the diff needs to match across renders:
`Heading1` / `Heading2` / `Heading3` / `Heading4`, `Toggle`, `Callout`.
For blocks without a `blockKey` prop (`Paragraph`, `Code`, `Quote`,
list items, media, dividers, …) identity is inferred from a combination
of their position among siblings and — for text blocks — a content
hash. Wrap those in a keyed parent (`Toggle`, heading) if you need
stable identity in a mutating list.

This set is a v0.1 pragmatic cut — future versions will widen
`blockKey` acceptance to every block that can move mid-list.

## Op-minimality with stable keys

With stable `blockKey`s, the diff produces the minimum Notion op for
each mutation class:

| Change                                          | Result             |
| ----------------------------------------------- | ------------------ |
| Re-render identical JSX                         | 0 ops              |
| One block's props change                        | 1 `update`         |
| Append one sibling to the tail                  | 1 `append`         |
| Insert one sibling mid-list                     | 1 `insert`         |
| Remove one sibling                              | 1 `remove`         |
| Move one sibling (reorder within a parent)      | 1 `insert` + 1 `remove` |

Notion has no block-move API (see
[A05](../../context/vrs/requirements.md)), so a move is always a pair.

## Common mistakes

```tsx
// ❌ Unstable key — regenerated every render, defeats matching.
<Toggle blockKey={Math.random().toString()}>…</Toggle>

// ❌ Index as key through a filtered list — inserts at the front
// renumber every later key.
{items.filter(visible).map((item, i) => (
  <Toggle blockKey={String(i)} title={item.title}>…</Toggle>
))}

// ❌ Duplicate key — throws at diff time.
<Toggle blockKey="top">…</Toggle>
<Toggle blockKey="top">…</Toggle>

// ✅ Business id, stable across runs.
<Toggle key={item.id} blockKey={item.id} title={item.title}>…</Toggle>

// ✅ Namespaced so multiple renderers can share one cache file.
<Toggle key={item.id} blockKey={blockKey(item.id)} title={item.title}>…</Toggle>
```

## See also

- [Concepts → Reconciler](./reconciler.md) — how keys drive the diff.
- [Internals → Reconciler internals](../internals/reconciler-internals.md)
  — LCS algorithm and cache node shape.
