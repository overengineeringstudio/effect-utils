/**
 * Shared fixtures for SyncOutput stories.
 *
 * @internal
 */

import type { MegarepoSyncTree, MemberSyncResult } from '../../../../lib/sync/schema.ts'
import { COMMITS, MEMBERS, PINNED_MEMBERS, WORKSPACE } from '../../_story-constants.ts'
import type { SyncState as SyncStateType } from '../mod.ts'
import type {
  LockSharedSourceUpdate,
  MemberLockSyncResult,
  PreflightIssue,
  SyncAction,
} from '../schema.ts'

// =============================================================================
// Helpers
// =============================================================================

/** When force=false, pinned members show as "skipped (pinned)". When force=true, they keep their real result. */
export const applyForceFlag = ({
  results,
  force,
}: {
  results: MemberSyncResult[]
  force: boolean
}): MemberSyncResult[] =>
  results.map((r) =>
    force === false && (PINNED_MEMBERS as readonly string[]).includes(r.name) === true
      ? { name: r.name, status: 'skipped' as const, message: 'pinned' }
      : r,
  )

// =============================================================================
// Example Data
// =============================================================================

export const exampleSyncResults: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'already_synced' },
  { name: MEMBERS.devTools, status: 'synced', ref: 'main' },
  { name: MEMBERS.appPlatform, status: 'cloned', ref: 'main' },
  {
    name: MEMBERS.dotfiles,
    status: 'updated',
    commit: COMMITS.dotfiles.current,
    previousCommit: COMMITS.dotfiles.previous,
  },
  { name: MEMBERS.studioOrg, status: 'skipped', message: 'dirty worktree' },
]

export const exampleSyncResultsWithErrors: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'synced', ref: 'main' },
  { name: MEMBERS.homepage, status: 'error', message: 'network timeout' },
  { name: MEMBERS.studioOrg, status: 'error', message: 'repository not found' },
  { name: MEMBERS.devTools, status: 'already_synced' },
]

export const exampleAllSynced: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'already_synced' },
  { name: MEMBERS.devTools, status: 'already_synced' },
  { name: MEMBERS.appPlatform, status: 'already_synced' },
  { name: MEMBERS.dotfiles, status: 'already_synced' },
  { name: MEMBERS.homepage, status: 'already_synced' },
]

export const exampleLockSyncResults: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.coreLib,
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.coreLib,
            memberName: MEMBERS.coreLib,
            oldRev: COMMITS.coreLib.previous,
            newRev: COMMITS.coreLib.current,
          },
        ],
      },
    ],
  },
]

/** Lock sync results including source file (flake.nix, devenv.yaml) updates */
export const exampleLockSyncWithSourceFiles: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.studioOrg,
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools-browser',
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.homepage,
    files: [
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
]

/** Ref propagation scenario — branch change across members */
export const exampleRefSyncResults: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.studioOrg,
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
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
    sourceMemberName: MEMBERS.devTools,
    targetCount: 3,
  },
]

/** Mixed scenario — all three update types together */
export const exampleMixedSyncResults: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
          {
            _tag: 'RefUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRef: 'main',
            newRef: 'alice/2026-03-08-feature',
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.studioOrg,
    files: [
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
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
    sourceMemberName: MEMBERS.devTools,
    targetCount: 3,
  },
]

// =============================================================================
// Nested Megarepo Fixtures
// =============================================================================

/** Nested sync tree for dev-tools megarepo (used in --all stories) */
export const exampleNestedSyncTrees: MegarepoSyncTree[] = [
  {
    root: `${WORKSPACE.root}/repos/${MEMBERS.devTools}`,
    results: [
      { name: MEMBERS.cliFramework, status: 'synced' as const, ref: 'main' },
      { name: MEMBERS.uiKit, status: 'already_synced' as const },
    ],
    nestedMegarepos: [],
    nestedResults: [],
  },
  {
    root: `${WORKSPACE.root}/repos/${MEMBERS.appPlatform}`,
    results: [{ name: MEMBERS.examples, status: 'already_synced' as const }],
    nestedMegarepos: [],
    nestedResults: [],
  },
]

/** Lock sync results for nested megarepo members */
export const exampleNestedLockSyncResults: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.cliFramework,
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.uiKit,
            memberName: 'ui-kit',
            oldRev: COMMITS.studioOrg.previous,
            newRev: COMMITS.studioOrg.current,
          },
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
  workspace: WORKSPACE,
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
    root: WORKSPACE.root,
    results: [],
    nestedMegarepos: [],
    nestedResults: [],
  },
  syncErrors: [],
  syncErrorCount: 0,
  preflightIssues: [],
  ...overrides,
})

// =============================================================================
// Pre-flight Failure - Example Data & State Factory
// =============================================================================

export const examplePreflightIssues: PreflightIssue[] = [
  {
    severity: 'error',
    type: 'ref_mismatch',
    memberName: MEMBERS.appPlatform,
    message: "worktree HEAD is 'refactor/genie' but expected 'dev'",
    fix: "run 'git -C ~/.megarepo/.../refs/heads/dev checkout dev' or 'mr store fix'",
  },
  {
    severity: 'error',
    type: 'broken_worktree',
    memberName: MEMBERS.devTools,
    message: '.git not found in worktree at ~/.megarepo/.../refs/heads/main',
    fix: "run 'mr apply' to recreate the worktree",
  },
  {
    severity: 'warning',
    type: 'dirty',
    memberName: MEMBERS.dotfiles,
    message: '12 uncommitted changes',
  },
]

export const createPreflightFailedState = (opts: {
  mode: 'apply' | 'lock' | 'fetch'
  issues: PreflightIssue[]
}): SyncStateType =>
  createBaseState({
    _tag: 'PreflightFailed',
    options: { mode: opts.mode, dryRun: false, all: false, verbose: false },
    preflightIssues: opts.issues,
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
  const workspace = finalState.workspace ?? WORKSPACE
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
  const workspace = finalState.workspace ?? WORKSPACE
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
