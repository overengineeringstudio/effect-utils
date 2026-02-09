/**
 * Sync Schema
 *
 * Effect Schema definitions for sync operations.
 * Used for JSON serialization in CLI output and Storybook.
 */

import { Schema } from 'effect'

import { RefMismatch } from '../issues.ts'

// =============================================================================
// Member Sync Result
// =============================================================================

/** Member sync status */
export const MemberSyncStatus = Schema.Literal(
  'cloned',
  'synced',
  'already_synced',
  'skipped',
  'error',
  'updated',
  'locked',
  'removed',
)
/** Inferred type for the possible outcomes of syncing a single member. */
export type MemberSyncStatus = Schema.Schema.Type<typeof MemberSyncStatus>

/** Sync result for a single member */
export const MemberSyncResult = Schema.Struct({
  name: Schema.String,
  status: MemberSyncStatus,
  message: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  previousCommit: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  lockUpdated: Schema.optional(Schema.Boolean),
  /**
   * Present when worktree git HEAD differs from store path ref (Issue #88).
   * This happens when a user runs `git checkout <branch>` directly in the worktree.
   */
  refMismatch: Schema.optional(RefMismatch),
})
/** Inferred type for a member's sync result including status, commit info, and optional message. */
export type MemberSyncResult = Schema.Schema.Type<typeof MemberSyncResult>

// =============================================================================
// Sync Options (flags)
// =============================================================================

/** Schema for sync command flags (dry-run, frozen, pull, all, force, etc.). */
export const SyncOptions = Schema.Struct({
  dryRun: Schema.Boolean,
  frozen: Schema.Boolean,
  pull: Schema.Boolean,
  all: Schema.Boolean,
  force: Schema.optional(Schema.Boolean),
  verbose: Schema.optional(Schema.Boolean),
  /** Members skipped via --only or --skip */
  skippedMembers: Schema.optional(Schema.Array(Schema.String)),
})
/** Inferred type for sync command options. */
export type SyncOptions = Schema.Schema.Type<typeof SyncOptions>

/** Default sync options */
export const defaultSyncOptions: SyncOptions = {
  dryRun: false,
  frozen: false,
  pull: false,
  all: false,
}

// =============================================================================
// Sync Summary (computed from results)
// =============================================================================

/** Schema for aggregated sync result counts by status category. */
export const SyncSummary = Schema.Struct({
  cloned: Schema.Number,
  synced: Schema.Number,
  updated: Schema.Number,
  locked: Schema.Number,
  alreadySynced: Schema.Number,
  skipped: Schema.Number,
  errors: Schema.Number,
  removed: Schema.Number,
  total: Schema.Number,
})
/** Inferred type for aggregated sync summary counts. */
export type SyncSummary = Schema.Schema.Type<typeof SyncSummary>

// =============================================================================
// Nested Sync Tree (for --all)
// =============================================================================

/** Recursive schema for nested megarepo sync results. */
export type MegarepoSyncTree = {
  readonly root: string
  readonly results: readonly MemberSyncResult[]
  readonly nestedMegarepos: readonly string[]
  readonly nestedResults: readonly MegarepoSyncTree[]
}

/** Recursive schema for nested megarepo sync results. */
export const MegarepoSyncTree: Schema.Schema<MegarepoSyncTree> = Schema.suspend(() =>
  Schema.Struct({
    root: Schema.String,
    results: Schema.Array(MemberSyncResult),
    nestedMegarepos: Schema.Array(Schema.String),
    nestedResults: Schema.Array(MegarepoSyncTree),
  }),
)

/** Flattened error item (includes nested megarepo root). */
export const SyncErrorItem = Schema.Struct({
  megarepoRoot: Schema.String,
  memberName: Schema.String,
  message: Schema.NullOr(Schema.String),
})

/** Inferred type for a flattened sync error item. */
export type SyncErrorItem = Schema.Schema.Type<typeof SyncErrorItem>

/** Compute summary from results */
export const computeSyncSummary = (results: readonly MemberSyncResult[]): SyncSummary => {
  let cloned = 0
  let synced = 0
  let updated = 0
  let locked = 0
  let alreadySynced = 0
  let skipped = 0
  let errors = 0
  let removed = 0

  for (const r of results) {
    switch (r.status) {
      case 'cloned':
        cloned++
        break
      case 'synced':
        synced++
        break
      case 'updated':
        updated++
        break
      case 'locked':
        locked++
        break
      case 'already_synced':
        alreadySynced++
        break
      case 'skipped':
        skipped++
        break
      case 'error':
        errors++
        break
      case 'removed':
        removed++
        break
    }
  }

  return {
    cloned,
    synced,
    updated,
    locked,
    alreadySynced,
    skipped,
    errors,
    removed,
    total: results.length,
  }
}
