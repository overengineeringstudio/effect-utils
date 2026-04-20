# Reconciler

A `sync` call turns a React tree into the minimum Notion op sequence.
This page orients integrators on what happens between JSX and the
Notion API.

## Pipeline

```
  JSX            react-reconciler         CandidateTree          DiffOp[]           Notion API
+--------+      +---------------+        +--------------+      +-----------+      +------------+
| <Page> | ---> | host-config   | -----> | keys, types, | ---> | append    | ---> | append     |
|   …    |      | builds        |        | hashed props |      | insert    |      | update     |
| </Page>|      | Instance tree |        | + children   |      | update    |      | delete     |
+--------+      +-------+-------+        +------+-------+      | remove    |      +-----+------+
                        |                       ^              +-----------+            |
                        v                       |                    ^                  v
                 +------+-------+          +----+-----+              |          +-------+------+
                 |  OpBuffer    |          | diff()   |<-------------+          | NotionCache  |
                 |  (discarded  |          | LCS over |                         | save()       |
                 |   in sync)   |          | keys     |<---- load() ------------|              |
                 +--------------+          +----------+                         +--------------+
```

The full pipeline in one call:

1. **Load.** `cache.load` returns the prior `CacheTree` (or `undefined`
   for cold start / schema mismatch).
2. **Render.** `buildCandidateTree` drives react-reconciler over the
   JSX. The host-config (`src/renderer/host-config.ts`) translates
   each host element into an `Instance` and projects its props onto a
   Notion-shaped payload.
3. **Project.** Each `Instance` becomes a `CandidateNode` with a key
   (`k:<blockKey>` or `p:<index>`), its block type, the projected
   props, and a djb2 hash of those props.
4. **Diff.** `diff(prior ?? empty, candidate)` recursively computes an
   LCS over `(key, type)` pairs at each level, emitting `update` for
   hash mismatches, `append`/`insert` for new nodes, and `remove` for
   stale cache entries. The result is a flat `DiffOp[]` plan.
5. **Apply.** `applyDiff` executes each op against
   `NotionBlocks.{append, update, delete}`. Consecutive appends/inserts
   under the same parent are batched into `append children` calls
   capped at 100 per request. Server-assigned block ids are threaded
   into a tmp-id → real-id map so chained ops resolve.
6. **Checkpoint.** After each successful API call the in-memory
   working cache is updated and flushed via `cache.save`. A mid-sync
   failure leaves the cache reflecting exactly what landed on the
   server, so retrying runs a diff against reality.
7. **Finalize.** The fully-resolved candidate tree is written to the
   cache as the authoritative snapshot.

## `renderToNotion` vs `sync`

| Entry point      | Use when                           | Cache? | Op model                        |
| ---------------- | ---------------------------------- | ------ | ------------------------------- |
| `renderToNotion` | First-time append to an empty page | none   | Replay OpBuffer directly        |
| `sync`           | Any subsequent render              | yes    | Diff CandidateTree vs CacheTree |

`renderToNotion` is append-only. It trusts the OpBuffer the reconciler
built during render and issues `append` / `insertBefore` ops in emit
order. Use it for cold starts where you know the page has no prior
content the library needs to reconcile with.

`sync` is the steady-state path. The OpBuffer from the reconciler is
discarded; the plan comes from the diff. This is where the
op-minimality guarantees live.

## Op-minimality guarantees

With stable `blockKey`s ([Keys and identity](./keys-and-identity.md)):

- **Idempotent.** Re-rendering the same JSX emits zero mutations.
- **Single update.** Changing one block's props emits exactly one
  `update`.
- **Single insert/remove.** Adding or removing one sibling emits
  exactly one op.
- **Nested stability.** A change deep in a subtree does not ripple:
  ancestors are `update`-free unless their own projection changed.

These are enforced by the [`mutations.e2e.test.tsx`](../testing.md)
suite against real Notion.

## Ordering guarantees

Ops are issued in a single pass, in emit order:

- **Parent-first.** A child of a newly-appended parent is scheduled
  after the parent's `append` response returns, so the parent's server
  id is known.
- **Reorders materialize.** Notion has no `move` API. A sibling whose
  key exists in the cache but falls out of the LCS is removed and
  re-inserted. The `removes` and `inserts` counts on `SyncResult`
  reflect that.
- **Sibling append coalescing.** Consecutive `append`/`insert` ops
  sharing a parent are coalesced into batched `NotionBlocks.append`
  calls capped at 100 children per request. Positional anchors
  (`after_block`) are threaded across batches so insertion order is
  preserved.
- **Atomic containers.** `column_list` (and future peers) are inlined
  into a single nested request body rather than issued as a sequence —
  Notion rejects these containers with the children supplied out of
  band.

## Manual-edit semantics

The React tree is the source of truth. When a user edits a synced
block directly in Notion, the next `sync` overwrites the edit with
the tree's projection. This is by design (A04 in
[requirements.md](../../context/vrs/requirements.md)): the region the
library reconciles is treated as single-writer. Keep user-editable
content outside the synced subtree.

## Fallbacks

`SyncResult.fallbackReason` is set when the driver took a non-standard
path:

| Condition                                      | `fallbackReason`    | Behaviour                                 |
| ---------------------------------------------- | ------------------- | ----------------------------------------- |
| No prior cache (cold start)                    | `"cold-cache"`      | Diff against an empty tree                |
| `schemaVersion` mismatch                       | `"schema-mismatch"` | Diff against stale tree; keys still match |
| `rootId` in cache does not match `opts.pageId` | `"page-id-drift"`   | Diff against an empty tree                |

Undefined means the warm path ran cleanly. A Notion API error
propagates as a tagged `NotionSyncError` — no fallback.

## Non-goals

- **Concurrent mode / Suspense.** v0.1 renders synchronously. The host
  config stubs the React 19 Suspense entries; a Suspense-backed upload
  path ships in v0.2.
- **Merging concurrent human edits.** See "Manual-edit semantics"
  above.
- **Cross-page reconciliation.** One `sync` call reconciles one page.

## See also

- [Internals → Reconciler internals](../internals/reconciler-internals.md)
  — host-config entries, LCS implementation, cache schema.
- [`../context/vrs/spec.md`](../../context/vrs/spec.md) — normative
  spec.
