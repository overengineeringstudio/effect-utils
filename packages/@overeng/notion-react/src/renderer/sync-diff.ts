import type { ReactNode } from 'react'

import type { BlockType } from '@overeng/notion-effect-schema'

import type { CacheNode, CacheTree } from '../cache/types.ts'
import {
  blockChildren,
  createNotionRoot,
  projectProps,
  walkInstances,
  type Instance,
  type NodeKind,
} from './host-config.ts'
import {
  normalizeCover,
  normalizeIcon,
  normalizeTitle,
  projectCover,
  projectIcon,
  projectTitleSpans,
} from './icons.ts'
import type { PageOp } from './op-buffer.ts'
import { OpBuffer } from './op-buffer.ts'

/**
 * Rendered-but-not-yet-synced block or page. `blockId` starts unset; the
 * sync driver fills it either from the cache (for matched nodes) or from
 * Notion API responses (for new inserts/appends/creates).
 *
 * Page nodes (`nodeKind: 'page'`) carry normalized title/icon/cover payloads
 * and per-field hashes so the diff can emit a coalesced `updatePage` touching
 * only the fields that actually drifted. `tmpPageId` is the placeholder the
 * create op threads through to subsequent block ops scoped to the new page.
 */
export interface CandidateNode {
  readonly key: string
  readonly type: BlockType
  readonly props: Record<string, unknown>
  readonly hash: string
  blockId: string | undefined
  readonly children: CandidateNode[]
  readonly nodeKind: NodeKind
  readonly title?: readonly Record<string, unknown>[] | undefined
  readonly icon?: Record<string, unknown> | undefined
  readonly cover?: Record<string, unknown> | undefined
  readonly titleHash?: string | undefined
  readonly iconHash?: string | undefined
  readonly coverHash?: string | undefined
}

/**
 * Candidate-tree root metadata. When the author wraps the JSX in a `<Page>`,
 * the reconciler stashes its title/icon/cover on `container.pageRoot.props`;
 * `buildCandidateTree` lifts that into `rootPage` so the sync driver can
 * emit a root-level `updatePage` when metadata drifts.
 *
 * Absent when the sync element is a bare fragment (no `<Page>` wrapper) — in
 * that case the root page's metadata is out of scope for this sync call.
 */
export interface CandidateRootPage {
  readonly title?: readonly Record<string, unknown>[] | undefined
  readonly icon?: Record<string, unknown> | undefined
  readonly cover?: Record<string, unknown> | undefined
  readonly titleHash?: string | undefined
  readonly iconHash?: string | undefined
  readonly coverHash?: string | undefined
}

export interface CandidateTree {
  readonly rootId: string
  readonly children: CandidateNode[]
  readonly rootPage?: CandidateRootPage
}

/** Stable-keyed JSON stringify (object keys sorted recursively). */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .toSorted()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

/** djb2 hash of the stable-stringified projected block payload. */
const hashProps = (props: Record<string, unknown>): string => {
  const s = stableStringify(props)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

const instanceKey = (inst: Instance, index: number): string =>
  inst.blockKey !== undefined ? `k:${inst.blockKey}` : `p:${index}`

const hashAny = (value: unknown): string => {
  const s = stableStringify(value)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

const instanceToCandidate = (inst: Instance, index: number): CandidateNode => {
  const props = projectProps(inst)
  const children = blockChildren(inst).map(instanceToCandidate)
  if (inst.nodeKind === 'page') {
    const title = projectTitleSpans(inst.props.title)
    const icon = projectIcon(inst.props.icon as never)
    const cover = projectCover(inst.props.cover as never)
    return {
      key: instanceKey(inst, index),
      type: inst.type as BlockType,
      props,
      hash: hashProps(props),
      blockId: undefined,
      children,
      nodeKind: 'page',
      title,
      icon,
      cover,
      titleHash: title !== undefined ? hashAny(normalizeTitle(title)) : undefined,
      iconHash: icon !== undefined ? hashAny(normalizeIcon(icon)) : undefined,
      coverHash: cover !== undefined ? hashAny(normalizeCover(cover)) : undefined,
    }
  }
  return {
    key: instanceKey(inst, index),
    type: inst.type as BlockType,
    props,
    hash: hashProps(props),
    blockId: undefined,
    children,
    nodeKind: 'block',
  }
}

/**
 * Render `element` through the reconciler and extract the resulting tree
 * shape. The OpBuffer produced during this render is discarded — callers
 * derive ops by diffing against the cache, not by replaying the buffer.
 */
export const buildCandidateTree = (element: ReactNode, rootId: string): CandidateTree => {
  const buffer = new OpBuffer(rootId)
  const root = createNotionRoot(buffer, rootId)
  root.render(element)
  const pageRoot = root.container.pageRoot
  let rootPage: CandidateRootPage | undefined
  if (pageRoot !== null) {
    const title = projectTitleSpans(pageRoot.props.title)
    const icon = projectIcon(pageRoot.props.icon as never)
    const cover = projectCover(pageRoot.props.cover as never)
    rootPage = {
      ...(title !== undefined ? { title } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(cover !== undefined ? { cover } : {}),
      ...(title !== undefined ? { titleHash: hashAny(normalizeTitle(title)) } : {}),
      ...(icon !== undefined ? { iconHash: hashAny(normalizeIcon(icon)) } : {}),
      ...(cover !== undefined ? { coverHash: hashAny(normalizeCover(cover)) } : {}),
    }
  }
  return {
    rootId,
    children: walkInstances(root.container).map(instanceToCandidate),
    ...(rootPage !== undefined ? { rootPage } : {}),
  }
}

/**
 * Normalized block-scope op-plan. `tmpId`s are placeholder identifiers the
 * diff uses to wire up `after`/parent relationships across inserts that
 * chain; they are resolved to real Notion block ids when the plan is applied.
 *
 * `scopePageId` (issue #618): optional id of the subpage whose block tree
 * this op targets. Unset means the op targets the root page passed to
 * `sync()`. No current code path sets this — it exists so the forthcoming
 * page-scope reconcile can tag its emitted ops without a second union.
 */
export type BlockOp =
  | {
      readonly kind: 'append'
      readonly parent: string // parent blockId OR tmpId
      readonly tmpId: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
      readonly candidate: CandidateNode
      readonly scopePageId?: string
    }
  | {
      readonly kind: 'insert'
      readonly parent: string
      readonly tmpId: string
      readonly afterId: string // preceding sibling blockId or tmpId, or '' for head
      readonly type: BlockType
      readonly props: Record<string, unknown>
      readonly candidate: CandidateNode
      readonly scopePageId?: string
    }
  | {
      readonly kind: 'update'
      readonly blockId: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
      /** Post-update hash for the cache checkpoint (#102). */
      readonly hash: string
      /** New key (never changes on update; carried through for the cache). */
      readonly key: string
      readonly scopePageId?: string
    }
  | { readonly kind: 'remove'; readonly blockId: string; readonly scopePageId?: string }

/**
 * Full diff plan union: block ops and (forward-compat) page ops. The existing
 * reconciler only produces {@link BlockOp}s; {@link PageOp} is reserved for
 * issue #618 phase 2+.
 */
export type DiffOp = BlockOp | PageOp

/** Per-diff counter for tmpIds — reset at the top of `diff()`. */
let tmpCounter = 0
const nextTmp = (): string => {
  tmpCounter += 1
  return `tmp-diff-${tmpCounter}`
}

/**
 * Compute indices of cache children that stay (matched in order) using LCS on
 * (key, type) pairs. Returns a Set of cache-indices that are retained.
 *
 * Type equality is part of the match predicate because Notion does not allow
 * changing a block's type via `update` — a same-key type change has to
 * materialize as remove + insert. Folding the type check into LCS keeps the
 * `hasRetainedAfter` precomputation correct (a type-changed node is treated
 * as unretained, exactly like a brand-new key).
 */
const retainedCacheIndices = (
  cacheChildren: readonly CacheNode[],
  candidateChildren: readonly CandidateNode[],
): Set<number> => {
  const m = cacheChildren.length
  const n = candidateChildren.length
  // dp[i][j] = LCS length matching cache[..i], candidate[..j]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from<number>({ length: n + 1 }).fill(0),
  )
  const matches = (ci: number, cj: number): boolean =>
    cacheChildren[ci]!.key === candidateChildren[cj]!.key &&
    cacheChildren[ci]!.type === candidateChildren[cj]!.type &&
    // nodeKind boundary: a `<ChildPage>` and a block with the same key+type
    // must not match — Notion does not allow converting one to the other in
    // place, so a same-key mismatch materializes as archive/remove + create.
    cacheChildren[ci]!.nodeKind === candidateChildren[cj]!.nodeKind
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (matches(i - 1, j - 1)) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }
  const retained = new Set<number>()
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (matches(i - 1, j - 1)) {
      retained.add(i - 1)
      i -= 1
      j -= 1
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return retained
}

/**
 * Throw if any sibling key appears more than once. Notion-react requires
 * `blockKey` to be unique among siblings — otherwise the LCS match and the
 * by-key map below would silently collapse duplicates and produce an
 * incoherent diff.
 */
const assertUniqueKeys = (
  parentId: string,
  cacheChildren: readonly { key: string }[],
  candidateChildren: readonly { key: string }[],
): void => {
  const check = (children: readonly { key: string }[], source: 'cache' | 'candidate'): void => {
    const seen = new Set<string>()
    for (const c of children) {
      if (seen.has(c.key)) {
        throw new Error(
          `duplicate blockKey '${c.key}' among siblings under parent ${parentId} (${source}) — blockKey must be unique among siblings`,
        )
      }
      seen.add(c.key)
    }
  }
  check(cacheChildren, 'cache')
  check(candidateChildren, 'candidate')
}

/**
 * Block types whose descendants cannot be mutated via staged append/insert/
 * remove after creation — any structural change to their subtree forces a
 * full rebuild (remove + re-create with the new subtree inlined).
 *
 * `column_list`: Notion rejects `append children` against a column_list and
 * rejects appending a bare `column` anywhere (column requires ≥1 child
 * inlined at creation). So reordering columns, adding a column, removing a
 * column, or changing any column's own direct children all require
 * remove+recreate of the entire column_list.
 *
 * Kept separate from `ATOMIC_CONTAINERS` (the create-side inlining set):
 * `table` is atomic on create but rows CAN be appended post-hoc, so tables
 * don't need full-rebuild semantics on warm-sync.
 */
const FULL_REBUILD_ON_SUBTREE_CHANGE: ReadonlySet<BlockType> = new Set<BlockType>(['column_list'])

/** Deep structural (key+type+children-shape) equality between a cached node and a candidate. */
const subtreesStructurallyEqual = (cache: CacheNode, cand: CandidateNode): boolean => {
  if (cache.key !== cand.key || cache.type !== cand.type) return false
  if (cache.children.length !== cand.children.length) return false
  for (let i = 0; i < cache.children.length; i++) {
    if (!subtreesStructurallyEqual(cache.children[i]!, cand.children[i]!)) return false
  }
  return true
}

/**
 * Context threaded through `diffChildren` to support page-scope emission.
 * `pagesByKey` lets us detect cross-parent moves: an unretained candidate page
 * whose key matches a cache-only page entry anywhere in the prior tree is a
 * move, not a create+archive pair.
 *
 * `scopePageId` tags block ops emitted under a `<ChildPage>` subtree (forward-
 * compat; phase 3b does not recurse into sub-page children, so this is only
 * ever the sync root id today).
 */
interface DiffCtx {
  readonly pagesByKey: ReadonlyMap<string, CacheNode>
  readonly claimedMoves: Set<string>
  readonly scopePageId?: string
}

const diffChildren = (
  parentId: string, // blockId or tmpId of the parent
  cacheChildren: readonly CacheNode[],
  candidateChildren: CandidateNode[],
  ops: DiffOp[],
  ctx: DiffCtx,
): void => {
  assertUniqueKeys(parentId, cacheChildren, candidateChildren)
  // Identify which cache children survive (order-preserving LCS match).
  const retainedCache = retainedCacheIndices(cacheChildren, candidateChildren)
  const retainedKeys = new Set<string>()
  for (const idx of retainedCache) retainedKeys.add(cacheChildren[idx]!.key)

  const cacheByKey = new Map<string, CacheNode>()
  for (const c of cacheChildren) cacheByKey.set(c.key, c)

  // Demote retained candidates whose type demands full-rebuild on any
  // subtree shape change (e.g. column_list — Notion rejects per-column
  // mutation). Unretaining here flows through the normal insert/append +
  // remove pair, so the whole subtree is re-created with children inlined.
  for (const cand of candidateChildren) {
    if (!FULL_REBUILD_ON_SUBTREE_CHANGE.has(cand.type)) continue
    if (!retainedKeys.has(cand.key)) continue
    const prior = cacheByKey.get(cand.key)!
    if (!subtreesStructurallyEqual(prior, cand)) {
      retainedKeys.delete(cand.key)
    }
  }

  // Precompute, for each candidate index, whether any later candidate is
  // retained. A new candidate can safely become an `append` iff no retained
  // candidate sits after it — otherwise Notion's server-side tail-append
  // would place it in the wrong position.
  const hasRetainedAfter = Array.from<boolean>({ length: candidateChildren.length }).fill(false)
  {
    let seen = false
    for (let i = candidateChildren.length - 1; i >= 0; i--) {
      hasRetainedAfter[i] = seen
      if (retainedKeys.has(candidateChildren[i]!.key)) seen = true
    }
  }

  // Emit inserts/updates in candidate order. `prevRef` anchors inserts.
  // We defer brand-new subtrees and retained-child recursions until after
  // the main loop so that the top-level sibling ops form a contiguous run
  // (parent-grouped) that the sync driver can coalesce into batched API
  // calls — #101.
  type Deferred =
    | { readonly kind: 'new-subtree'; readonly parent: string; readonly children: CandidateNode[] }
    | {
        readonly kind: 'retained-recurse'
        readonly blockId: string
        readonly cache: readonly CacheNode[]
        readonly candidate: CandidateNode[]
      }
  const deferred: Deferred[] = []
  let prevRef = ''
  for (let i = 0; i < candidateChildren.length; i++) {
    const cand = candidateChildren[i]!
    if (cand.nodeKind === 'page') {
      // Page candidates never flow through the block insert/append path. They
      // emit {create,update,move}Page directly so the sync driver can route
      // to `pages.*` endpoints. Retained page → coalesced updatePage on any
      // metadata drift; unretained page with matching blockKey elsewhere in
      // the cache → movePage; otherwise → createPage with inline children.
      if (retainedKeys.has(cand.key)) {
        const prior = cacheByKey.get(cand.key)!
        cand.blockId = prior.blockId
        const titleDrift = cand.titleHash !== undefined && cand.titleHash !== prior.titleHash
        const iconDrift = cand.iconHash !== undefined && cand.iconHash !== prior.iconHash
        const coverDrift = cand.coverHash !== undefined && cand.coverHash !== prior.coverHash
        if (titleDrift || iconDrift || coverDrift) {
          ops.push({
            kind: 'updatePage',
            pageId: prior.blockId,
            ...(titleDrift ? { title: cand.title } : {}),
            ...(iconDrift ? { icon: cand.icon } : {}),
            ...(coverDrift ? { cover: cand.cover } : {}),
          })
        }
        // Phase 3b gap: we do NOT recurse into the retained page's children.
        // Block-tree reconciliation inside an existing `<ChildPage>` lands in
        // phase 3c along with the CACHE_SCHEMA_VERSION bump.
        prevRef = prior.blockId
        continue
      }
      // Unretained: either brand-new or a cross-parent move.
      const moveSource = ctx.pagesByKey.get(cand.key)
      if (moveSource !== undefined && !ctx.claimedMoves.has(moveSource.blockId)) {
        ctx.claimedMoves.add(moveSource.blockId)
        cand.blockId = moveSource.blockId
        ops.push({
          kind: 'movePage',
          pageId: moveSource.blockId,
          parent: { pageId: parentId },
        })
        // Any metadata drift comes through as a follow-up updatePage.
        const titleDrift = cand.titleHash !== undefined && cand.titleHash !== moveSource.titleHash
        const iconDrift = cand.iconHash !== undefined && cand.iconHash !== moveSource.iconHash
        const coverDrift = cand.coverHash !== undefined && cand.coverHash !== moveSource.coverHash
        if (titleDrift || iconDrift || coverDrift) {
          ops.push({
            kind: 'updatePage',
            pageId: moveSource.blockId,
            ...(titleDrift ? { title: cand.title } : {}),
            ...(iconDrift ? { icon: cand.icon } : {}),
            ...(coverDrift ? { cover: cand.cover } : {}),
          })
        }
        prevRef = moveSource.blockId
      } else {
        const tmpPageId = nextTmp()
        const { inline, inlineCandidates, tail } = inlinePackChildren(cand.children, tmpPageId)
        ops.push({
          kind: 'createPage',
          tmpPageId,
          parent: { pageId: parentId },
          ...(cand.title !== undefined ? { title: cand.title } : {}),
          ...(cand.icon !== undefined ? { icon: cand.icon } : {}),
          ...(cand.cover !== undefined ? { cover: cand.cover } : {}),
          inlineChildren: inline,
          inlineCandidates,
        })
        cand.blockId = tmpPageId
        for (const t of tail) ops.push(t)
        prevRef = tmpPageId
      }
      continue
    }

    if (retainedKeys.has(cand.key)) {
      // Matched and in-order — reuse blockId.
      const prior = cacheByKey.get(cand.key)!
      cand.blockId = prior.blockId
      if (prior.hash !== cand.hash) {
        ops.push({
          kind: 'update',
          blockId: prior.blockId,
          type: cand.type,
          props: cand.props,
          hash: cand.hash,
          key: cand.key,
          ...(ctx.scopePageId !== undefined ? { scopePageId: ctx.scopePageId } : {}),
        })
      }
      deferred.push({
        kind: 'retained-recurse',
        blockId: prior.blockId,
        cache: prior.children,
        candidate: cand.children,
      })
      prevRef = prior.blockId
    } else {
      // Either brand-new OR a reorder (key exists in cache but not retained).
      // Both cases: emit insert/append of a new block; the stale one is
      // removed below.
      const tmpId = nextTmp()
      if (!hasRetainedAfter[i]) {
        // No retained sibling follows — plain tail append is correct.
        ops.push({
          kind: 'append',
          parent: parentId,
          tmpId,
          type: cand.type,
          props: cand.props,
          candidate: cand,
          ...(ctx.scopePageId !== undefined ? { scopePageId: ctx.scopePageId } : {}),
        })
      } else {
        ops.push({
          kind: 'insert',
          parent: parentId,
          tmpId,
          afterId: prevRef,
          type: cand.type,
          props: cand.props,
          candidate: cand,
          ...(ctx.scopePageId !== undefined ? { scopePageId: ctx.scopePageId } : {}),
        })
      }
      cand.blockId = tmpId
      if (cand.children.length > 0) {
        deferred.push({ kind: 'new-subtree', parent: tmpId, children: cand.children })
      }
      prevRef = tmpId
    }
  }
  // Drain deferred subtrees after the current parent's sibling run so the
  // sync driver sees a single coalesce-able append-run per parent.
  for (const d of deferred) {
    if (d.kind === 'new-subtree') {
      emitAppendsForNew(d.parent, d.children, ops, ctx)
    } else {
      diffChildren(d.blockId, d.cache, d.candidate, ops, ctx)
    }
  }

  // Removes for cached children not retained. Page-kind entries that were not
  // claimed as a movePage source become archivePage; block-kind entries
  // become block remove.
  for (const c of cacheChildren) {
    if (retainedKeys.has(c.key)) continue
    if (c.nodeKind === 'page') {
      if (ctx.claimedMoves.has(c.blockId)) continue
      ops.push({ kind: 'archivePage', pageId: c.blockId })
    } else {
      ops.push({
        kind: 'remove',
        blockId: c.blockId,
        ...(ctx.scopePageId !== undefined ? { scopePageId: ctx.scopePageId } : {}),
      })
    }
  }
}

/**
 * For a brand-new candidate subtree, emit append ops in level-order (BFS):
 * all direct children first (so they form a single contiguous sibling run
 * that can be batched by the sync driver), then recurse into each child's
 * own subtree. Parent refs chain via tmpIds that are assigned *before*
 * recursion.
 *
 * This ordering is what lets the sync driver coalesce N sibling appends
 * under a common parent into ⌈N/100⌉ API calls (#101) even when the
 * siblings themselves have children.
 */
const emitAppendsForNew = (
  parentId: string,
  children: CandidateNode[],
  ops: DiffOp[],
  ctx: DiffCtx,
): void => {
  for (const cand of children) {
    if (cand.nodeKind === 'page') {
      // Brand-new page nested under a brand-new block subtree. Phase 3b does
      // not recurse into existing sub-page children, but a freshly-created
      // <ChildPage> may legitimately appear here (e.g. under a new toggle)
      // and should create via the page endpoint, not append as a block.
      const tmpPageId = nextTmp()
      const { inline, inlineCandidates, tail } = inlinePackChildren(cand.children, tmpPageId)
      ops.push({
        kind: 'createPage',
        tmpPageId,
        parent: { pageId: parentId },
        ...(cand.title !== undefined ? { title: cand.title } : {}),
        ...(cand.icon !== undefined ? { icon: cand.icon } : {}),
        ...(cand.cover !== undefined ? { cover: cand.cover } : {}),
        inlineChildren: inline,
        inlineCandidates,
      })
      cand.blockId = tmpPageId
      for (const t of tail) ops.push(t)
      continue
    }
    const tmpId = nextTmp()
    ops.push({
      kind: 'append',
      parent: parentId,
      tmpId,
      type: cand.type,
      props: cand.props,
      candidate: cand,
      ...(ctx.scopePageId !== undefined ? { scopePageId: ctx.scopePageId } : {}),
    })
    cand.blockId = tmpId
  }
  for (const cand of children) {
    if (cand.nodeKind === 'page') continue
    if (cand.children.length > 0) emitAppendsForNew(cand.blockId!, cand.children, ops, ctx)
  }
}

/**
 * Notion's `pages.create.children` caps subtree depth at 2 and total blocks
 * at 100 per request. Walk candidate children and produce (a) an inline body
 * the sync driver can pass as `children: ...` to `pages.create`, and (b) a
 * tail of block ops for whatever could not fit inline. Scope-ids on tail ops
 * reference the `tmpPageId` of the newly-created page; the sync driver
 * resolves tmp → server id on apply.
 *
 * Depth-2 rule (Notion `children` wire shape):
 *   depth 1 — direct children of the new page (max 100)
 *   depth 2 — grandchildren, shipped under the parent's own `children` array
 *   depth 3+ — rejected at the API. Tail them to follow-up appends.
 *
 * Page-kind descendants are never inlined — phase 3b does not nest page
 * creates in a single request. They get tailed as a follow-up createPage op
 * scoped to the parent's tmpPageId.
 */
interface PackResult {
  readonly inline: readonly Record<string, unknown>[]
  /** Candidate nodes paired 1:1 with `inline`, in the same order. */
  readonly inlineCandidates: readonly CandidateNode[]
  readonly tail: DiffOp[]
}

export const inlinePackChildren = (
  children: readonly CandidateNode[],
  scopeTmpPageId: string,
): PackResult => {
  const tail: DiffOp[] = []
  let total = 0
  const MAX_TOTAL = 100

  const buildBlock = (cand: CandidateNode, depth: number): Record<string, unknown> | undefined => {
    if (cand.nodeKind === 'page') {
      // Page inside a page-create inline body is not supported — tail it as
      // a separate createPage scoped to the containing page's tmp id. The
      // sync driver resolves scope after the outer create lands.
      const nestedTmp = nextTmp()
      const nestedPack = inlinePackChildren(cand.children, nestedTmp)
      tail.push({
        kind: 'createPage',
        tmpPageId: nestedTmp,
        parent: { pageId: scopeTmpPageId },
        ...(cand.title !== undefined ? { title: cand.title } : {}),
        ...(cand.icon !== undefined ? { icon: cand.icon } : {}),
        ...(cand.cover !== undefined ? { cover: cand.cover } : {}),
        inlineChildren: nestedPack.inline,
        inlineCandidates: nestedPack.inlineCandidates,
      })
      cand.blockId = nestedTmp
      for (const t of nestedPack.tail) tail.push(t)
      return undefined
    }
    if (total >= MAX_TOTAL) return undefined
    total += 1
    // Mint a tmpId so downstream passes can track id resolution. We do NOT
    // emit an append op for blocks shipped inline — the outer createPage op
    // carries the nested body, and `resolveInlineChildrenIds` on the sync
    // side walks the server response to fill in real ids.
    const tmpId = nextTmp()
    cand.blockId = tmpId
    const body: Record<string, unknown> = {
      object: 'block',
      type: cand.type,
      [cand.type]: { ...cand.props },
    }
    if (cand.children.length === 0) return body
    if (depth >= 2) {
      // Depth-3+ children cannot ride inline — tail them as regular block
      // appends scoped to this candidate's tmp id.
      for (const sub of cand.children) {
        tailBlock(sub, tmpId)
      }
      return body
    }
    const nestedBodies: Record<string, unknown>[] = []
    for (const sub of cand.children) {
      const nested = buildBlock(sub, depth + 1)
      if (nested !== undefined) nestedBodies.push(nested)
    }
    if (nestedBodies.length > 0) {
      ;(body[cand.type] as Record<string, unknown>).children = nestedBodies
    }
    return body
  }

  const tailBlock = (cand: CandidateNode, parentTmpId: string): void => {
    if (cand.nodeKind === 'page') {
      // TODO(phase-3c): nested page creates under a tailed block are not yet
      // supported; emit as a createPage scoped to the parent block id. The
      // sync driver resolves the scope after the parent append lands.
      const nestedTmp = nextTmp()
      const nestedPack = inlinePackChildren(cand.children, nestedTmp)
      tail.push({
        kind: 'createPage',
        tmpPageId: nestedTmp,
        parent: { pageId: parentTmpId },
        ...(cand.title !== undefined ? { title: cand.title } : {}),
        ...(cand.icon !== undefined ? { icon: cand.icon } : {}),
        ...(cand.cover !== undefined ? { cover: cand.cover } : {}),
        inlineChildren: nestedPack.inline,
        inlineCandidates: nestedPack.inlineCandidates,
      })
      cand.blockId = nestedTmp
      for (const t of nestedPack.tail) tail.push(t)
      return
    }
    const tmpId = nextTmp()
    cand.blockId = tmpId
    tail.push({
      kind: 'append',
      parent: parentTmpId,
      tmpId,
      type: cand.type,
      props: cand.props,
      candidate: cand,
      scopePageId: scopeTmpPageId,
    })
    for (const sub of cand.children) tailBlock(sub, tmpId)
  }

  const inline: Record<string, unknown>[] = []
  const inlineCandidates: CandidateNode[] = []
  for (const cand of children) {
    if (total >= MAX_TOTAL) {
      // Overflow at depth 1 — tail as block ops scoped to the new page.
      tailBlock(cand, scopeTmpPageId)
      continue
    }
    const body = buildBlock(cand, 1)
    if (body !== undefined) {
      inline.push(body)
      inlineCandidates.push(cand)
    }
  }
  return { inline, inlineCandidates, tail }
}

/**
 * Compute the minimum op plan to reconcile `cache` -> `candidate`. The
 * returned ops are ordered so appends/inserts precede removes within a
 * parent.
 */
/**
 * Index every page-kind entry in the prior cache tree by blockKey. Used by
 * `diffChildren` to detect cross-parent moves: an unretained candidate page
 * with a matching key becomes `movePage` instead of archive+create.
 */
const indexCachePages = (cache: CacheTree): Map<string, CacheNode> => {
  const out = new Map<string, CacheNode>()
  const walk = (nodes: readonly CacheNode[]): void => {
    for (const n of nodes) {
      if (n.nodeKind === 'page') out.set(n.key, n)
      walk(n.children)
    }
  }
  walk(cache.children)
  return out
}

export const diff = (cache: CacheTree, candidate: CandidateTree): DiffOp[] => {
  tmpCounter = 0
  const ops: DiffOp[] = []
  const ctx: DiffCtx = {
    pagesByKey: indexCachePages(cache),
    claimedMoves: new Set<string>(),
  }
  diffChildren(candidate.rootId, cache.children, candidate.children, ops, ctx)
  return ops
}

/**
 * Convert a materialized CandidateTree into a CacheTree snapshot. All
 * candidate `blockId`s must be resolved (no tmpIds) by the time this is
 * called.
 */
const candidateNodeToCacheNode = (cand: CandidateNode): CacheNode => {
  if (cand.blockId === undefined || cand.blockId.startsWith('tmp-')) {
    // Defensive: should not happen after a successful apply.
    throw new Error(`candidateToCache: unresolved blockId for key=${cand.key}`)
  }
  if (cand.nodeKind === 'page') {
    return {
      key: cand.key,
      blockId: cand.blockId,
      type: cand.type,
      hash: cand.hash,
      // Phase 3b gap: children of an existing <ChildPage> are not reconciled
      // against Notion, so we do not persist candidate children under a page
      // node. Phase 3c bumps CACHE_SCHEMA_VERSION and starts recording them.
      children: [],
      nodeKind: 'page',
      ...(cand.titleHash !== undefined ? { titleHash: cand.titleHash } : {}),
      ...(cand.iconHash !== undefined ? { iconHash: cand.iconHash } : {}),
      ...(cand.coverHash !== undefined ? { coverHash: cand.coverHash } : {}),
    }
  }
  return {
    key: cand.key,
    blockId: cand.blockId,
    type: cand.type,
    hash: cand.hash,
    children: cand.children.map(candidateNodeToCacheNode),
    nodeKind: 'block',
  }
}

export const candidateToCache = (candidate: CandidateTree, schemaVersion: number): CacheTree => ({
  schemaVersion,
  rootId: candidate.rootId,
  children: candidate.children.map(candidateNodeToCacheNode),
})

export const tallyDiff = (
  ops: readonly DiffOp[],
): { appends: number; updates: number; inserts: number; removes: number } => {
  let appends = 0
  let updates = 0
  let inserts = 0
  let removes = 0
  for (const op of ops) {
    if (op.kind === 'append') appends += 1
    else if (op.kind === 'update') updates += 1
    else if (op.kind === 'insert') inserts += 1
    else if (op.kind === 'remove') removes += 1
  }
  return { appends, updates, inserts, removes }
}

/**
 * Page-scope op tally (issue #618 phase 3b). Mirrors {@link tallyDiff} but for
 * `PageOp`s only. Kept separate so consumers that only care about block ops
 * don't see their `.toEqual({appends,...})` assertions drift.
 */
export const tallyPageOps = (
  ops: readonly DiffOp[],
): { creates: number; updates: number; archives: number; moves: number } => {
  let creates = 0
  let updates = 0
  let archives = 0
  let moves = 0
  for (const op of ops) {
    if (op.kind === 'createPage') creates += 1
    else if (op.kind === 'updatePage') updates += 1
    else if (op.kind === 'archivePage') archives += 1
    else if (op.kind === 'movePage') moves += 1
  }
  return { creates, updates, archives, moves }
}
