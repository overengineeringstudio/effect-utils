# Cookbook — Partial trees

A `sync` call reconciles the children of exactly one Notion page. You
do not have to render the entire page — you can render a subtree and
treat the rest of the page as owned by something (or someone) else.
This is how Pixeltrail renders its daily section under an otherwise
hand-edited page.

## The boundary is the page, not the subtree

`sync({ pageId })` reconciles `pageId`'s direct children and their
descendants. It does **not** scope itself to a subtree within that
page — the diff considers every child of `pageId` to be under its
control.

If you want the library to own only part of a Notion page, pick a
**container block** (a `toggle`, a `callout`, a `child_page`, a
`column`, …) and pass **its** id as `pageId`. From the sync driver's
point of view, a container block is indistinguishable from a page
root: both are "something with children I reconcile".

```tsx
const program = sync(<TodaySection entries={entries} />, {
  pageId: toggleBlockId, // the Toggle block's id, not the page id
  cache: FsCache.make('.notion-cache/today.json'),
})
```

Everything outside that toggle — other blocks on the page, comments,
permissions, anything the library didn't put there — is left alone.

## Per-subtree caches

Use one cache file per independently-synced subtree. Sharing a cache
across unrelated subtrees is supported but requires disjoint
`blockKey` namespaces — otherwise a key collision between subtrees
could masquerade as a match.

```tsx
const todayCache = FsCache.make('.notion-cache/today.json')
const archiveCache = FsCache.make('.notion-cache/archive.json')

await Effect.runPromise(Effect.all([
  sync(<Today entries={today} />, { pageId: todayBlockId, cache: todayCache }),
  sync(<Archive entries={archive} />, { pageId: archiveBlockId, cache: archiveCache }),
], { concurrency: 'unbounded' }))
```

If you must share a cache, namespace keys with the `blockKey` helper:

```tsx
import { blockKey } from '@overeng/notion-react'

<Toggle blockKey={blockKey(`today:${id}`)}>…</Toggle>
<Toggle blockKey={blockKey(`archive:${id}`)}>…</Toggle>
```

## The single-writer rule

The library treats the subtree under `pageId` as single-writer (A04 in
[requirements.md](../../context/vrs/requirements.md)). Content that
humans edit directly must live **outside** that subtree — on the same
page is fine, but above / below / beside the synced container, not
inside it. A manual edit inside the synced region is overwritten on
the next `sync`.

Typical patterns:

- A `<Toggle>` that the library owns, sitting between hand-edited
  paragraphs above and below. The user's paragraphs survive; the
  toggle's contents get reconciled.
- A `<ChildPage>` whose page id is passed to `sync`. The rest of the
  parent page is user-owned.
- A `<Callout>` for status banners, with the rest of the page free for
  manual notes.

## Pitfalls at the boundary

- **Don't render the container itself in the JSX.** If `pageId` is a
  toggle's id, do not also render a `<Toggle>` inside your tree — the
  library reconciles the toggle's *children*, not the toggle itself.
  Rendering the toggle inside the tree creates a second, nested
  toggle.
- **Watch out for cache drift.** Moving or archiving the container
  block by hand invalidates the cache. The sync detects `rootId`
  drift via a pre-flight `NotionBlocks.retrieve`, falls back to a
  cold diff, and sets `fallbackReason = "page-id-drift"`.
- **Don't nest two renderers with overlapping roots.** If one sync
  owns toggle A's children and another owns block B that happens to
  be inside A, the first sync will eventually remove B. Either pick
  a non-overlapping split or use one sync to own both.

## See also

- [Concepts → Reconciler](../concepts/reconciler.md) — how the diff
  scopes itself to the `pageId`'s children.
- [Concepts → Keys and identity](../concepts/keys-and-identity.md) —
  namespacing shared caches.
