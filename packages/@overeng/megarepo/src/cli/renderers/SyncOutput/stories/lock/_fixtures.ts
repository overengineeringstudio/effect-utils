/**
 * Fixtures for `mr lock` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import { COMMITS, MEMBERS } from '../../../_story-constants.ts'

// =============================================================================
// Lock Results
// =============================================================================

/** All members recorded into megarepo.lock successfully */
export const lockAllRecorded: MemberSyncResult[] = [
  {
    name: MEMBERS.coreLib,
    status: 'recorded',
    commit: COMMITS.coreLib.current,
    previousCommit: COMMITS.coreLib.previous,
  },
  {
    name: MEMBERS.devTools,
    status: 'recorded',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
  },
  { name: MEMBERS.appPlatform, status: 'recorded', commit: COMMITS.appPlatform.current },
  { name: MEMBERS.dotfiles, status: 'already_synced' },
]

/** Lock with some members skipped (dirty worktree, pinned) */
export const lockWithSkipped: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'recorded', commit: COMMITS.coreLib.current },
  { name: MEMBERS.devTools, status: 'skipped', message: 'dirty worktree' },
  { name: MEMBERS.appPlatform, status: 'recorded', commit: COMMITS.appPlatform.current },
  { name: MEMBERS.dotfiles, status: 'skipped', message: 'pinned' },
]

/** Lock recording with commit changes (some changed, some unchanged) */
export const lockWithUpdates: MemberSyncResult[] = [
  {
    name: MEMBERS.coreLib,
    status: 'recorded',
    commit: COMMITS.coreLib.current,
    previousCommit: COMMITS.coreLib.previous,
  },
  {
    name: MEMBERS.devTools,
    status: 'recorded',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
  },
  { name: MEMBERS.appPlatform, status: 'already_synced' },
]

/** Lock with pinned members — useful for testing force flag toggling */
export const lockWithPinned: MemberSyncResult[] = [
  {
    name: MEMBERS.coreLib,
    status: 'recorded',
    commit: COMMITS.coreLib.current,
    previousCommit: COMMITS.coreLib.previous,
  },
  {
    name: MEMBERS.devTools,
    status: 'recorded',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
  },
  { name: MEMBERS.appPlatform, status: 'already_synced' },
  {
    name: MEMBERS.dotfiles,
    status: 'recorded',
    commit: COMMITS.dotfiles.current,
    previousCommit: COMMITS.dotfiles.previous,
  },
]
