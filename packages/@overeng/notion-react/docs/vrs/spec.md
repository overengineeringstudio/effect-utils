# Spec — @overeng/notion-react

This document specifies how `@overeng/notion-react` renders JSX trees into
Notion block pages incrementally. It builds on
[requirements.md](./requirements.md).

**Status:** Draft — core block reconciler + LCS diff landed (Phases 1–2);
page-ops layer (R24–R30) in design on branch
`schickling/2026-04-23-notion-react-followup2` (issue #618). Nested
children support inside TEXT_LEAF containers and Suspense uploads still
open.

## Scope

This spec defines:

- The authoring surface (block and inline components) and how it maps to
  Notion block payloads.
- The reconciler host-config contract driving react-reconciler.
- The `OpBuffer` semantics used as the reconciler's container.
- The candidate-tree / cache-tree model and the minimum-op diff algorithm
  against it.
- The `NotionCache` interface and the on-disk cache schema.
- The `UploadRegistry` mechanism and the extension point for v0.2
  Suspense-based uploads.
- The fallback decision table used by the sync driver.
- The page-op layer: root `<Page>` metadata projection, `<ChildPage>`
  create/update/archive/move, per-page sync boundaries, and cache v3.

It does not define:

- The `NotionBlocks` API surface — that lives in
  `@overeng/notion-effect-client`.
- The web renderer's DOM output — see that package's own docs (it is a
  non-normative preview per T05).
- The pixeltrail migration plan — tracked in pixeltrail issues.

## Architecture

```
+--------------------+       +-----------------+
|  Caller's JSX      |       |  NotionCache    |
|  <Page>…</Page>    |       |  (Fs/InMemory)  |
+---------+----------+       +---------+-------+
          |                            ^
          v                            |
+--------------------+       load/save |
|  react-reconciler  |                 |
|  + host-config     |                 |
+---------+----------+                 |
          |                            |
          v                            |
+--------------------+                 |
|  Instance tree     |                 |
|  (in-memory, keyed)|                 |
+---------+----------+                 |
          |                            |
          v                            |
+--------------------+   +-------------+-------+
|  CandidateTree     |-->|   diff()            |
|  (projected props, |   |   LCS over keys     |
|   hashes, children)|   +-----+---------------+
+--------------------+         |
                               v
                    +----------------------+
                    |   DiffOp[] plan      |
                    +----+-----------------+
                         |
                         v
                    +----------------------+      +-------------------+
                    |   applyDiff          |----->|  NotionBlocks     |
                    |   (append/insert/    |      |  append/update/   |
                    |    update/remove)    |      |  delete           |
                    +----------------------+      +-------------------+
```

The `OpBuffer` populated by the host-config during an initial render is
used by `renderToNotion` (append-only cold start). For incremental
`sync`, the buffer's ops are discarded and the plan is produced by
`diff(cacheTree, candidateTree)` — the buffer exists there only as a
required host container.

Flow of a single `sync` call:

1. `opts.cache.load` yields a prior `CacheTree` (or `undefined`).
2. `buildCandidateTree(element, pageId)` drives the reconciler to produce
   a `CandidateTree`: projected props per block, hash of each projection,
   children (non-text), keys.
3. `diff(prior ?? emptyCache, candidate)` returns a `DiffOp[]`.
4. `applyDiff(plan)` issues `NotionBlocks.append/update/delete` calls in
   order, accumulating a tmp-id → real-id map.
5. The candidate tree's tmp-ids are resolved to real ids and persisted via
   `opts.cache.save`.
6. `SyncResult` reports op-counts and any `fallbackReason`.

Satisfies R08, R10, R13, R16, R18.

## Authoring surface

See `src/components/` (`blocks.tsx`, `inline.tsx`, `h.ts`).

### Block components (R01)

Each block component is a thin wrapper around a host element whose tag is
the Notion block type (`paragraph`, `heading_1` … `heading_4`, `toggle`,
`to_do`, `bulleted_list_item`, `numbered_list_item`, `callout`, `quote`,
`code`, `divider`, `image`, `video`, `audio`, `file`, `pdf`, `bookmark`,
`embed`, `equation`, `link_to_page`, `child_page`, `table_row`). Props
carried on the host are consumed by the host-config `blockProps`
projection.

Escape hatch: `<Raw content={...} />` emits a host of type `raw` with a
freeform `content` payload for block types the library doesn't yet model.

### Inline components (R02)

Inline components are tagged with a non-enumerable `INLINE_TAG` symbol
(`src/components/inline.tsx`). They are _not_ rendered as host nodes;
during `shouldSetTextContent`-gated leaves, the block's `children` are
walked by `flattenRichText` (see below) to produce a single
`rich_text[]` array. Types: annotations (`Bold`, `Italic`, `Underline`,
`Strikethrough`, `InlineCode`, `Color`), `Link`, `Mention`,
`InlineEquation`, `Text`.

### Rich text flattening

`flattenRichText(children)` walks a React-children forest and emits
Notion rich_text spans. Annotations compose multiplicatively:
`<Bold><Italic>x</Italic></Bold>` emits one span with
`{bold: true, italic: true}`. `Color` sets `annotations.color`. `Link`
sets the span's `href`. Mentions and equations emit dedicated span
types. Adjacent spans with identical annotations and no special kind
(link/mention/equation) are merged.

## Reconciler host-config

See `src/renderer/host-config.ts`.

### Instance model

```ts
type Instance = {
  type: BlockType | 'raw'
  props: Record<string, unknown>
  id: string | null // tmp id from OpBuffer (or null pre-commit)
  blockKey: string | undefined // from props.blockKey
  parent: Instance | null
  children: (Instance | TextInstance)[]
  rootContainer: Container
}
type TextInstance = { kind: 'text'; text: string; parent: Instance | null }
type Container = { rootId: string; buffer: OpBuffer; topLevel: Instance[] }
```

### React 19 host-config entries

Mutation host (`supportsMutation: true`). Key entries:

| Entry                                                                   | Role                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `createInstance(type, props, rootContainer)`                            | Allocate an `Instance`                                                       |
| `createTextInstance(text)`                                              | Allocate a `TextInstance`                                                    |
| `shouldSetTextContent(type, props)`                                     | Return true for leaf text blocks (see `TEXT_LEAF` set)                       |
| `appendInitialChild` / `appendChild` / `appendChildToContainer`         | Mount a child; emit append op if parent has an id                            |
| `insertBefore` / `insertInContainerBefore`                              | Mount + reorder; emit `insertBefore` op                                      |
| `removeChild` / `removeChildFromContainer`                              | Detach; emit `remove` op if child has an id                                  |
| `commitUpdate(instance, type, oldProps, newProps)`                      | R19 shape: project both prop sets, `deepEqual`, emit `update` only on change |
| `commitTextUpdate`                                                      | Update in-memory text; no op (text is re-projected via `blockProps`)         |
| `maySuspendCommit` / `preloadInstance` / `startSuspendingCommit` / etc. | React 19 Suspense stubs (no-op for v0.1)                                     |
| `clearContainer`                                                        | No-op (sync driver owns the container lifecycle)                             |

The host-config signature follows React 19
(`react-dom-bindings/src/client/ReactFiberConfigDOM.js`). The derisk
report identified a React-18 signature mismatch as the source of a prior
10× op-amplification bug; the current host-config matches React 19
exactly and is op-optimal on the benchmark scenarios.

### `TEXT_LEAF` and block-children

`TEXT_LEAF` blocks (`paragraph`, `heading_*`, `quote`, `callout`, `code`,
list-item variants, `to_do`, `table_row`) treat their React children as
rich text (R02). Their children are _not_ reconciled as fiber children
for v0.1 — this implies that block-nested blocks inside a callout /
list-item / to-do are out of scope for v0.1 and tracked as a follow-up
(v0.2, pixeltrail issue #62). `toggle` is the exception: its header is
supplied via the `title` prop and its `children` are reconciled as
nested blocks.

### `blockProps` projection

`blockProps(type, props)` produces the projected Notion-shaped payload
(minus the type-tagged envelope). It is the unit of structural equality
used by both `commitUpdate` (via `deepEqual`) and by the candidate tree
(via `hashProps`). `blockKey` is stripped from the projection so that
renderer-level identity hints do not appear in the hash.

## OpBuffer

See `src/renderer/op-buffer.ts`.

Ops are one of `append | insertBefore | update | remove`. Each new block
gets a monotonically increasing tmp-id (`tmp-1`, `tmp-2`, …) assigned at
emit time. Parent ids in `append`/`insertBefore` may be either real
Notion block ids (for mounts under previously-synced parents) or tmp-ids
issued by this buffer (for chained appends under a freshly mounted
parent).

The buffer is used in two ways:

1. **`renderToNotion` (append-only cold start):** The buffer's ops _are_
   the plan; applied in order, tmp-ids resolved as Notion returns real
   ids.
2. **`sync` (incremental):** The buffer is populated by the reconciler
   during `buildCandidateTree` but its ops are discarded. The plan is
   instead produced by `diff()` over the candidate+cache trees. The
   buffer is still needed because react-reconciler requires a container.

## CandidateTree / CacheTree

```ts
interface CandidateNode {
  key: string // `k:<blockKey>` or positional `p:<index>`
  type: BlockType
  props: Record<string, unknown> // output of blockProps()
  hash: string // djb2 of stableStringify(props)
  blockId: string | undefined // unset until resolved
  children: CandidateNode[]
}

interface CacheNode {
  key: string
  blockId: string
  hash: string
  children: readonly CacheNode[]
}
```

**Cache schema v3** (`CACHE_SCHEMA_VERSION = 3`; v1 → v2 added `type`
for same-key type-change detection; v2 → v3 adds `nodeKind` and per-page
subtrees per R26/R30):

```json
{
  "schemaVersion": 3,
  "rootId": "<page uuid>",
  "rootPage": { "titleHash": "...", "iconHash": "...", "coverHash": "..." },
  "children": [ CacheNode, ... ]
}
```

Each `CacheNode` carries `nodeKind: 'block' | 'page'`. Page-kind nodes
additionally carry `titleHash`, `iconHash`, `coverHash` (djb2 of
response-normalized projections per A07) and recurse into their own
`children` with their own key namespace.

Schema mismatches fall through to a cold-start diff — the stale tree is
still used for matching when keys line up (no data corruption), and the
sync sets `fallbackReason = "schema-mismatch"`.

### Key derivation (R07)

`instanceKey(inst, index) = inst.blockKey ?? "p:<index>"`, prefixed with
`"k:"` for explicit keys. React's `key` prop is forwarded via the
`blockKey` host prop (helper `blockKey(businessId)` returns `"b:<id>"`
for namespacing).

### Hashing

`hashProps` is a djb2 hash of a recursively-sorted-key stringification
of the projected block props (`stableStringify`). Hash collisions are
extremely unlikely in practice but never load-bearing — on hash-equal
but `deepEqual`-unequal nodes, the diff would issue no op, and this is
acceptable since equal hashes imply the caller's projection _is_ the
same Notion payload by construction. (If this ever changes, switch to
direct `deepEqual` at diff time.)

## Diff algorithm

See `src/renderer/sync-diff.ts`.

For each parent, `diffChildren(parentId, cacheChildren, candidateChildren, ops)`:

1. Compute the longest-common-subsequence of keys between
   `cacheChildren` and `candidateChildren`. The cache-indices in the LCS
   are "retained" — they keep their `blockId`.
2. Walk candidate children in order:
   - If `cand.key` is retained: reuse `prior.blockId`. Emit `update` if
     `prior.hash !== cand.hash`. Recurse into
     `diffChildren(prior.blockId, prior.children, cand.children, ops)`.
   - Otherwise: issue a fresh tmp-id. If no retained sibling follows,
     emit `append`; else emit `insert` anchored on `prevRef` (preceding
     sibling's `blockId` or `tmpId`). Recursively emit append ops for
     the new subtree via `emitAppendsForNew`.
3. After the candidate walk, emit `remove` for every cache child whose
   key is not retained.

The LCS+hash structure gives R04 (idempotent: LCS covers everything,
all hashes match, zero ops), R05 (LCS covers all, one hash differs →
one `update`), R06 (LCS covers n−1, one new candidate → one insert or
one append depending on surrounding retained keys; one missing candidate
→ one `remove`).

### Reorders

Since Notion has no move API (A05), any candidate whose `key` exists in
the cache but falls out of the LCS is treated as "new". The stale cache
entry is removed at the end of the parent's walk. This materializes a
move as `remove + insert` — documented, not a fallback.

### `applyDiff` and id resolution

`applyDiff` walks the `DiffOp[]` in emit order. Each `append`/`insert`
calls `NotionBlocks.append` (with an `after_block` position for
`insert`), extracts the server-assigned id from the first result, and
populates `idMap[tmpId] = realId`. Subsequent ops that reference a
tmp-id (chained appends under a just-created parent, or an `after_block`
targeting a just-inserted sibling) resolve through the map.

After apply, the candidate tree is walked once more to rewrite any
unresolved `tmpId` → `realId` (via `resolveTreeIds`) before
`candidateToCache` produces the CacheTree snapshot.

## Page-ops layer (R24–R30)

Pages are a second reconciliation surface layered on top of the block
reconciler. Every rendered page — the sync root and every nested
`<ChildPage>` — is its own sync boundary with:

- its own `blockKey` namespace (retained keys only compare within the
  same page);
- its own cache subtree (keyed by the page id);
- its own `OpBuffer` populated via a nested reconciler pass;
- a `PageOp` emitted by the parent's diff describing the transition.

```
root <Page id=P0>
  ├── block subtree (reconciled by the root's block diff)
  └── <ChildPage id=P1>
        ├── PageOp per transition (create/update/archive/move)
        └── recursive sync({ pageId: P1, cache: cache.pages[P1] })
              └── <ChildPage id=P2> … and so on
```

### PageOp kinds

```ts
type PageOp =
  | {
      kind: 'createPage'
      tmpPageId: string
      parent: { pageId: string }
      title?: NotionTitleRichText
      icon?: NotionIcon
      cover?: NotionCover
      inlineChildren: CreateChildren /* ≤ depth 2, ≤ 100 per A08 */
    }
  | {
      kind: 'updatePage'
      pageId: string
      title?: NotionTitleRichText
      icon?: NotionIcon | null
      cover?: NotionCover | null
    }
  | { kind: 'archivePage'; pageId: string }
  | { kind: 'movePage'; pageId: string; parent: { pageId: string } }
```

`DiffOp` widens to `BlockOp | PageOp`. `BlockOp` gains `scopePageId` so
batching (up to 100 children per `NotionBlocks.append`, per A08 / T07) can
never straddle a page boundary.

### Diff algorithm — pages

Sibling pages under the same parent are diffed with the same LCS used for
blocks, but the match predicate is `(key, nodeKind, type)` so a
`<ChildPage>` never matches a block with the same key, and vice versa.
Retention rules per candidate page:

1. Retained: compare `(titleHash, iconHash, coverHash)` against cache.
   Any differ → emit `updatePage` (coalesced single `pages.update`).
   Recurse into children with `sync` (see driver).
2. Not retained, no prior with same id in cache anywhere in the parent's
   subtree: emit `createPage` with tmp id; recurse into children using the
   tmp id as the page scope until applyDiff resolves.
3. Not retained, but prior exists at a different parent in cache →
   emit `movePage` to the new parent. Do not archive+recreate (R27).
4. Cache-only (no candidate): emit `archivePage`.

### Driver — per-page recursion (R26)

```
sync(element, { pageId, cache }):
  1. load cache; verify pageId exists via blocks.retrieve
     (on 404 / archived → fallback `page-missing` or `page-archived`)
  2. build candidate tree for THIS page only (stops at <ChildPage>)
  3. diff(cache.thisPage, candidate) → { blockOps, pageOps }
  4. apply root-metadata updatePage (if any) first
  5. apply block ops under the root page id (existing driver)
  6. for each <ChildPage> candidate in order:
       - createPage / movePage / archivePage as dictated by diffOp
       - if createPage: persist tmp→real id; insert new
         CacheNode with nodeKind='page' at the correct key
       - recurse: sync(childElement, { pageId: real, cache: cache.pages[real] })
  7. on any error mid-recursion:
       - if a page was created this run but its children failed mid-apply,
         issue pages.update {in_trash:true} on the partial page (T06/R28)
       - propagate NotionSyncError with fallbackReason when applicable
  8. checkpoint cache after every successful page-level step
  9. SyncResult includes pages: { creates, updates, archives, moves }
```

Ordering invariants:

- `createPage` must complete before any block op scoped to its id.
- `archivePage` (emitted for removed `<ChildPage>`) is applied after block
  ops that touch its parent (so the parent's child_page block disappears
  from the parent's children list in the same sync pass).
- Sibling-page order is not authoritative (T08); if JSX order matters for
  subsequent diffs the driver re-fetches `blocks.children.list` after a
  batch of creates under the same parent. This is off by default; enable
  via `ensureSiblingOrder: true` on the sync options.

### Inline-child packing on create

`inlinePackChildren(candidateChildren)` splits a page's candidate children
into `(inline, tail)` where `inline` fits `pages.create` (depth ≤ 2, ≤ 100
blocks) and `tail` is emitted as follow-up `NotionBlocks.append` batches
scoped to the new page id. A candidate whose subtree is deeper than
inline can carry is moved entirely to tail to keep the inline set
structurally uniform.

### Icon / cover normalization (A07)

`projectIcon(icon)` returns the _request-shape_ payload; `normalizeIcon`
translates the _response-shape_ Notion actually persists into the same
canonical form used for hashing. The hash used by diff / cache is always
over the normalized form. `custom_emoji` icons with no resolvable id are
stripped at the component boundary (warn + drop; same policy as
UploadRegistry miss, DQ5).

### Latent-bug fix

The current code path for `<ChildPage title>` changes emits
`NotionBlocks.update({blockId, child_page:{title}})`, which the Notion
validator rejects (verified against live API). Under this spec,
`<ChildPage>` title / icon / cover changes route exclusively through
`updatePage`. Shipping this spec as a single PR is acceptable; splitting
out a one-line fix-first PR is also acceptable.

## NotionCache interface

```ts
interface NotionCache {
  readonly load: Effect<CacheTree | undefined, CacheError>
  readonly save: (tree: CacheTree) => Effect<void, CacheError>
}
```

Shipped backends:

- **`FsCache.make(filePath)`** — JSON file, atomic rename on save, missing
  file or schema mismatch → `undefined` from `load`.
- **`InMemoryCache.make()`** — in-process map, used in tests and for
  one-off runs that don't want durability.

Third-party backends (SQLite, Redis, …) implement `NotionCache` directly
— no library changes needed (R12).

## Fallback decision table (R16)

| Trigger                                              | Behaviour                                                      | `fallbackReason`        |
| ---------------------------------------------------- | -------------------------------------------------------------- | ----------------------- |
| No cache file                                        | Cold diff against empty tree                                   | `"cold-cache"`          |
| Cache `schemaVersion !== CACHE_SCHEMA_VERSION`       | Diff against stale tree, still reuses keys                     | `"schema-mismatch"`     |
| Cache `rootId !== opts.pageId`                       | Cold diff against empty tree                                   | `"page-id-drift"`       |
| `NotionBlocks.update` returns 404/archived           | Emit structural rebuild of that subtree                        | `"block-missing"`       |
| Cached page id → `pages.retrieve` 404                | Drop cached subtree, recreate if JSX has it, else no-op        | `"page-missing"`        |
| Cached page id is archived on server                 | Treat as removed; if JSX still has `<ChildPage>`, create fresh | `"page-archived"`       |
| `pages.create` succeeds but child ops fail mid-apply | Archive orphan page; surface `NotionSyncError`                 | `"partial-page-create"` |
| Diff produces malformed op-plan (invariant break)    | Abort; propagate `NotionSyncError`                             | n/a (error)             |

v0.1 implements `cold-cache`, `schema-mismatch`, and `page-id-drift`
(via a pre-flight `NotionBlocks.retrieve(cache.rootId)`). `block-missing`
is a v0.2 addition — under v0.1, a 404 on a cache-referenced block
propagates as a `NotionSyncError`. Callers receive the reason on the
`SyncResult`.

## Upload coordination

See `src/renderer/upload-registry.ts`.

v0.1 — pre-resolve (R14):

```tsx
const registry: UploadRegistry = { get: (hash) => records.get(hash) }
const element = (
  <UploadRegistryProvider value={registry}>
    <Page>…<Image ... /></Page>
  </UploadRegistryProvider>
)
```

Components call `useNotionUpload(hash, factory)` inside render. If a
registry is mounted and has an entry for `hash`, that record is used;
otherwise `factory()` runs synchronously. Async factories are not
supported in v0.1.

v0.2 — Suspense (R15):

The host-config already stubs the React 19 Suspense entries
(`maySuspendCommit`, `preloadInstance`, `startSuspendingCommit`,
`NotPendingTransition`, `HostTransitionContext`). A Suspense-aware
`useNotionUpload` will switch `updateContainerSync` → async root, and
`maySuspendCommit` will return true when the registry misses for a
hash. r3f's `useLoader` + `<Suspense>` (`pmndrs/react-three-fiber`
PR #3224) is the reference implementation pattern.

## Extension points

- **Custom block types:** add a host-tag projection in `blockProps` and
  a companion component. Under 50 LoC per type (S5). Undocumented types
  can be inlined via `<Raw>`.
- **Custom cache backends:** implement `NotionCache` externally
  (R10/R12).
- **Custom inline annotations:** use the `tag()` helper +
  `INLINE_TAG` symbol (`src/components/inline.tsx`) to wire a new
  annotation or kind into `flattenRichText`.

## Open design questions

- **DQ1 Nested blocks inside TEXT_LEAF containers.** _Resolved for v0.1:_
  `toggle` is already out of `TEXT_LEAF` and supports nested children.
  `callout`/`quote`/list-item/`to_do` remain rich-text-only until v0.2
  (see issue #62).
- **DQ2 `deepEqual` vs `hash` at diff time.** The diff currently trusts
  hash equality to imply structural equality. Safe under the current
  `stableStringify` but not audited for all prop shapes we may add
  (e.g. Buffers, Dates). Resolve by either switching to `deepEqual` or
  documenting a strict prop-type contract.
- **DQ3 Page-id drift + archived-block detection.** _Resolved for v0.1:_
  on cache load, the sync driver issues a single
  `NotionBlocks.retrieve(cache.rootId)` pre-flight. On 404/archived:
  invalidate cache + cold-rebuild with `fallbackReason =
"page-id-drift"`. Adds ~1 API call per sync — negligible vs savings.
  Finer-grained `"block-missing"` detection during `applyDiff` deferred
  to v0.2.
- **DQ6 Database-parented pages.** _Deferred._ `<ChildPage>` currently
  targets page-parented sub-pages only. A database parent would take
  `{parent: {database_id}}` and a custom `properties` map keyed by
  property name (empirically verified). Spec expansion: extend
  `ChildPageProps` with `properties` and `parent` discriminated-union; the
  driver routes the create the same way. No caching model change.
- **DQ7 `<ChildPage>` sibling reordering.** _Deferred, not a regression._
  Notion's `pages.move` only accepts a new parent, not a new sibling
  position under the same parent. A pure intra-parent reorder would have
  to go through archive + recreate (losing the id) or be deliberately
  unsupported. Recommend: unsupported in v1; the library emits a warning
  and keeps the existing order. Callers who need authoritative sibling
  order should place the ordering concern on their own state.
- **DQ4 Op batching via `position.after_block`.** _Deferred to v0.2._
  v0.1 op counts already meet the derisk targets; batched append adds
  id-mapping and partial-success complexity. v0.2 experiment goal:
  measure "mutation-suite API-call count with single-op appends" vs
  "…with batched appends under a shared parent".
- **DQ5 Upload-registry miss policy (R14).** _Resolved for v0.1:_
  `useNotionUpload(hash, factory)` calls `factory()` synchronously on
  miss and emits a `console.warn` one-liner documenting that callers
  are expected to pre-resolve. Suspense in v0.2 removes the need.
  Rationale: hard-erroring would block fallback paths during cache
  invalidation; a warning communicates intent without forcing a
  redesign.
