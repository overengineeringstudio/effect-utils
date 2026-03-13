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
  options: { mode: 'workspace', dryRun: false, all: false, verbose: false },
  members: [],
  activeMembers: [],
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
 * Creates a timeline that animates through syncing members with parallel execution.
 * Models concurrency=4 (like real TTY mode): up to 4 members start together,
 * results arrive at staggered intervals, and new members start as slots free up.
 */
export const createTimeline = (
  finalState: Partial<SyncStateType>,
): Array<{ at: number; action: typeof SyncAction.Type }> => {
  const results = finalState.results ?? []
  const members = finalState.members ?? results.map((r) => r.name)
  const workspace = finalState.workspace ?? { name: 'my-workspace', root: '/Users/dev/workspace' }
  const options = finalState.options ?? { mode: 'workspace', dryRun: false, all: false }
  const nestedMegarepos = finalState.nestedMegarepos ?? []
  const generatedFiles = finalState.generatedFiles ?? []
  const lockSyncResults = finalState.lockSyncResults ?? []

  if (results.length === 0) {
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
  const concurrency = 4
  const resultInterval = 600

  // Step 0: start syncing — first batch of members become active
  const initialActive = members.slice(0, concurrency)
  timeline.push({
    at: 0,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        workspace,
        options,
        _tag: 'Syncing',
        members,
        activeMembers: initialActive,
        results: [],
        startedAt: Date.now(),
      }),
    },
  })

  // Progressive results — as each completes, the next queued member starts
  let nextToStart = concurrency
  const completedResults: Array<(typeof results)[number]> = []
  const currentActive = [...initialActive]
  let runningErrors: Array<{ megarepoRoot: string; memberName: string; message: string | null }> =
    []
  let runningErrorCount = 0

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    completedResults.push(result)

    // Remove completed member from active
    const activeIdx = currentActive.indexOf(result.name)
    if (activeIdx !== -1) currentActive.splice(activeIdx, 1)

    // Start next queued member if any
    if (nextToStart < members.length) {
      currentActive.push(members[nextToStart]!)
      nextToStart++
    }

    if (result.status === 'error') {
      runningErrorCount++
      const matchingError = (finalState.syncErrors ?? []).find((e) => e.memberName === result.name)
      if (matchingError !== undefined) runningErrors.push(matchingError)
    }

    const isFinal = i === results.length - 1
    const hasErrors = runningErrorCount > 0

    timeline.push({
      at: (i + 1) * resultInterval,
      action: {
        _tag: 'SetState',
        state: createBaseState({
          workspace,
          options,
          _tag: isFinal === true ? (hasErrors === true ? 'Error' : 'Success') : 'Syncing',
          members,
          activeMembers: isFinal === true ? [] : [...currentActive],
          results: completedResults.slice(),
          nestedMegarepos: isFinal === true ? nestedMegarepos : [],
          generatedFiles: isFinal === true ? generatedFiles : [],
          lockSyncResults: isFinal === true ? lockSyncResults : [],
          syncErrors: runningErrors.slice(),
          syncErrorCount: runningErrorCount,
        }),
      },
    })
  }

  return timeline
}
