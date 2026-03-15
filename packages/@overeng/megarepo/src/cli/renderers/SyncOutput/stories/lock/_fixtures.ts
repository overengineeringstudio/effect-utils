/**
 * Fixtures for `mr lock` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'

// =============================================================================
// Lock Results
// =============================================================================

/** All members recorded into megarepo.lock successfully */
export const lockAllRecorded: MemberSyncResult[] = [
  { name: 'effect', status: 'recorded', commit: 'a1b2c3d4e5', previousCommit: '9f8e7d6c5b' },
  { name: 'effect-utils', status: 'recorded', commit: 'f0e1d2c3b4', previousCommit: 'a5b6c7d8e9' },
  { name: 'livestore', status: 'recorded', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Lock with some members skipped (dirty worktree, pinned) */
export const lockWithSkipped: MemberSyncResult[] = [
  { name: 'effect', status: 'recorded', commit: 'a1b2c3d4e5' },
  { name: 'effect-utils', status: 'skipped', message: 'dirty worktree' },
  { name: 'livestore', status: 'recorded', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'skipped', message: 'pinned' },
]

/** Lock recording with commit changes (some changed, some unchanged) */
export const lockWithUpdates: MemberSyncResult[] = [
  {
    name: 'effect',
    status: 'recorded',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
  },
  {
    name: 'effect-utils',
    status: 'recorded',
    commit: 'def5678abc',
    previousCommit: 'fedcba987',
  },
  { name: 'livestore', status: 'already_synced' },
]
