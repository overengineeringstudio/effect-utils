# Cookbook — Sub-page creation

`<ChildPage>` is a first-class sync boundary. Its lifecycle is driven
by the JSX tree: add it to create, change props to update, remove it
to archive, render it under a different parent to move.

See also:
[Concepts → Page boundaries](../concepts/page-boundaries.md) ·
[API → Page types](../api.md#page-types).

## JSX-driven pattern

Minimal example: a root page with a sub-page that has its own nested
content.

```tsx
import {
  sync,
  FsCache,
  Page,
  ChildPage,
  Heading1,
  Heading2,
  Paragraph,
  Toggle,
} from '@overeng/notion-react'

const Handbook = () => (
  <Page title="Team handbook" icon={{ type: 'emoji', emoji: '📘' }}>
    <Heading1>Overview</Heading1>
    <ChildPage blockKey="onboarding" title="Onboarding">
      <Heading2>Week 1</Heading2>
      <Paragraph>Set up your dev environment.</Paragraph>
      <Toggle title="Accounts checklist">
        <Paragraph>GitHub, 1Password, Notion, Slack.</Paragraph>
      </Toggle>
    </ChildPage>
  </Page>
)

const program = sync(<Handbook />, {
  pageId: rootPageId,
  cache: FsCache.make('.notion-cache/handbook.json'),
})
```

On the first sync the driver calls `pages.create` for the `Onboarding`
sub-page (inline-packing its nested children up to depth 2 / 100
blocks, see A08), then follows up with `blocks.children.append` for
anything deeper or larger.

## Updating metadata

Change `title`, `icon`, or `cover` on an existing `<ChildPage>` — the
driver emits a single `pages.update` against the sub-page id stored
in the cache. The `blockKey` anchors identity across renders.

```tsx
<ChildPage
  blockKey="onboarding"
  title="Onboarding (revised)"
  icon={{ type: 'emoji', emoji: '✨' }}
  cover={{ type: 'external', external: { url: 'https://example.com/cover.jpg' } }}
>
  …
</ChildPage>
```

The same applies to the root `<Page>` — its `title` / `icon` / `cover`
drive `pages.update` on the sync root.

### Clearing icon / cover

Pass `null` explicitly to clear a previously-set field. Omitting the
prop is "no claim" and preserves the server-side value — use `null`
when you want the next sync to emit `pages.update({icon: null})` /
`pages.update({cover: null})`.

```tsx
// Icon was set in a previous render; this sync clears it.
<ChildPage blockKey="onboarding" title="Onboarding" icon={null} />
```

On a fresh sub-page (no prior icon), `icon={null}` is a no-op — there
is nothing to clear. The same applies to `cover={null}`.

## Archiving

Remove a `<ChildPage>` from the tree and the next sync emits
`archivePage` (Notion soft-delete via `in_trash: true`). The cache
subtree for that page is dropped. If you later re-render a
`<ChildPage>` with the same `blockKey`, it is treated as a fresh
`createPage` — Notion does not expose an un-archive path that
preserves identity.

## Reparenting

Move a `<ChildPage>` between parents while keeping its `blockKey`
stable. The diff sees a retained sub-page under a different parent
and emits `movePage` via `NotionPages.move`. Contents and sub-page
children survive the move.

```tsx
// Before
<Page>
  <ChildPage blockKey="onboarding" title="Onboarding">…</ChildPage>
</Page>

// After — same blockKey, nested under a new parent
<Page>
  <ChildPage blockKey="people-ops" title="People Ops">
    <ChildPage blockKey="onboarding" title="Onboarding">…</ChildPage>
  </ChildPage>
</Page>
```

The new parent must itself be syncable from the same tree (root page
or another `<ChildPage>`).

## When to drop to the imperative path

The JSX-driven path covers the common case: `page_id` parent, standard
title/icon/cover, no custom properties. For anything else, create the
page directly via `@overeng/notion-effect-client` and render a
read-only `<ChildPage blockKey={id} title={…} />`. Reach for the
imperative path when you need:

- **Database parents** — `pages.create` with `parent: { data_source_id }`
  and typed property payloads. Not supported from JSX in v0.2.
- **Workspace-level pages** — `parent: { workspace: true }`. The JSX
  tree always has a parent context; there is no way to escape upward.
- **Custom properties** — anything beyond `title` on the created page
  (select, status, relation, formula, rollup, …).
- **Precise control over inline packing** — e.g. if you want to
  `pages.create` with a specific children envelope for deduping or
  deterministic ids.

In those cases, create the page imperatively and render `<ChildPage
blockKey={…} title={…} />` so the JSX tree reflects it. Keep the
imperatively-managed page outside the sync driver's control by not
including it in the JSX tree, or scope the sync to a different
subtree via a dedicated `pageId` — see
[Cookbook → Partial trees](./partial-trees.md).
