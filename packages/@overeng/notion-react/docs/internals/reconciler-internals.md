# Internals — Reconciler internals

Deep dive for contributors changing the reconciler itself. The
user-facing view lives in [Concepts → Reconciler](../concepts/reconciler.md).
The normative text lives in
[`../vrs/spec.md`](../vrs/spec.md) — when this
page and the spec disagree, the spec wins.

## Host-config shape

`src/renderer/host-config.ts` implements a `react-reconciler` host
config targeting React 19. Key entries:

| Entry                                                                                                               | Role                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `supportsMutation: true`                                                                                            | Mutation host — the reconciler calls `appendChild` / `insertBefore` / `removeChild` / `commitUpdate` directly |
| `createInstance(type, props, rootContainer)`                                                                        | Allocate an `Instance`; pluck `blockKey` from props                                                           |
| `createTextInstance(text)`                                                                                          | Allocate a `TextInstance` (absorbed into rich-text at projection time)                                        |
| `shouldSetTextContent`                                                                                              | Always `false` — we always build fiber children so rich-text projection can read them directly                |
| `appendInitialChild` / `appendChild` / `appendChildToContainer`                                                     | Mount a child; emit an `append` op if the parent has an id                                                    |
| `insertBefore` / `insertInContainerBefore`                                                                          | Mount + reorder; emit `insertBefore` op                                                                       |
| `removeChild` / `removeChildFromContainer`                                                                          | Detach; emit `remove` op if child has an id                                                                   |
| `commitUpdate(instance, type, old, new)`                                                                            | React 19 shape: project both prop sets, `deepEqual`, emit `update` only on difference                         |
| `maySuspendCommit` / `preloadInstance` / `startSuspendingCommit` / `NotPendingTransition` / `HostTransitionContext` | Suspense stubs — no-op for v0.1; carry the shape needed for the v0.2 upload path                              |
| `clearContainer`                                                                                                    | No-op — the sync driver owns the container lifecycle                                                          |

The React 19 host-config signature follows
`react-dom-bindings/src/client/ReactFiberConfigDOM.js`. An earlier
React-18-shaped implementation produced a 10× op amplification under
reorders (see the react-derisk report referenced in
[requirements.md](../vrs/requirements.md) A03); the current
host-config is op-optimal on the benchmark scenarios.

### Instance model

```ts
type Instance = {
  type: BlockType | 'raw'
  props: Record<string, unknown>
  id: string | null // tmp id from OpBuffer (or null pre-commit)
  blockKey: string | undefined // from props.blockKey; stripped from projection
  parent: Instance | null
  children: (Instance | TextInstance)[]
  rootContainer: Container
}

type TextInstance = { kind: 'text'; text: string; parent: Instance | null }

type Container = {
  readonly rootId: string
  readonly buffer: OpBuffer
  readonly topLevel: Instance[]
}
```

### `TEXT_LEAF` and rich-text projection

Blocks in `TEXT_LEAF` (`paragraph`, `heading_1..4`, `quote`, `callout`,
`code`, `bulleted_list_item`, `numbered_list_item`, `to_do`) project
their JSX children to `rich_text[]` via `flattenRichText`. The
reconciler still creates fibers for those children — `shouldSetTextContent`
is always `false` — so host-element children nested under a text-leaf
parent reconcile as proper child fibers rather than being folded into
`rich_text`. This lets e.g. a `<Paragraph>` under a `<BulletedListItem>`
be a nested block.

`toggle` is deliberately outside `TEXT_LEAF`: its header text comes
from the `title` prop, and its JSX children are nested blocks.

### `blockProps` projection

`blockProps(type, props)` is the unit of structural equality. It
produces the projected Notion-shaped payload **minus** the type-tagged
envelope — the sync driver wraps it in `{ object, type, [type]: {…} }`
at API time. Both `commitUpdate` (via `deepEqual`) and the candidate
tree (via `hashProps`) go through it.

`blockKey` is stripped from the projection so renderer-level identity
hints never appear in the hash or in the Notion payload.

## OpBuffer

Populated by the reconciler during render. Each new block gets a
monotonically increasing tmp-id (`tmp-1`, `tmp-2`, …). Parent ids in
`append` / `insertBefore` may be real Notion block ids (mounts under
previously-synced parents) or tmp-ids issued by the same buffer
(chained appends under a freshly mounted parent).

Two consumers:

- `renderToNotion` replays the buffer directly as the op plan.
- `sync` discards the buffer — the plan comes from `diff()` over the
  candidate and cache trees. The buffer still exists because
  react-reconciler requires a container.

## LCS diff

`src/renderer/sync-diff.ts`. For each parent, `diffChildren`:

1. **LCS over `(key, type)`.** The cache-indices in the longest
   common subsequence are "retained" — same key _and_ same block type.
   Type equality is part of the match predicate because Notion
   rejects block-type changes via `update`; a same-key type change
   materializes as remove + insert, not as a single `update`.
2. **Pre-compute `hasRetainedAfter[i]`.** For each candidate index,
   does any later candidate retain? This decides whether a new
   candidate can safely tail-append (no retained sibling follows) or
   must `insert` with an `after_block` anchor (otherwise Notion's
   tail-append would place it in the wrong position).
3. **Walk candidates in order.**
   - Retained: reuse the prior `blockId`. Emit `update` if
     `prior.hash !== cand.hash`. Recurse into the children.
   - Not retained (new or reordered): mint a `tmpId`. Append (if no
     retained sibling follows) or insert anchored on `prevRef`.
     Recursively emit appends for the new subtree.
4. **Emit removes.** For every cache child whose key is not retained,
   emit a `remove`.

### Why `(key, type)` and not just `key`

Folding type equality into the LCS predicate keeps `hasRetainedAfter`
honest. A type-changed node is treated as unretained — exactly like
a brand-new key — so surrounding reorder decisions stay correct.

### Invariants

- **Unique `blockKey` among siblings.** Enforced by
  `assertUniqueKeys` — throws synchronously from `diff()` on
  violation. The LCS and by-key map would silently collapse
  duplicates otherwise.
- **`blockId` never a tmp-id post-apply.** `resolveTreeIds` walks the
  candidate tree once more after `applyDiff` and rewrites any
  remaining `tmp-*` to real server ids before `candidateToCache`
  snapshots the tree.
- **Type changes materialize as remove + insert.** Enforced by the
  `(key, type)` match predicate in `retainedCacheIndices`.

## Sync driver — batching and checkpointing

`src/renderer/sync.ts`. The driver layers two optimizations on top of
the raw plan:

- **Append coalescing (#101).** Consecutive append/insert ops sharing
  a parent collapse into batched `NotionBlocks.append` calls capped at
  `APPEND_CHILDREN_MAX = 100` children per request. Positional
  semantics are preserved across batches by threading the last-minted
  server id as the `after_block` anchor for the next batch.
- **Per-batch checkpointing (#102).** After each successful API call
  the in-memory `WorkingCache` is updated and flushed via
  `cache.save`. A mid-sync failure leaves the cache reflecting
  exactly what landed on the server, so a retry diffs against reality
  rather than against a stale pre-failure snapshot.

### Atomic containers

`column_list` (and future peers listed in `ATOMIC_CONTAINERS`) are
rejected by Notion's `append children` endpoint when their
descendants are supplied out of band. The driver inlines the subtree
into a single nested request body (`{ column_list: { children: [...] }
}`) and skips the descendant ops via the `absorbed` set.

## Cache schema

```ts
export const CACHE_SCHEMA_VERSION = 3 as const

export interface CacheNode {
  readonly key: string
  readonly blockId: string
  readonly type: string // needed for same-key type-change detection
  readonly hash: string
  readonly children: readonly CacheNode[]
}

export const CacheTree = Schema.Struct({
  schemaVersion: Schema.Number,
  rootId: Schema.String,
  children: Schema.Array(CacheNode),
})
```

Persisted via the `NotionCache` interface:

```ts
interface NotionCache {
  readonly load: Effect<CacheTree | undefined, CacheError>
  readonly save: (tree: CacheTree) => Effect<void, CacheError>
}
```

Schema mismatches fall through to a cold-start diff (the stale tree is
still used for matching where keys line up; `fallbackReason =
"schema-mismatch"`). A schema bump invalidates every existing cache
file but does not corrupt data.

### When to bump the schema

Bump `CACHE_SCHEMA_VERSION` when the on-disk shape changes
incompatibly — new required fields, changed hash formula,
incompatible key prefix. Don't bump for additive optional fields.
Every bump costs one cold diff per caller on first run; that is
cheap but not free.

## See also

- [Concepts → Reconciler](../concepts/reconciler.md) — user-facing
  view.
- [Internals → Architecture](./architecture.md) — module layout and
  data flow.
- [`../vrs/spec.md`](../vrs/spec.md) — normative
  spec with the fallback decision table and open design questions.
