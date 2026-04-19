# Spec — @overeng/notion-react

This document specifies how `@overeng/notion-react` renders JSX trees into
Notion block pages incrementally. It builds on
[requirements.md](./requirements.md).

**Status:** Draft — core reconciler + LCS diff landed (Phases 1–2 on
branch `schickling/2026-04-19-notion-react`), nested children support and
Suspense uploads are open.

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
(`src/components/inline.tsx`). They are *not* rendered as host nodes;
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
  id: string | null          // tmp id from OpBuffer (or null pre-commit)
  blockKey: string | undefined  // from props.blockKey
  parent: Instance | null
  children: (Instance | TextInstance)[]
  rootContainer: Container
}
type TextInstance = { kind: 'text'; text: string; parent: Instance | null }
type Container = { rootId: string; buffer: OpBuffer; topLevel: Instance[] }
```

### React 19 host-config entries

Mutation host (`supportsMutation: true`). Key entries:

| Entry                                                | Role                                                    |
|------------------------------------------------------|----------------------------------------------------------|
| `createInstance(type, props, rootContainer)`         | Allocate an `Instance`                                   |
| `createTextInstance(text)`                           | Allocate a `TextInstance`                                |
| `shouldSetTextContent(type, props)`                  | Return true for leaf text blocks (see `TEXT_LEAF` set)   |
| `appendInitialChild` / `appendChild` / `appendChildToContainer` | Mount a child; emit append op if parent has an id |
| `insertBefore` / `insertInContainerBefore`           | Mount + reorder; emit `insertBefore` op                  |
| `removeChild` / `removeChildFromContainer`           | Detach; emit `remove` op if child has an id              |
| `commitUpdate(instance, type, oldProps, newProps)`   | R19 shape: project both prop sets, `deepEqual`, emit `update` only on change |
| `commitTextUpdate`                                   | Update in-memory text; no op (text is re-projected via `blockProps`) |
| `maySuspendCommit` / `preloadInstance` / `startSuspendingCommit` / etc. | React 19 Suspense stubs (no-op for v0.1) |
| `clearContainer`                                     | No-op (sync driver owns the container lifecycle)         |

The host-config signature follows React 19
(`react-dom-bindings/src/client/ReactFiberConfigDOM.js`). The derisk
report identified a React-18 signature mismatch as the source of a prior
10× op-amplification bug; the current host-config matches React 19
exactly and is op-optimal on the benchmark scenarios.

### `TEXT_LEAF` and block-children

`TEXT_LEAF` blocks (`paragraph`, `heading_*`, `quote`, `callout`, `code`,
list-item variants, `to_do`, `table_row`) treat their React children as
rich text (R02). Their children are *not* reconciled as fiber children
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

1. **`renderToNotion` (append-only cold start):** The buffer's ops *are*
   the plan; applied in order, tmp-ids resolved as Notion returns real
   ids.
2. **`sync` (incremental):** The buffer is populated by the reconciler
   during `buildCandidateTree` but its ops are discarded. The plan is
   instead produced by `diff()` over the candidate+cache trees. The
   buffer is still needed because react-reconciler requires a container.

## CandidateTree / CacheTree

```ts
interface CandidateNode {
  key: string       // `k:<blockKey>` or positional `p:<index>`
  type: BlockType
  props: Record<string, unknown>  // output of blockProps()
  hash: string                     // djb2 of stableStringify(props)
  blockId: string | undefined      // unset until resolved
  children: CandidateNode[]
}

interface CacheNode {
  key: string
  blockId: string
  hash: string
  children: readonly CacheNode[]
}
```

**Cache schema v1** (`CACHE_SCHEMA_VERSION = 1`):

```json
{
  "schemaVersion": 1,
  "rootId": "<page uuid>",
  "children": [ CacheNode, ... ]
}
```

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
acceptable since equal hashes imply the caller's projection *is* the
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

| Trigger                                           | Behaviour                                   | `fallbackReason`    |
|---------------------------------------------------|---------------------------------------------|---------------------|
| No cache file                                     | Cold diff against empty tree                | `"cold-cache"`      |
| Cache `schemaVersion !== CACHE_SCHEMA_VERSION`    | Diff against stale tree, still reuses keys  | `"schema-mismatch"` |
| Cache `rootId !== opts.pageId`                    | Cold diff against empty tree                | `"page-id-drift"`   |
| `NotionBlocks.update` returns 404/archived        | Emit structural rebuild of that subtree     | `"block-missing"`   |
| Diff produces malformed op-plan (invariant break) | Abort; propagate `NotionSyncError`          | n/a (error)         |

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

- **DQ1 Nested blocks inside TEXT_LEAF containers.** *Resolved for v0.1:*
  `toggle` is already out of `TEXT_LEAF` and supports nested children.
  `callout`/`quote`/list-item/`to_do` remain rich-text-only until v0.2
  (see issue #62).
- **DQ2 `deepEqual` vs `hash` at diff time.** The diff currently trusts
  hash equality to imply structural equality. Safe under the current
  `stableStringify` but not audited for all prop shapes we may add
  (e.g. Buffers, Dates). Resolve by either switching to `deepEqual` or
  documenting a strict prop-type contract.
- **DQ3 Page-id drift + archived-block detection.** *Resolved for v0.1:*
  on cache load, the sync driver issues a single
  `NotionBlocks.retrieve(cache.rootId)` pre-flight. On 404/archived:
  invalidate cache + cold-rebuild with `fallbackReason =
  "page-id-drift"`. Adds ~1 API call per sync — negligible vs savings.
  Finer-grained `"block-missing"` detection during `applyDiff` deferred
  to v0.2.
- **DQ4 Op batching via `position.after_block`.** *Deferred to v0.2.*
  v0.1 op counts already meet the derisk targets; batched append adds
  id-mapping and partial-success complexity. v0.2 experiment goal:
  measure "mutation-suite API-call count with single-op appends" vs
  "…with batched appends under a shared parent".
- **DQ5 Upload-registry miss policy (R14).** *Resolved for v0.1:*
  `useNotionUpload(hash, factory)` calls `factory()` synchronously on
  miss and emits a `console.warn` one-liner documenting that callers
  are expected to pre-resolve. Suspense in v0.2 removes the need.
  Rationale: hard-erroring would block fallback paths during cache
  invalidation; a warning communicates intent without forcing a
  redesign.
