import type { ReactNode } from 'react'

import type { BlockType } from '@overeng/notion-effect-schema'

import type { CacheNode, CacheTree } from '../cache/types.ts'
import {
  blockChildren,
  createNotionRoot,
  projectProps,
  walkInstances,
  type Instance,
} from './host-config.ts'
import { OpBuffer } from './op-buffer.ts'

/**
 * Rendered-but-not-yet-synced block. `blockId` starts unset; the sync driver
 * fills it either from the cache (for matched nodes) or from Notion API
 * responses (for new inserts/appends).
 */
export interface CandidateNode {
  readonly key: string
  readonly type: BlockType
  readonly props: Record<string, unknown>
  readonly hash: string
  blockId: string | undefined
  readonly children: CandidateNode[]
}

export interface CandidateTree {
  readonly rootId: string
  readonly children: CandidateNode[]
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

const instanceToCandidate = (inst: Instance, index: number): CandidateNode => {
  const props = projectProps(inst)
  return {
    key: instanceKey(inst, index),
    type: inst.type as BlockType,
    props,
    hash: hashProps(props),
    blockId: undefined,
    children: blockChildren(inst).map(instanceToCandidate),
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
  return {
    rootId,
    children: walkInstances(root.container).map(instanceToCandidate),
  }
}

/**
 * Normalized op-plan. `tmpId`s are placeholder identifiers the diff uses to
 * wire up `after`/parent relationships across inserts that chain; they are
 * resolved to real Notion block ids when the plan is applied.
 */
export type DiffOp =
  | {
      readonly kind: 'append'
      readonly parent: string // parent blockId OR tmpId
      readonly tmpId: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
      readonly candidate: CandidateNode
    }
  | {
      readonly kind: 'insert'
      readonly parent: string
      readonly tmpId: string
      readonly afterId: string // preceding sibling blockId or tmpId, or '' for head
      readonly type: BlockType
      readonly props: Record<string, unknown>
      readonly candidate: CandidateNode
    }
  | {
      readonly kind: 'update'
      readonly blockId: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
    }
  | { readonly kind: 'remove'; readonly blockId: string }

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
    cacheChildren[ci]!.type === candidateChildren[cj]!.type
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

const diffChildren = (
  parentId: string, // blockId or tmpId of the parent
  cacheChildren: readonly CacheNode[],
  candidateChildren: CandidateNode[],
  ops: DiffOp[],
): void => {
  assertUniqueKeys(parentId, cacheChildren, candidateChildren)
  // Identify which cache children survive (order-preserving LCS match).
  const retainedCache = retainedCacheIndices(cacheChildren, candidateChildren)
  const retainedKeys = new Set<string>()
  for (const idx of retainedCache) retainedKeys.add(cacheChildren[idx]!.key)

  const cacheByKey = new Map<string, CacheNode>()
  for (const c of cacheChildren) cacheByKey.set(c.key, c)

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
      emitAppendsForNew(d.parent, d.children, ops)
    } else {
      diffChildren(d.blockId, d.cache, d.candidate, ops)
    }
  }

  // Removes for cached children not retained (either deleted outright or
  // reordered — Notion has no move API; reorder = remove + re-insert).
  for (const c of cacheChildren) {
    if (!retainedKeys.has(c.key)) {
      ops.push({ kind: 'remove', blockId: c.blockId })
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
const emitAppendsForNew = (parentId: string, children: CandidateNode[], ops: DiffOp[]): void => {
  for (const cand of children) {
    const tmpId = nextTmp()
    ops.push({
      kind: 'append',
      parent: parentId,
      tmpId,
      type: cand.type,
      props: cand.props,
      candidate: cand,
    })
    cand.blockId = tmpId
  }
  for (const cand of children) {
    if (cand.children.length > 0) emitAppendsForNew(cand.blockId!, cand.children, ops)
  }
}

/**
 * Compute the minimum op plan to reconcile `cache` -> `candidate`. The
 * returned ops are ordered so appends/inserts precede removes within a
 * parent.
 */
export const diff = (cache: CacheTree, candidate: CandidateTree): DiffOp[] => {
  tmpCounter = 0
  const ops: DiffOp[] = []
  diffChildren(candidate.rootId, cache.children, candidate.children, ops)
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
  return {
    key: cand.key,
    blockId: cand.blockId,
    type: cand.type,
    hash: cand.hash,
    children: cand.children.map(candidateNodeToCacheNode),
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
    else removes += 1
  }
  return { appends, updates, inserts, removes }
}
