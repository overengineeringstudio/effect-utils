import type { StoreGcConfig } from './store-gc-config.ts'
import { isPathProtected, type StoreLiveSet } from './store-liveness.ts'
import type { PrStateInfo } from './store-pr-state.ts'

/** Store path ref segment for a materialized worktree. */
export type StoreWorktreeRefType = 'heads' | 'tags' | 'commits'

/** Minimal worktree shape needed to classify GC protection. */
export interface StoreWorktreePolicyTarget {
  readonly refType: StoreWorktreeRefType
  readonly path: string
}

/** GC policy mode. Default keeps named refs and workspace roots; all keeps neither. */
export type StoreGcMode = 'default' | 'all'

/** Why a worktree is protected from default GC. */
export type StoreWorktreeProtectionReason =
  | 'named_branch_ref'
  | 'named_tag_ref'
  | 'workspace_root_set'

/** Classification result shared by store status and store GC. */
export interface StoreWorktreePolicyDecision {
  readonly isProtected: boolean
  readonly reason: StoreWorktreeProtectionReason | undefined
  readonly message: string | undefined
}

/** Returns true for named branch/tag worktrees that default GC keeps. */
export const isNamedRefWorktree = (worktree: StoreWorktreePolicyTarget): boolean =>
  worktree.refType === 'heads' || worktree.refType === 'tags'

const namedRefReason = (
  worktree: StoreWorktreePolicyTarget,
): StoreWorktreeProtectionReason | undefined => {
  switch (worktree.refType) {
    case 'heads':
      return 'named_branch_ref'
    case 'tags':
      return 'named_tag_ref'
    case 'commits':
      return undefined
  }
}

/** Formats a stable human-readable protection reason for CLI output. */
export const formatStoreWorktreeProtectionMessage = (
  reason: StoreWorktreeProtectionReason,
): string => {
  switch (reason) {
    case 'named_branch_ref':
      return 'named branch ref'
    case 'named_tag_ref':
      return 'named tag ref'
    case 'workspace_root_set':
      return 'referenced by workspace root set'
  }
}

/** Classifies whether a worktree is protected by the selected GC policy. */
export const classifyStoreWorktreePolicy = ({
  liveSet,
  mode,
  worktree,
}: {
  readonly liveSet: StoreLiveSet
  readonly mode: StoreGcMode
  readonly worktree: StoreWorktreePolicyTarget
}): StoreWorktreePolicyDecision => {
  if (mode === 'all') {
    return { isProtected: false, message: undefined, reason: undefined }
  }

  const namedReason = namedRefReason(worktree)
  if (namedReason !== undefined) {
    return {
      isProtected: true,
      message: formatStoreWorktreeProtectionMessage(namedReason),
      reason: namedReason,
    }
  }

  if (isPathProtected({ liveSet, path: worktree.path }) === true) {
    return {
      isProtected: true,
      message: formatStoreWorktreeProtectionMessage('workspace_root_set'),
      reason: 'workspace_root_set',
    }
  }

  return { isProtected: false, message: undefined, reason: undefined }
}

// =============================================================================
// Cold named-worktree classification (decisions 0001–0010; pure)
// =============================================================================

/**
 * Lossless-floor inputs for one worktree (decision 0004, invariant 2).
 *
 * `unpushed` is the count of commits reachable from the worktree HEAD but not on
 * any remote (`git rev-list <head> --not --remotes`); `>0` means unrecoverable
 * local history. `hasStash` is a non-empty stash for the worktree (stash refs
 * live in the bare and do NOT travel with a dir move). `dirty` is uncommitted or
 * untracked content — recoverable because it moves intact with the dir, so it
 * does NOT itself force keep (only gates the archive reason).
 */
export interface StoreWorktreeLossless {
  readonly unpushed: number
  readonly dirty: boolean
  readonly hasStash: boolean
}

/** Why a cold named worktree is kept (no destructive action). */
export type ColdWorktreeKeepReason =
  | 'live'
  | 'not-stale'
  | 'unrecoverable-local-work'
  | 'absence-grace'
  | 'post-merge-grace'
  | 'defensive'

/** Why a cold named worktree is eligible to archive. */
export type ColdWorktreeArchiveReason = 'merged' | 'closed'

/**
 * Cold-classification outcome for ONE named worktree (decision 0001).
 *
 * Tagged union: `keep` is non-destructive; `archive` makes the worktree eligible
 * for the under-lock archive step (U6). Reap is a separate retention decision
 * (U6), not produced here.
 */
export type ColdWorktreeDecision =
  | { readonly _tag: 'keep'; readonly reason: ColdWorktreeKeepReason }
  | { readonly _tag: 'archive'; readonly reason: ColdWorktreeArchiveReason }

const keep = (reason: ColdWorktreeKeepReason): ColdWorktreeDecision => ({ _tag: 'keep', reason })

const archive = (reason: ColdWorktreeArchiveReason): ColdWorktreeDecision => ({
  _tag: 'archive',
  reason,
})

/**
 * Classify a cold named worktree as keep-vs-archive (pure; decisions 0001–0010).
 *
 * Gates are evaluated in this exact order and each short-circuits (a later gate
 * only sees inputs all earlier gates allowed through). This ordering encodes the
 * safety lattice: liveness veto first (invariant 1), then staleness evidence,
 * then the lossless floor (invariant 2), then the two grace timers, and only
 * then a positive archive decision.
 *
 * 1. In the reconciled live set ⇒ keep `live` (invariant 1; never archived).
 * 2. PR state `open` or `none` ⇒ keep `not-stale` (no staleness signal; 0005).
 * 3. `unpushed > 0` OR `hasStash` ⇒ keep `unrecoverable-local-work` (lossless
 *    floor, invariant 2). `dirty` alone does NOT keep — it moves with the dir.
 * 4. Never observed cold, or absence-grace not yet elapsed ⇒ keep `absence-grace`
 *    (decision 0008). `coldSinceMs === undefined` is conservative re-arm.
 * 5. `merged` requires `mergedAt`; missing ⇒ keep `defensive`. Within the
 *    post-merge grace window ⇒ keep `post-merge-grace` (decisions 0005/0008).
 * 6. Otherwise archive: `merged` or `closed`. CLOSED has NO post-close grace
 *    (decision 0009) — the lossless floor already protects unreachable closed
 *    branches.
 *
 * `now` is an explicit epoch-ms decision clock (never the ambient wall clock).
 */
export const classifyColdWorktree = ({
  worktree,
  liveSet,
  prState,
  lossless,
  coldSinceMs,
  config,
  now,
}: {
  readonly worktree: StoreWorktreePolicyTarget
  readonly liveSet: StoreLiveSet
  readonly prState: PrStateInfo
  readonly lossless: StoreWorktreeLossless
  readonly coldSinceMs: number | undefined
  readonly config: StoreGcConfig
  readonly now: number
}): ColdWorktreeDecision => {
  // Gate 1: liveness veto (invariant 1) — a worktree in ANY reconciled live set
  // is never archived, regardless of every other signal.
  if (isPathProtected({ liveSet, path: worktree.path }) === true) {
    return keep('live')
  }

  // Gate 2: staleness evidence (decision 0005). Only merged/closed are signals;
  // open work and "no PR at all" are kept.
  if (prState.state === 'open' || prState.state === 'none') {
    return keep('not-stale')
  }

  // Gate 3: lossless floor (invariant 2). Unpushed history or a stash cannot
  // survive a dir move, so either forces keep. Dirt is recoverable (moves with
  // the dir) and intentionally does not gate here.
  if (lossless.unpushed > 0 || lossless.hasStash === true) {
    return keep('unrecoverable-local-work')
  }

  // Gate 4: absence grace (decision 0008). Unobserved-cold re-arms the timer.
  if (coldSinceMs === undefined || now - coldSinceMs < config.absenceGraceMs) {
    return keep('absence-grace')
  }

  // Gate 5: merged-only post-merge grace (decisions 0005/0008). Missing mergedAt
  // is treated defensively (cannot prove the window elapsed).
  if (prState.state === 'merged') {
    if (prState.mergedAt === undefined) {
      return keep('defensive')
    }
    if (now - prState.mergedAt < config.postMergeGraceMs) {
      return keep('post-merge-grace')
    }
  }

  // Gate 6: archive. CLOSED has no post-close grace (decision 0009).
  return prState.state === 'merged' ? archive('merged') : archive('closed')
}
