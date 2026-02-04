/**
 * Sync Types
 *
 * Type definitions for sync operations.
 */

import type { AbsoluteDirPath } from '@overeng/effect-path'

import type { RefMismatch } from '../issues.ts'
import type { NixLockSyncResult } from '../nix-lock/mod.ts'

/** Member sync result status */
export type MemberSyncStatus =
  | 'cloned'
  | 'synced'
  | 'already_synced'
  | 'skipped'
  | 'error'
  | 'updated'
  | 'locked'
  | 'removed'

/** Member sync result */
export interface MemberSyncResult {
  readonly name: string
  readonly status: MemberSyncStatus
  readonly message?: string | undefined
  /** Resolved commit for lock file (remote sources only) */
  readonly commit?: string | undefined
  /** Previous commit (for showing changes) */
  readonly previousCommit?: string | undefined
  /** Resolved ref for lock file */
  readonly ref?: string | undefined
  /** Whether the lock was updated for this member */
  readonly lockUpdated?: boolean | undefined
  /**
   * Present when worktree git HEAD differs from store path ref (Issue #88).
   * This happens when a user runs `git checkout <branch>` directly in the worktree.
   */
  readonly refMismatch?: RefMismatch | undefined
}

/** Result of syncing a megarepo (including nested) */
export interface MegarepoSyncResult {
  readonly root: AbsoluteDirPath
  readonly results: ReadonlyArray<MemberSyncResult>
  readonly nestedMegarepos: ReadonlyArray<string>
  readonly nestedResults: ReadonlyArray<MegarepoSyncResult>
  /** Results from syncing Nix lock files (flake.lock, devenv.lock) */
  readonly lockSyncResults?: NixLockSyncResult | undefined
}

/** Options for sync operations */
export interface SyncOptions {
  readonly json: boolean
  readonly dryRun: boolean
  readonly pull: boolean
  readonly frozen: boolean
  readonly force: boolean
  readonly all: boolean
}

/** Flatten nested sync results for JSON output */
export const flattenSyncResults = (result: MegarepoSyncResult): object => ({
  root: result.root,
  results: result.results,
  nestedMegarepos: result.nestedMegarepos,
  nestedResults: result.nestedResults.map(flattenSyncResults),
})

/** Count sync results including nested megarepos */
export const countSyncResults = (
  r: MegarepoSyncResult,
): {
  synced: number
  updated: number
  locked: number
  already: number
  errors: number
  removed: number
} => {
  const synced = r.results.filter((m) => m.status === 'cloned' || m.status === 'synced').length
  const updated = r.results.filter((m) => m.status === 'updated').length
  const locked = r.results.filter((m) => m.status === 'locked').length
  const already = r.results.filter((m) => m.status === 'already_synced').length
  const errors = r.results.filter((m) => m.status === 'error').length
  const removed = r.results.filter((m) => m.status === 'removed').length
  const nested = r.nestedResults.reduce(
    (acc, nr) => {
      const nc = countSyncResults(nr)
      return {
        synced: acc.synced + nc.synced,
        updated: acc.updated + nc.updated,
        locked: acc.locked + nc.locked,
        already: acc.already + nc.already,
        errors: acc.errors + nc.errors,
        removed: acc.removed + nc.removed,
      }
    },
    { synced: 0, updated: 0, locked: 0, already: 0, errors: 0, removed: 0 },
  )
  return {
    synced: synced + nested.synced,
    updated: updated + nested.updated,
    locked: locked + nested.locked,
    already: already + nested.already,
    errors: errors + nested.errors,
    removed: removed + nested.removed,
  }
}
