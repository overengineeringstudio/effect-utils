/**
 * Shared fixtures for StatusOutput stories.
 *
 * Contains all state factory functions used across story files.
 *
 * @internal
 */

import type { StatusState, MemberStatus } from '../mod.ts'

// =============================================================================
// State Options
// =============================================================================

type StateOptions = { all?: boolean }

// =============================================================================
// Example Data
// =============================================================================

const exampleMembers: MemberStatus[] = [
  {
    name: 'effect',
    exists: true,
    symlinkExists: true,
    source: 'effect-ts/effect',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'abc1234',
    },
  },
  {
    name: 'effect-utils',
    exists: true,
    symlinkExists: true,
    source: 'overengineeringstudio/effect-utils',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'def5678abc', pinned: false },
    isMegarepo: true,
    nestedMembers: [
      {
        name: 'dotdot',
        exists: true,
        symlinkExists: true,
        source: 'local',
        isLocal: true,
        lockInfo: undefined,
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: {
          isDirty: true,
          changesCount: 3,
          hasUnpushed: false,
          branch: 'feature',
          shortRev: 'fed9876',
        },
      },
    ],
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: true,
      branch: 'main',
      shortRev: 'def5678',
    },
  },
  {
    name: 'livestore',
    exists: false,
    symlinkExists: false,
    source: 'livestorejs/livestore',
    isLocal: false,
    lockInfo: { ref: 'dev', commit: '9876543fed', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: undefined,
  },
]

const exampleMembersClean: MemberStatus[] = [
  {
    name: 'effect',
    exists: true,
    symlinkExists: true,
    source: 'effect-ts/effect',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'abc1234',
    },
  },
  {
    name: 'effect-utils',
    exists: true,
    symlinkExists: true,
    source: 'overengineeringstudio/effect-utils',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'def5678abc', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'def5678',
    },
  },
]

// =============================================================================
// Basic States
// =============================================================================

export const createDefaultState = (options?: StateOptions): typeof StatusState.Type => ({
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: true,
  syncReasons: ["Member 'livestore' symlink missing"],
  members: exampleMembers,
  all: options?.all ?? false,
})

export const createCleanState = (options?: StateOptions): typeof StatusState.Type => ({
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: false,
  syncReasons: [],
  members: exampleMembersClean,
  all: options?.all ?? false,
  lastSyncTime: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
})

export const createSingleMemberState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'minimal',
  root: '/Users/dev/minimal',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
  ],
  lastSyncTime: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
})

export const createEmptyWorkspaceState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'empty-workspace',
  root: '/Users/dev/empty-workspace',
  syncNeeded: false,
  syncReasons: [],
  members: [],
})

// =============================================================================
// Lock File Issues
// =============================================================================

export const createLockMissingState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: true,
  syncReasons: ['Lock file missing'],
  members: exampleMembersClean,
  lockStaleness: {
    exists: false,
    missingFromLock: [],
    extraInLock: [],
  },
})

export const createLockStaleState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: true,
  syncReasons: [
    "Member 'new-repo' not in lock file",
    "Member 'another-repo' not in lock file",
    "Lock file has extra member 'old-repo'",
  ],
  members: exampleMembersClean,
  lockStaleness: {
    exists: true,
    missingFromLock: ['new-repo', 'another-repo'],
    extraInLock: ['old-repo'],
  },
})

export const createStaleLockState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: [
    "Member 'effect-utils' stale lock: lock says 'feat/r12-monitoring' but actual is 'main'",
  ],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'feat/r12-monitoring', commit: 'def5678abc', pinned: false },
      isMegarepo: true,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'fed9876',
      },
      staleLock: {
        lockRef: 'feat/r12-monitoring',
        actualRef: 'main',
      },
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: [],
    extraInLock: [],
  },
})

export const createCommitDriftState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'old1234abc', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'new5678',
      },
      commitDrift: {
        localCommit: 'new5678def',
        lockedCommit: 'old1234abc',
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore#dev',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543fed', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 5,
        hasUnpushed: false,
        branch: 'dev',
        shortRev: 'abc9999',
      },
      commitDrift: {
        localCommit: 'abc9999xyz',
        lockedCommit: '9876543fed',
      },
    },
  ],
})

// =============================================================================
// Ref Tracking Issues
// =============================================================================

export const createSymlinkDriftState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: [
    "Member 'livestore' symlink drift: tracking 'refactor/genie-igor-ci' but source says 'dev'",
  ],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore#dev',
      isLocal: false,
      lockInfo: { ref: 'refactor/genie-igor-ci', commit: 'def5678abc', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 27,
        hasUnpushed: false,
        branch: 'refactor/genie-igor-ci',
        shortRev: 'def5678',
      },
      symlinkDrift: {
        symlinkRef: 'refactor/genie-igor-ci',
        sourceRef: 'dev',
        actualGitBranch: 'refactor/genie-igor-ci',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'fed9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'fed9876',
      },
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: [],
    extraInLock: [],
  },
})

export const createMultipleSymlinkDriftState = (
  options?: StateOptions,
): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: [
    "Member 'livestore' symlink drift: tracking 'refactor/genie-igor-ci' but source says 'dev'",
    "Member 'effect' symlink drift: tracking 'next' but source says 'main'",
  ],
  members: [
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore#dev',
      isLocal: false,
      lockInfo: { ref: 'refactor/genie-igor-ci', commit: 'def5678abc', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 27,
        hasUnpushed: false,
        branch: 'refactor/genie-igor-ci',
        shortRev: 'def5678',
      },
      symlinkDrift: {
        symlinkRef: 'refactor/genie-igor-ci',
        sourceRef: 'dev',
        actualGitBranch: 'refactor/genie-igor-ci',
      },
    },
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'next', commit: 'abc1234def', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'next',
        shortRev: 'abc1234',
      },
      symlinkDrift: {
        symlinkRef: 'next',
        sourceRef: 'main',
        actualGitBranch: 'next',
      },
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: [],
    extraInLock: [],
  },
})

export const createRefMismatchState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: [
    "Member 'effect-utils' ref mismatch: store path implies 'main' but git HEAD is 'feature-branch'",
    "Member 'livestore' ref mismatch: store path implies 'main' but worktree is detached at abc1234",
  ],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'def5678abc', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 5,
        hasUnpushed: false,
        branch: 'feature-branch',
        shortRev: 'def5678',
      },
      refMismatch: {
        expectedRef: 'main',
        actualRef: 'feature-branch',
        isDetached: false,
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'main', commit: '9876543fed', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: undefined,
        shortRev: 'abc1234',
      },
      refMismatch: {
        expectedRef: 'main',
        actualRef: 'abc1234',
        isDetached: true,
      },
    },
  ],
})

// =============================================================================
// Working Tree Issues
// =============================================================================

export const createAllDirtyState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 12,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'def5678', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 3,
        hasUnpushed: false,
        branch: 'feature',
        shortRev: 'def5678',
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 25,
        hasUnpushed: true,
        branch: 'dev',
        shortRev: '9876543',
      },
    },
  ],
})

export const createAllNotSyncedState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'new-workspace',
  root: '/Users/dev/new-workspace',
  syncNeeded: true,
  syncReasons: [
    "Member 'effect' symlink missing",
    "Member 'effect-utils' symlink missing",
    "Member 'livestore' symlink missing",
  ],
  members: [
    {
      name: 'effect',
      exists: false,
      symlinkExists: false,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: undefined,
    },
    {
      name: 'effect-utils',
      exists: false,
      symlinkExists: false,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'def5678', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: undefined,
    },
    {
      name: 'livestore',
      exists: false,
      symlinkExists: false,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: undefined,
    },
  ],
})

export const createWarningsState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: true,
  syncReasons: ["Member 'livestore' symlink missing"],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 5,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'livestore',
      exists: false,
      symlinkExists: false,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: 'def5678', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: undefined,
    },
    {
      name: 'dotfiles',
      exists: true,
      symlinkExists: true,
      source: 'schickling/dotfiles',
      isLocal: false,
      lockInfo: { ref: 'main', commit: '9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: true,
        branch: 'main',
        shortRev: '9876543',
      },
    },
  ],
})

// =============================================================================
// Special Cases
// =============================================================================

export const createPinnedMembersState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect',
      exists: true,
      symlinkExists: true,
      source: 'effect-ts/effect',
      isLocal: false,
      lockInfo: { ref: 'v3.0.0', commit: 'abc1234', pinned: true },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'HEAD',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'def5678', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'def5678',
      },
    },
  ],
})

export const createLocalPathMembersState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'local-dev',
  root: '/Users/dev/local-dev',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'my-lib',
      exists: true,
      symlinkExists: true,
      source: '../my-lib',
      isLocal: true,
      lockInfo: undefined,
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'shared-utils',
      exists: true,
      symlinkExists: true,
      source: '/Users/dev/shared-utils',
      isLocal: true,
      lockInfo: undefined,
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 2,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'def5678',
      },
    },
  ],
})

export const createManyMembersState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'large-workspace',
  root: '/Users/dev/large-workspace',
  syncNeeded: false,
  syncReasons: [],
  members: Array.from({ length: 10 }, (_, i) => ({
    name: `repo-${String(i + 1).padStart(2, '0')}`,
    exists: true,
    symlinkExists: true,
    source: `org/repo-${i + 1}`,
    isLocal: false,
    lockInfo: { ref: 'main', commit: `abc${i}def`, pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: i % 3 === 0,
      changesCount: i % 3 === 0 ? i + 1 : 0,
      hasUnpushed: i % 5 === 0,
      branch: 'main',
      shortRev: `abc${i}def`.slice(0, 7),
    },
  })),
  lastSyncTime: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
})

// =============================================================================
// Complex / Nested
// =============================================================================

export const createNestedMegareposState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? true,
  name: 'mr-all-blue',
  root: '/Users/dev/mr-all-blue',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: true,
      nestedMembers: [
        {
          name: 'cli-ui',
          exists: true,
          symlinkExists: true,
          source: 'local',
          isLocal: true,
          lockInfo: undefined,
          isMegarepo: false,
          nestedMembers: undefined,
          gitStatus: {
            isDirty: false,
            changesCount: 0,
            hasUnpushed: false,
            branch: 'main',
            shortRev: 'def5678',
          },
        },
        {
          name: 'tui-react',
          exists: true,
          symlinkExists: true,
          source: 'local',
          isLocal: true,
          lockInfo: undefined,
          isMegarepo: false,
          nestedMembers: undefined,
          gitStatus: {
            isDirty: true,
            changesCount: 2,
            hasUnpushed: false,
            branch: 'feature',
            shortRev: 'fed9876',
          },
        },
      ],
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
      isMegarepo: true,
      nestedMembers: [
        {
          name: 'examples',
          exists: true,
          symlinkExists: true,
          source: 'local',
          isLocal: true,
          lockInfo: undefined,
          isMegarepo: false,
          nestedMembers: undefined,
          gitStatus: {
            isDirty: false,
            changesCount: 0,
            hasUnpushed: false,
            branch: 'dev',
            shortRev: 'aaa1111',
          },
        },
      ],
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'dev',
        shortRev: '9876543',
      },
    },
  ],
})

export const createCurrentLocationState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? true,
  name: 'mr-all-blue',
  root: '/Users/dev/mr-all-blue',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'effect-utils',
      exists: true,
      symlinkExists: true,
      source: 'overengineeringstudio/effect-utils',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: true,
      nestedMembers: [
        {
          name: 'tui-react',
          exists: true,
          symlinkExists: true,
          source: 'local',
          isLocal: true,
          lockInfo: undefined,
          isMegarepo: false,
          nestedMembers: undefined,
          gitStatus: {
            isDirty: false,
            changesCount: 0,
            hasUnpushed: false,
            branch: 'main',
            shortRev: 'def5678',
          },
        },
      ],
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'dev',
        shortRev: '9876543',
      },
    },
  ],
  currentMemberPath: ['effect-utils', 'tui-react'],
})

export const createDeeplyNestedState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? true,
  name: 'deep-workspace',
  root: '/Users/dev/deep-workspace',
  syncNeeded: false,
  syncReasons: [],
  members: [
    {
      name: 'level-1',
      exists: true,
      symlinkExists: true,
      source: 'org/level-1',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'aaa1111', pinned: false },
      isMegarepo: true,
      nestedMembers: [
        {
          name: 'level-2a',
          exists: true,
          symlinkExists: true,
          source: 'org/level-2a',
          isLocal: false,
          lockInfo: { ref: 'main', commit: 'bbb2222', pinned: false },
          isMegarepo: true,
          nestedMembers: [
            {
              name: 'level-3',
              exists: true,
              symlinkExists: true,
              source: 'org/level-3',
              isLocal: false,
              lockInfo: { ref: 'main', commit: 'ccc3333', pinned: false },
              isMegarepo: false,
              nestedMembers: undefined,
              gitStatus: {
                isDirty: false,
                changesCount: 0,
                hasUnpushed: false,
                branch: 'main',
                shortRev: 'ccc3333',
              },
            },
          ],
          gitStatus: {
            isDirty: false,
            changesCount: 0,
            hasUnpushed: false,
            branch: 'main',
            shortRev: 'bbb2222',
          },
        },
        {
          name: 'level-2b',
          exists: true,
          symlinkExists: true,
          source: 'org/level-2b',
          isLocal: false,
          lockInfo: { ref: 'dev', commit: 'ddd4444', pinned: false },
          isMegarepo: false,
          nestedMembers: undefined,
          gitStatus: {
            isDirty: true,
            changesCount: 3,
            hasUnpushed: false,
            branch: 'dev',
            shortRev: 'ddd4444',
          },
        },
      ],
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'aaa1111',
      },
    },
  ],
  currentMemberPath: ['level-1', 'level-2a', 'level-3'],
})

export const createMultipleProblemsState = (options?: StateOptions): typeof StatusState.Type => ({
  all: options?.all ?? false,
  name: 'problematic-workspace',
  root: '/Users/dev/problematic-workspace',
  syncNeeded: true,
  syncReasons: [
    "Member 'not-synced-repo' symlink missing",
    "Member 'new-member' not in lock file",
    "Lock file has extra member 'removed-member'",
  ],
  members: [
    {
      name: 'dirty-repo',
      exists: true,
      symlinkExists: true,
      source: 'org/dirty-repo',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 5,
        hasUnpushed: false,
        branch: 'main',
        shortRev: 'abc1234',
      },
    },
    {
      name: 'unpushed-repo',
      exists: true,
      symlinkExists: true,
      source: 'org/unpushed-repo',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'def5678', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: false,
        changesCount: 0,
        hasUnpushed: true,
        branch: 'feature',
        shortRev: 'def5678',
      },
    },
    {
      name: 'not-synced-repo',
      exists: false,
      symlinkExists: false,
      source: 'org/not-synced-repo',
      isLocal: false,
      lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: undefined,
    },
    {
      name: 'all-problems',
      exists: true,
      symlinkExists: true,
      source: 'org/all-problems',
      isLocal: false,
      lockInfo: { ref: 'main', commit: 'xyz9999', pinned: false },
      isMegarepo: false,
      nestedMembers: undefined,
      gitStatus: {
        isDirty: true,
        changesCount: 10,
        hasUnpushed: true,
        branch: 'wip',
        shortRev: 'xyz9999',
      },
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: ['new-member'],
    extraInLock: ['removed-member'],
  },
})
