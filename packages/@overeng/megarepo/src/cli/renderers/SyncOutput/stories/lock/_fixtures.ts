/**
 * Shared fixtures for Lock command stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import type { SyncState as SyncStateType } from '../../mod.ts'
import type { MemberLockSyncResult, SyncAction } from '../../schema.ts'
import { createBaseState } from '../_fixtures.ts'

// =============================================================================
// Lock Sync Fixtures
// =============================================================================

/** All members recorded into megarepo.lock successfully */
export const lockSyncAllRecorded: MemberSyncResult[] = [
  { name: 'effect', status: 'locked', commit: 'a1b2c3d4e5', previousCommit: '9f8e7d6c5b' },
  { name: 'effect-utils', status: 'locked', commit: 'f0e1d2c3b4', previousCommit: 'a5b6c7d8e9' },
  { name: 'livestore', status: 'locked', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Lock sync with some members skipped (dirty worktree, pinned) */
export const lockSyncWithSkipped: MemberSyncResult[] = [
  { name: 'effect', status: 'locked', commit: 'a1b2c3d4e5' },
  { name: 'effect-utils', status: 'skipped', message: 'dirty worktree' },
  { name: 'livestore', status: 'locked', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'skipped', message: 'pinned' },
]

// =============================================================================
// Lock Update Fixtures
// =============================================================================

/** Lock update fetches new refs and updates workspace */
export const lockUpdateResults: MemberSyncResult[] = [
  {
    name: 'effect',
    status: 'updated',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
    ref: 'main',
  },
  {
    name: 'effect-utils',
    status: 'updated',
    commit: 'def5678abc',
    previousCommit: 'fedcba987',
    ref: 'main',
  },
  { name: 'livestore', status: 'already_synced' },
  { name: 'dotfiles', status: 'synced', ref: 'main' },
]

/** Lock update with --create-branches (new branches created) */
export const lockUpdateWithNewBranches: MemberSyncResult[] = [
  { name: 'effect', status: 'cloned', ref: 'feature/new-api' },
  {
    name: 'effect-utils',
    status: 'updated',
    commit: 'def5678abc',
    previousCommit: 'fedcba987',
    ref: 'main',
  },
  { name: 'livestore', status: 'synced', ref: 'feature/new-api' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Lock update with errors (network, auth) */
export const lockUpdateWithErrors: MemberSyncResult[] = [
  {
    name: 'effect',
    status: 'updated',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
    ref: 'main',
  },
  { name: 'effect-utils', status: 'error', message: 'network timeout during fetch' },
  { name: 'livestore', status: 'already_synced' },
  { name: 'private-repo', status: 'error', message: 'authentication failed' },
]

/** Lock update with lock input sync results */
export const lockUpdateLockSyncResults: MemberLockSyncResult[] = [
  {
    memberName: 'effect',
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          { inputName: 'livestore', memberName: 'livestore', oldRev: '1234567', newRev: '7654321' },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          { inputName: 'effect', memberName: 'effect', oldRev: 'fff0000', newRev: 'aaa1111' },
        ],
      },
    ],
  },
]

// =============================================================================
// Lock Apply Fixtures
// =============================================================================

/** Lock apply in CI - all members applied from lockfile */
export const lockApplyResults: MemberSyncResult[] = [
  { name: 'effect', status: 'locked', commit: 'a1b2c3d4e5' },
  { name: 'effect-utils', status: 'locked', commit: 'f0e1d2c3b4' },
  { name: 'livestore', status: 'locked', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'locked', commit: '9f8e7d6c5b' },
  { name: 'schickling.dev', status: 'locked', commit: 'deadbeef42' },
]

/** Lock apply with some already at correct commit */
export const lockApplyPartial: MemberSyncResult[] = [
  { name: 'effect', status: 'locked', commit: 'a1b2c3d4e5' },
  { name: 'effect-utils', status: 'already_synced' },
  { name: 'livestore', status: 'locked', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Lock apply failure (lockfile out of date, network issues) */
export const lockApplyWithErrors: MemberSyncResult[] = [
  { name: 'effect', status: 'locked', commit: 'a1b2c3d4e5' },
  {
    name: 'effect-utils',
    status: 'error',
    message: 'commit f0e1d2c not found — run mr lock update',
  },
  { name: 'livestore', status: 'locked', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'error', message: 'repository not found' },
]

// =============================================================================
// State Factories
// =============================================================================

export const createLockState = (
  mode: 'lock_sync' | 'lock_update' | 'lock_apply',
  overrides: Partial<SyncStateType> & { results: MemberSyncResult[] },
): SyncStateType =>
  createBaseState({
    options: { mode, dryRun: false, all: false, verbose: false, ...overrides.options },
    members: overrides.results.map((r) => r.name),
    ...overrides,
  })

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

/**
 * Creates a timeline that animates through a lock operation, progressively
 * completing each member. Ends with the provided final state.
 */
export const createLockTimeline = (
  mode: 'lock_sync' | 'lock_update' | 'lock_apply',
  finalState: Partial<SyncStateType> & { results: MemberSyncResult[] },
): Array<{ at: number; action: typeof SyncAction.Type }> => {
  const results = finalState.results
  const members = finalState.members ?? results.map((r) => r.name)
  const workspace = finalState.workspace ?? { name: 'my-workspace', root: '/Users/dev/workspace' }
  const options = finalState.options ?? { mode, dryRun: false, all: false, verbose: false }
  const lockSyncResults = finalState.lockSyncResults ?? []
  const syncErrors = finalState.syncErrors ?? []
  const syncErrorCount = finalState.syncErrorCount ?? 0

  const timeline: Array<{ at: number; action: typeof SyncAction.Type }> = []
  const stepDuration = 800

  // Step 0: start syncing — all members pending
  timeline.push({
    at: 0,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        workspace,
        options,
        _tag: 'Syncing',
        members,
        activeMember: members[0] ?? null,
        results: [],
        startedAt: Date.now(),
      }),
    },
  })

  // Progressive results — accumulate errors as they appear
  let runningErrorCount = 0
  const runningErrors: Array<(typeof syncErrors)[number]> = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    const currentResults = results.slice(0, i + 1)
    const nextMember = i + 1 < members.length ? (members[i + 1] ?? null) : null
    const isFinal = i === results.length - 1

    if (result.status === 'error') {
      runningErrorCount++
      const matchingError = syncErrors.find((e) => e.memberName === result.name)
      if (matchingError !== undefined) runningErrors.push(matchingError)
    }

    const hasErrors = runningErrorCount > 0

    timeline.push({
      at: (i + 1) * stepDuration,
      action: {
        _tag: 'SetState',
        state: createBaseState({
          workspace,
          options,
          _tag: isFinal ? (hasErrors ? 'Error' : 'Success') : 'Syncing',
          members,
          activeMember: nextMember,
          results: currentResults,
          lockSyncResults: isFinal ? lockSyncResults : [],
          syncErrors: runningErrors.slice(),
          syncErrorCount: runningErrorCount,
        }),
      },
    })
  }

  return timeline
}
