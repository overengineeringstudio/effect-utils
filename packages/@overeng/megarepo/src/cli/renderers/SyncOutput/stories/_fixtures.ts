/**
 * Shared fixtures for SyncOutput stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../lib/sync/schema.ts'
import type { SyncState as SyncStateType } from '../mod.ts'
import type { MemberLockSyncResult, SyncAction } from '../schema.ts'

// =============================================================================
// Example Data
// =============================================================================

export const exampleSyncResults: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'synced', ref: 'main' },
  { name: 'livestore', status: 'cloned', ref: 'main' },
  {
    name: 'dotfiles',
    status: 'updated',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
  },
  { name: 'private-repo', status: 'skipped', message: 'dirty worktree' },
]

export const exampleSyncResultsWithErrors: MemberSyncResult[] = [
  { name: 'effect', status: 'synced', ref: 'main' },
  { name: 'broken-repo', status: 'error', message: 'network timeout' },
  { name: 'missing-repo', status: 'error', message: 'repository not found' },
  { name: 'effect-utils', status: 'already_synced' },
]

export const exampleAllSynced: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'already_synced' },
  { name: 'livestore', status: 'already_synced' },
  { name: 'dotfiles', status: 'already_synced' },
  { name: 'schickling.dev', status: 'already_synced' },
]

export const exampleLockSyncResults: MemberLockSyncResult[] = [
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
// State Factories
// =============================================================================

export const createBaseState = (overrides?: Partial<SyncStateType>): SyncStateType => ({
  _tag: 'Success',
  workspace: { name: 'my-workspace', root: '/Users/dev/workspace' },
  options: { dryRun: false, frozen: false, pull: false, all: false, verbose: false },
  members: [],
  activeMember: null,
  results: [],
  logs: [],
  startedAt: null,
  nestedMegarepos: [],
  generatedFiles: [],
  lockSyncResults: [],
  syncTree: {
    root: '/Users/dev/workspace',
    results: [],
    nestedMegarepos: [],
    nestedResults: [],
  },
  syncErrors: [],
  syncErrorCount: 0,
  ...overrides,
})

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

/**
 * Creates a timeline that animates through syncing each member and ends with the provided final state.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createTimeline = (
  finalState: Partial<SyncStateType>,
): Array<{ at: number; action: typeof SyncAction.Type }> => {
  const results = finalState.results ?? []
  const members = finalState.members ?? results.map((r) => r.name)
  const workspace = finalState.workspace ?? { name: 'my-workspace', root: '/Users/dev/workspace' }
  const options = finalState.options ?? { dryRun: false, frozen: false, pull: false, all: false }
  const nestedMegarepos = finalState.nestedMegarepos ?? []
  const generatedFiles = finalState.generatedFiles ?? []

  if (results.length === 0) {
    // No results - just show complete state
    return [
      {
        at: 0,
        action: {
          _tag: 'SetState',
          state: createBaseState({ ...finalState, _tag: 'Success' }),
        },
      },
    ]
  }

  const timeline: Array<{ at: number; action: typeof SyncAction.Type }> = []
  const stepDuration = 800

  // Start syncing
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

  // Add each result progressively
  for (let i = 0; i < results.length; i++) {
    const currentResults = results.slice(0, i + 1)
    const nextMember = i + 1 < members.length ? (members[i + 1] ?? null) : null
    const isFinal = i === results.length - 1
    const hasErrors = isFinal && currentResults.some((r) => r.status === 'error')

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
          nestedMegarepos: i === results.length - 1 ? nestedMegarepos : [],
          generatedFiles: i === results.length - 1 ? generatedFiles : [],
        }),
      },
    })
  }

  return timeline
}
