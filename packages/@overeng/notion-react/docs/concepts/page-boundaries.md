# Page boundaries

Every rendered page — the root `<Page>` and every `<ChildPage>` — is
its own **sync boundary**. The reconciler treats each as an
independent subtree with its own `blockKey` namespace and its own
cache subtree.

See the spec for the normative rules:
[`docs/vrs/spec.md`](../vrs/spec.md) (R26, R28, R30, T06, A08).

## One boundary per page

A sync boundary is the unit at which the diff runs and the Notion API
is addressed. Inside a boundary, `blockKey` collisions are errors;
across boundaries, the same key is independent.

```tsx
<Page>
  <Toggle blockKey="intro">…</Toggle> {/* key "intro" under root */}
  <ChildPage blockKey="onboarding">
    <Toggle blockKey="intro">…</Toggle> {/* different "intro" — independent */}
  </ChildPage>
</Page>
```

The cache mirrors this shape: each sub-page owns a subtree keyed by
its own block/page id, and nested `blockKey`s live under that
subtree. Deleting the sub-page (archive) drops the whole subtree;
moving it (`movePage`) preserves it.

## Recursive reconciliation

`diff()` descends into every retained sub-page. For each retained
`<ChildPage>`, the driver opens a nested diff pass with
`scopePageId = subPage.blockId`, so block ops emitted inside carry
the scope tag and resolve against the sub-page's block tree — not the
root page's. The sync driver then applies each scope's ops against
the shared working cache in sequence (R26).

## Inline packing (A08)

`pages.create` accepts an inline `children` envelope up to depth 2
and 100 blocks total. The sync driver packs as much of the new page's
tree as fits in that envelope, then tails the rest via
`blocks.children.append` calls scoped to the new page id. Callers do
not need to reason about the limit — the packer handles it — but
deeply nested or very large sub-page trees will see multiple API
calls on first creation.

## Partial-failure archive (T06 / R28)

If `pages.create` succeeds but a tail `blocks.children.append`
fails mid-flight, the driver archives the half-created page before
surfacing the error. The next sync sees no cached id for that
`blockKey` and reconciles from scratch by creating a fresh page.
This keeps the Notion-side state consistent with the cache-side
state: either both see the page or neither does.

## Schema mismatch (R30)

The cache schema version encodes the boundary structure. Cache v3
uses a `nodeKind` discriminator and per-page subtrees; older caches
(v2) fall through the existing `"schema-mismatch"` cold path. See
[Migration → Cache schema v2 → v3](../migration.md#cache-schema-v2--v3).
