import { isPathProtected, type StoreLiveSet } from './store-liveness.ts'

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
