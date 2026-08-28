# Spec — @overeng/notion-react

This document specifies how `@overeng/notion-react` renders JSX trees into
Notion block pages incrementally. It builds on
[requirements.md](./requirements.md).

**Status:** Draft — core block reconciler, LCS diff, cache v3, and page-op
reconciliation are implemented. Suspense uploads remain open.

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
- Markdown endpoint completeness, `.nmd` clean-base adoption, or datasource-sync
  body guards — those live in `@overeng/notion-core`,
  `@overeng/notion-effect-client`, `@overeng/notion-md`, and
  `@overeng/notion-datasource-sync`. (The read-only Markdown _projection_
  defined here is a local serialization of authored JSX; it performs no
  endpoint round-trip and no body settlement.)
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

`@overeng/notion-react` is an owned-region writer. It reconciles the page
regions it renders from JSX and its cache; it is not the authority for adopting
Notion Markdown endpoint output as a clean `.nmd` base. Body-fidelity evidence
may later be useful here for preflight or drift reporting, but guarded Markdown
adoption and datasource-sync body settlement stay outside the React critical
path.

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
the Notion block type (`page`, `paragraph`, `heading_1` … `heading_4`,
`toggle`, `to_do`, `bulleted_list_item`, `numbered_list_item`, `callout`,
`quote`, `code`, `divider`, `image`, `video`, `audio`, `file`, `pdf`,
`bookmark`, `embed`, `equation`, `link_to_page`, `child_page`, `table`,
`table_row`, `column_list`, `column`, `table_of_contents`). Props carried
on the host are consumed by the host-config `blockProps` projection.

Escape hatches and passthrough wrappers (`Raw` and related low-level
components) emit freeform or lightly modeled payloads for block types the
library does not yet model as first-class props.

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
list-item variants, `to_do`) treat primitive and inline React children as
rich text (R02). Host block children nested under these parents are
reconciled as Notion block children where the Notion API supports that
shape. `table_row` is not a text leaf; its cells are projected through
the table-row payload model. `toggle` supplies its header via the `title`
prop and reconciles nested block children below that header.

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
  "rootTitleHash": "...",
  "rootIconHash": "...",
  "rootCoverHash": "...",
  "children": [ CacheNode, ... ]
}
```

Each `CacheNode` carries `nodeKind: 'block' | 'page'`. Page-kind nodes
additionally carry `titleHash`, `iconHash`, `coverHash` (djb2 of
response-normalized projections per A07) and recurse into their own
`children` with their own key namespace.

A newly created page may temporarily carry `pendingInlineResolution`: an
immutable tree of create-time inline `(key, type, hash, children)` descriptors.
The page id is already authoritative at that point; the marker records that
the inline block ids auto-created by `pages.create` must still be observed and
adopted before normal diffing. It is removed only after adoption and another
successful cache save (R28).

`FsCache` treats missing files, malformed payloads, and schema mismatches as
cache misses by returning `undefined` from `load`. The sync driver then runs a
cold diff against an empty tree. Cache backends that can retain old payloads for
diagnostics may report richer mismatch information, but they must not feed
stale cache entries into mutation planning without an explicit migration.

### Key derivation (R07)

`instanceKey(inst, index) = NodeKey.keyed(inst.blockKey) | NodeKey.positional(index)`.
The `NodeKey` encoder (`keys.ts`, exported) is the single source of the
`k:<blockKey>` / `p:<index>` scheme; `instanceKey` routes through it so
external cache constructors and the reconciler cannot disagree on the
encoding. React's `key` prop is forwarded via the `blockKey` host prop
(helper `blockKey(businessId)` returns `"b:<id>"` for namespacing).

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
       - if createPage: insert a page CacheNode carrying the real id and
         create-time inline descriptors, then save the cache before retrieval
       - retrieve the page's live inline descendants, validate their types,
         adopt their ids, clear the pending marker, and save again
       - recurse: sync(childElement, { pageId: real, cache: cache.pages[real] })
  7. on any error mid-recursion:
       - preserve the most recent successful checkpoint; never discard a
         created page id or archive-and-recreate merely because resolution or
         later child work failed (T06/R28)
       - propagate NotionSyncError with fallbackReason when applicable
  8. checkpoint cache after every successful page-level step
  9. SyncResult includes pages: { creates, updates, archives, moves }
```

Ordering invariants:

- `createPage` must complete before any block op scoped to its id.
- The returned page id and pending inline descriptors must be saved before the
  first post-create retrieval. On retry, pending inline resolution runs before
  candidate diffing. Type disagreement between a descriptor and the live block
  fails closed; it never guesses an id mapping.
- `archivePage` (emitted for removed `<ChildPage>`) is applied after block
  ops that touch its parent (so the parent's child_page block disappears
  from the parent's children list in the same sync pass).
- Same-parent `createPage` is sequential (T08): `pages.create` calls
  under a common parent run one at a time via the driver's `for`-of
  `yield*` loops (no `Effect.all` / concurrency). The resulting server
  `child_page` order matches JSX order, so no post-create re-fetch is
  needed.

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

| Trigger                                             | Behaviour                                                                   | `fallbackReason`     |
| --------------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| No cache file                                       | Cold diff; `'clean'` first represents live roots as removable ghosts        | `"cold-cache"`       |
| `FsCache` persisted schema mismatch                 | `FsCache.load` returns `undefined`; sync runs the no-cache path             | `"cold-cache"`       |
| Prior tree `schemaVersion !== CACHE_SCHEMA_VERSION` | Diff against the prior identity-bearing tree without recursive preflight    | `"schema-mismatch"`  |
| Cache `rootId !== opts.pageId`                      | Use the no-cache path for the requested page                                | `"page-id-drift"`    |
| Warm recursive identity tree differs from cache     | Diff against `driftedBase(live, prior)` at every observed owned scope       | `"cache-drift"`      |
| Promised-nonempty children stay empty after retries | Abort before drift classification or mutation; preserve the prior cache     | n/a (typed error)    |
| Opaque block reports inherited children             | Stop traversal at the opaque block; inherited content is not renderer-owned | n/a                  |
| `NotionBlocks.update` returns 404/archived          | Emit structural rebuild of that subtree                                     | `"block-missing"`    |
| Cached page id → `pages.retrieve` 404               | Drop cached subtree, recreate if JSX has it, else no-op                     | `"page-missing"`     |
| Cached page id is archived on server                | Treat as removed; if JSX still has `<ChildPage>`, create fresh              | `"page-archived"`    |
| Post-create inline retrieval or later work fails    | Preserve identity checkpoint; retry adopts live inline ids                  | n/a (original error) |
| Diff produces malformed op-plan (invariant break)   | Abort; propagate `NotionSyncError`                                          | n/a (error)          |

`block-missing` remains a later apply-time refinement; a 404 on a
cache-referenced block currently propagates as `NotionSyncError`. Every
implemented fallback reason is returned on `SyncResult`.

## Recursive identity preflight (R04, R16, R18, R38, T14)

```text
children list (root)
  → renderer-owned block/page scopes
      → identityTreeDrifted(prior, live)
          ├─ equal   → diff(prior, candidate)
          └─ drifted → diff(driftedBase(live, prior), candidate)
                         → strip drift ghosts before every checkpoint
```

`sync()` and live `plan()` share `retrieveLiveIdentities`,
`identityTreeDrifted`, `driftedBase`, and `selectDiffBase`.
`retrieveLiveIdentities` builds an ordered tree of `{ blockId, type,
children }`. Root and ordinary block children compare in server order.
Children under a `child_page` scope compare by block id because page-scoped
application may interleave block and page work.
Traversal uses a positive ownership boundary. It descends through the
renderer-owned child-bearing wire types (paragraph, toggleable headings, list
items, to-do, toggle, quote, callout, table, column-list, and column) when the
response reports children, and always opens a `child_page` scope. It does not
descend through opaque passthrough wire types such as `synced_block`,
`template`, `link_preview`, `child_database`, or `breadcrumb`. In particular,
a `<SyncedBlock>` may report `has_children: true` for content inherited from
its synchronization source; those descendants are source-owned and must never
become removals or cache entries in this renderer's tree.

Each children-list pagination page is one physical request. If a parent
response promised `has_children: true` but the complete child list is empty,
the whole list is retried on the bounded settle schedule (500 ms exponential
backoff at factor 1.5, up to four retries). Exhaustion fails closed with
`NotionSyncError { reason: 'children-not-yet-visible' }`; neither
`identityTreeDrifted` nor `diff` runs against the ambiguous empty observation.

When identities drift, `driftedBase` recursively indexes prior siblings by
`blockId`. A still-live node keeps all known cache metadata (`key`, hashes,
node kind, page metadata, and pending state) while its children are merged by
the same rule. An untracked live node becomes an in-memory **drift ghost**:
it carries the live block id/type but a synthetic `drift:<blockId>` key and
empty hash, so the ordinary diff can reconcile or remove it. Drift ghosts are
stripped recursively when initializing the working cache and before every
checkpoint; only identities confirmed by successful operations can repopulate
the persisted and returned `CacheTree`.

Telemetry is accounted at the physical-request boundary. Every pagination
page and every settle retry increments `opCount` once and emits its own
`OpIssued` followed by `OpSucceeded` or `OpFailed`, all with kind
`'retrieve'`. `SyncMetrics.actualOps.retrieve`, aggregate OER, and
`SyncEnd.opCount` therefore include the full recursive read volume rather than
one synthetic count for the tree walk.

## plan() — read-only companion (R37–R38)

`plan()` composes the same preflight helpers with `diff()` and
`rootPageUpdateOpFor` and returns without applying:

```ts
interface SyncPlan {
  ops: readonly DiffOp[] // exact sequence sync() would apply, root updatePage included
  blocks: { appends; updates; inserts; removes }
  pages: { creates; updates; archives; moves; reorders }
  fallbackReason: SyncFallbackReason | undefined
  empty: boolean // the fixpoint oracle
}
```

Including the root `updatePage` in `ops` is load-bearing: without it the
empty-plan fixpoint oracle would miss root metadata drift.

Staleness (R38, T11, T14):

- **`'live'` (default):** performs the recursive renderer-owned identity
  preflight above plus in-memory pending-marker adoption (never persisted by
  `plan()`). It detects nested and child-page drift and reports
  `fallbackReason: 'cache-drift'`. It remains an observation without snapshot
  isolation; `sync()` recomputes before applying.
- **`'cache-only'`:** is a pure function of cache + JSX and issues zero
  requests. It is blind to server-only state at every depth, the
  cold-`'clean'` baseline sweep, and pending-marker resolution.

Live plan requests emit the same per-request retrieve events as sync, followed
by one `PlanComputed`. Plan emits no `SyncStart`, `SyncEnd`, or `CacheOutcome`,
so plan probes do not skew sync-duration or cache-efficiency aggregates.

## Readback oracle (R39–R40)

`readback.ts` answers "does the live page equal what this JSX renders?"
in one dedicated hash space. Both sides — server-observed block JSON
(response shape) and the rendered `CandidateTree` (request-shape props)
— normalize into `NormalizedReadbackNode` trees and hash through the
shared `hashStable`:

```ts
compareReadback({ candidate, observed })
// → { candidateHash, observedHash, equal, candidate, observed }
compareReadbackPage({ candidate, observed }) // page title/icon/cover envelope
observeBlockTree({ blockId }) // effectful ObservedBlockTree walk
```

**Separate hash space (R39).** `CacheNode.hash` hashes request-shape
projected props; readback hashes hash the canonical readback form. Both
use `hashStable` (djb2 over stable-stringify) but are never comparable
against each other. Unifying them would change the cache hash function
and invalidate every deployed cache, so the two spaces are permanent.

**Canonicalization.** Rich-text runs get fully explicit annotation
frames, empty text runs drop, adjacent identical-frame text runs
coalesce (Notion re-segments), mention envelopes reduce to
`{type, ref}` (the response expands referenced objects), and
`plain_text` / `href` are dropped as derived. Per-type props fold
explicit API defaults (`color`, `is_toggleable`, `checked`, table
header flags, empty captions).

**Candidate-contextual masking (R40).** `maskProviderOwned` blanks
fields on the observed side only where the candidate made no claim:
callout `icon`, code `language`, column `width_ratio`, table
`table_width`. Claimed values compare exactly. Two things are masked
unconditionally because block JSON cannot verify them: uploaded media
sources (`file_upload` request / expiring signed-URL `file` response →
`uploaded` sentinel) and, on page metadata, the A07 built-in-icon
rewrite (external notion.so/icons URL ↔ undocumented `{type:'icon'}`
envelope → `builtin-unverified` sentinel).

**Boundaries.** `child_page` blocks compare by title identity only and
are never recursed into — a sub-page is its own reconciliation unit
(R26) and gets its own `compareReadback` (blocks) +
`compareReadbackPage` (envelope) pass; `observeBlockTree` stops at the
same boundary. Raw escape-hatch payloads (`<Raw>`, `synced_block`, …)
throw: their response shape is not normalizable generically.

**Relation to plan().** `plan().empty` proves cache×intent convergence;
`compareReadback` proves server×intent equality. The pair brackets the
cache: a page can be plan-empty yet readback-unequal (cache poisoned or
server edited out of band) and vice versa. Like a plan, an observation
is advisory for the observed window (T11/T12) — there is no snapshot
isolation across the paginated children walk.

## Page-lifecycle enforcement (R41)

`pageLifecycle: 'managed' | 'append-only'` on `sync()`/`plan()`
(default `'managed'`, the full existing contract). `'append-only'`
exists for consumers managing an irreplaceable live tree — pages whose
identity carries grants and cannot be recreated through the public API
— where a JSX bug (or diff edge case) implying page destruction must
fail before mutation, not execute.

The enforcement point is `pageLifecycleViolations({ ops, candidate })`
(`page-lifecycle.ts`): one pure predicate over the computed plan plus
the diffed candidate tree, evaluated immediately after `diff()` — the
first point where the full op set exists and before anything applies.
Violations, in plan order:

- every `archivePage` / `movePage` / `reorderPages`;
- every `createPage` whose page sits before a retained page sibling in
  candidate order. Notion creates children at the tail, so additive page
  publication is append-last by nature; a consumer wanting a fixed
  presentation order must accept tail placement rather than reorder (a
  reorder is a second, non-atomic lifecycle op on an irreplaceable
  tree). The tail test needs the candidate tree — the ops alone cannot
  tell a tail create from a mid-run create.

`sync()` fails the whole sync with
`NotionSyncError { reason: 'page-lifecycle-violation', violations }`
before any op applies — fail, not skip: dropping the offending ops
would silently diverge server from cache. This is a plan predicate,
not a mid-apply guard ("a late counter guard is not an apply
boundary"). `plan()` evaluates the same predicate into
`SyncPlan.lifecycleViolations` without failing — a free preview, and
present only when the option was passed.

Under the mode, block ops and page content (`updatePage`, including
the root-metadata update) remain fully managed. #1100
pending-adoption runs before the diff and is read + cache-save only,
so crash recovery stays legal: a checkpointed page that _moved_ in the
retry JSX is adopted first (harmless) and its implied `movePage` then
rejected by the predicate.

## Fail-closed adoption (R42–R44)

`adopt(element, { pageId, onContentDrift? })` (`adopt.ts`) rebuilds the
cache a stateless consumer lost, from live observation alone:

```
buildCandidateTree ──► keys + hashes (candidate side ONLY — blockKey is
                       never stored in Notion, so there is no recovery
                       problem to solve)
observeBlockTree   ──► live children per parent, in-trash excluded
positional walk    ──► candidate i ↔ live i, per parent, collecting
                       refusals; recursion crosses child_page boundaries
                       (fresh observation per page) and descends whenever
                       EITHER side expects children
candidateToCache   ──► the clean-path snapshot + root metadata hashes
```

Verification per bound pair, in order:

1. **type** — live block type must equal the candidate's;
2. **content** — through `compareReadback`, one node at a time with
   children stripped on both sides, so a drifted descendant pins the
   descendant, not its ancestors. Reusing the readback oracle (rather
   than hashing a hand-projected live payload) is what makes adoption
   correct against the real API's response decoration; any
   adopt-specific tolerance belongs in readback's masking table, never
   in a forked normalizer. Nodes readback cannot normalize (`<Raw>`
   payloads) refuse as `UnverifiableContent` — fail closed, never
   trust;
3. **page claims** — for `child_page` nodes and the root `<Page>`,
   title/icon/cover claims verify per field via `compareReadbackPage`
   against `pages.retrieve` (field-level `PageMetaDrift`), so the A07
   icon rewrite and uploaded-cover envelopes are absorbed by the
   shipped page masking; a trashed root refuses (`RootTrashed`). Root
   metadata is only checked when the JSX carried root claims —
   mirroring `sync()`'s own contract.

All refusals collect into one `AdoptionRefusedError` (never first-fail),
and every outcome — success or refusal — performs zero mutations.

Recovery (R44): `'adopt-live'` records, at content-drifted block nodes
only, `adopt-live:<observedReadbackHash>` in `CacheNode.hash`. The
marker is deliberately NOT a cache-space hash (R39 forbids cross-space
comparison; the response→request projection needed to compute the true
live cache hash does not exist) — its contract is deterministic
inequality with the candidate's hash, which makes the next `sync()`
emit exactly one `update` per drifted node. Drifted page-metadata
fields record the live claim's cache-space hash (computable via the
shared `normalizeTitle`/`normalizeIcon`/`normalizeCover`), or drop the
field when the live side is unset — either way the next sync emits one
repairing `updatePage`. After the repair, strict re-adoption succeeds
and `plan()` is empty.

Relation to #1100: `adoptInlineChildren` (crash recovery for inline
creates) is the positional prior art — same binding rule, but it trusts
the persisted create-time hashes because the same process wrote them
moments earlier. `adopt()` is its strict strengthening for trees the
adopter did not write: every hash is re-derived candidate-side and
every binding content-verified. The walkers stay separate because their
inputs differ (`PendingInlineNode` intent vs full candidate tree) and
the recovery path must not destabilize.

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

## Markdown projection (read-only, experimental)

See `src/markdown/`. Entry point: `@overeng/notion-react/markdown`.

`renderToNotionMarkdown(element)` reuses the production render pass —
`buildCandidateTree` over the same reconciler host-config that feeds Notion
projection — and serializes the resulting `CandidateTree` to a readable
Notion-enhanced-Markdown body. It is pure, synchronous, network-free, and
performs no Notion mutation, no cache read/write, and no diff.

```ts
const { body, diagnostics } = renderToNotionMarkdown(<Instructions />)
```

Contract:

- **Shared semantics, separate serializer.** The projection shares the
  normalized instance/CandidateTree representation with the Notion path but
  owns its block→Markdown spellings. It deliberately does not delegate to
  `NotionMarkdown.treeToMarkdown` in `@overeng/notion-effect-client`: that
  renderer is the pull-side wire serializer (no diagnostics channel, silent
  unknown-type drop, hardcoded list numbering, non-GFM table output), and
  modifying it for review-artifact needs would risk `.nmd` wire-format drift.
  Spellings align with the pull-side dialect where sound (`<details>` toggles,
  blockquote callouts, `[TOC]`, fenced code). Drift between the two spelling
  tables is mitigated by golden tests; centralization is deferred until a
  second consumer justifies it (decision 0001).
- **Diagnostics, not silence.** Constructs that cannot survive projection
  emit a typed `MarkdownDiagnostic` (`unsupported-block`,
  `media-without-url`, `color-dropped`, `flattened`) alongside the body.
  Nothing disappears silently; nothing fails hard either — the body is always
  produced.
- **Fidelity policy.** Colors and other unrepresentable attributes are
  dropped with diagnostics. `blockKey` is absent from the body (renderer
  identity, consistent with the Notion payload projection). Toggleable
  headings flatten to heading + following content. `<ChildPage>` flattens to
  a bold label + inline content. Unsupported/`Raw` blocks emit an HTML-comment
  placeholder. Media referencing `file_upload` (no offline-resolvable URL)
  emits a placeholder + diagnostic.
- **Composition.** The body is a plain string and composes with
  `@overeng/notion-md`'s `renderNmdFile({ frontmatter, body })` at the
  caller's discretion. `@overeng/notion-react` holds only a devDependency on
  `@overeng/notion-md` for the composition test; production code never
  imports it, and the forbidden reverse dependency does not exist.
- **Status.** Experimental (#1097): spellings and the diagnostics contract may
  change until a real consumer proves the output. The body is a review
  artifact, not a canonical Notion round-trip representation, and Markdown
  equality must not be read as CacheTree identity or sync safety.

Satisfies R31–R36: shared tree semantics (R32, no HTML scraping), read-only
offline operation (R31), no-silent-loss diagnostics (R33), deterministic
output (R34), envelope composition without reverse coupling (R35), and
documented experimental status distinguishing projection fidelity from
reconciliation and endpoint round-trip fidelity (R36). Terminology follows
[ontology.md](./ontology.md).

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
- **DQ7 `<ChildPage>` sibling reordering.** _Addressed via opt-in
  `reorderSiblings` (phase 4d, #618)._ Notion's `pages.move` rejects a
  same-parent move, but a roundtrip — move to another parent, then back
  to the original — bumps the page to the end of the original parent's
  `child_page` block list (empirical: see
  `tmp/notion-618/options-ordering.md` experiment 9). Iterating the
  target order through that roundtrip lands arbitrary sibling order at
  2N `pages.move` calls per reorder burst. Opt-in via
  `sync(element, { pageId, cache, reorderSiblings: true })`; default
  stays the legacy no-op to preserve existing call sites that emit
  same-parent `movePage`s. Callers can supply their own
  `{ holdingParentId }` to avoid the library minting-and-archiving a
  scratch page per sync.
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
