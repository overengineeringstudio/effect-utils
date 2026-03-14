/**
 * Shared fixtures for SyncOutput stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../lib/sync/schema.ts'
import type { SyncState as SyncStateType } from '../mod.ts'
import type { LockSharedSourceUpdate, MemberLockSyncResult, SyncAction } from '../schema.ts'

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
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'livestore',
            memberName: 'livestore',
            oldRev: '1234567',
            newRev: '7654321',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
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
          {
            _tag: 'RevUpdate',
            inputName: 'effect',
            memberName: 'effect',
            oldRev: 'fff0000',
            newRev: 'aaa1111',
          },
        ],
      },
    ],
  },
]

/** Lock sync results including source file (flake.nix, devenv.yaml) updates */
export const exampleLockSyncWithSourceFiles: MemberLockSyncResult[] = [
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'livestore',
            memberName: 'livestore',
            oldRev: '1111111',
            newRev: '2222222',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
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
    memberName: 'overeng',
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils-playwright',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
  {
    memberName: 'schickling.dev',
    files: [
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
]

/** Ref propagation scenario — branch change across members */
export const exampleRefSyncResults: MemberLockSyncResult[] = [
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
    ],
  },
  {
    memberName: 'overeng',
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
    ],
  },
]

/** Shared lock source propagation scenario */
export const exampleSharedSourceSync: LockSharedSourceUpdate[] = [
  {
    _tag: 'SharedSourceUpdate',
    sourceName: 'devenv',
    sourceMemberName: 'effect-utils',
    targetCount: 3,
  },
]

/** Mixed scenario — all three update types together */
export const exampleMixedSyncResults: MemberLockSyncResult[] = [
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'livestore',
            memberName: 'livestore',
            oldRev: '1234567',
            newRev: '7654321',
          },
          {
            _tag: 'RefUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRef: 'main',
            newRef: 'schickling/2026-03-08-foo',
          },
        ],
      },
    ],
  },
  {
    memberName: 'overeng',
    files: [
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'effect-utils',
            memberName: 'effect-utils',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
]

export const exampleMixedSharedSourceSync: LockSharedSourceUpdate[] = [
  {
    _tag: 'SharedSourceUpdate',
    sourceName: 'devenv',
    sourceMemberName: 'effect-utils',
    targetCount: 3,
  },
]

// =============================================================================
// State Factories
// =============================================================================

export const createBaseState = (overrides?: Partial<SyncStateType>): SyncStateType => ({
  _tag: 'Success',
  workspace: { name: 'my-workspace', root: '/Users/dev/workspace' },
  options: { mode: 'apply', dryRun: false, all: false, verbose: false },
  members: [],
  activeMembers: [],
  results: [],
  logs: [],
  startedAt: null,
  nestedMegarepos: [],
  generatedFiles: [],
  lockSyncResults: [],
  sharedSourceUpdates: [],
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
  const options = finalState.options ?? { mode: 'apply', dryRun: false, all: false }
  const nestedMegarepos = finalState.nestedMegarepos ?? []
  const generatedFiles = finalState.generatedFiles ?? []
  const lockSyncResults = finalState.lockSyncResults ?? []
  const sharedSourceUpdates = finalState.sharedSourceUpdates ?? []

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
          sharedSourceUpdates: isFinal === true ? sharedSourceUpdates : [],
          syncErrors: runningErrors.slice(),
          syncErrorCount: runningErrorCount,
        }),
      },
    })
  }

  return timeline
}

// =============================================================================
// Command-specific State & Timeline Factories
// =============================================================================

/** Creates a command-specific state with the given mode and overrides. */
export const createCommandState = ({
  mode,
  overrides,
}: {
  mode: 'lock' | 'fetch' | 'apply'
  overrides: Partial<SyncStateType> & { results: MemberSyncResult[] }
}): SyncStateType =>
  createBaseState({
    options: { mode, dryRun: false, all: false, verbose: false, ...overrides.options },
    members: overrides.results.map((r) => r.name),
    ...overrides,
  })

/**
 * Creates a timeline that animates through a command operation with parallel execution.
 * Models concurrency=4: multiple members syncing simultaneously with staggered completion.
 */
export const createCommandTimeline = ({
  mode,
  finalState,
}: {
  mode: 'lock' | 'fetch' | 'apply'
  finalState: Partial<SyncStateType> & { results: MemberSyncResult[] }
}): Array<{ at: number; action: typeof SyncAction.Type }> => {
  const results = finalState.results
  const members = finalState.members ?? results.map((r) => r.name)
  const workspace = finalState.workspace ?? { name: 'my-workspace', root: '/Users/dev/workspace' }
  const options = finalState.options ?? { mode, dryRun: false, all: false, verbose: false }
  const lockSyncResults = finalState.lockSyncResults ?? []
  const sharedSourceUpdates = finalState.sharedSourceUpdates ?? []
  const syncErrors = finalState.syncErrors ?? []

  const timeline: Array<{ at: number; action: typeof SyncAction.Type }> = []
  const concurrency = 4
  const resultInterval = 600

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

  let nextToStart = concurrency
  const completedResults: typeof results = []
  const currentActive = [...initialActive]
  let runningErrorCount = 0
  const runningErrors: Array<(typeof syncErrors)[number]> = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    completedResults.push(result)

    const activeIdx = currentActive.indexOf(result.name)
    if (activeIdx !== -1) currentActive.splice(activeIdx, 1)

    if (nextToStart < members.length) {
      currentActive.push(members[nextToStart]!)
      nextToStart++
    }

    if (result.status === 'error') {
      runningErrorCount++
      const matchingError = syncErrors.find((e) => e.memberName === result.name)
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
          lockSyncResults: isFinal === true ? lockSyncResults : [],
          sharedSourceUpdates: isFinal === true ? sharedSourceUpdates : [],
          syncErrors: runningErrors.slice(),
          syncErrorCount: runningErrorCount,
        }),
      },
    })
  }

  return timeline
}
