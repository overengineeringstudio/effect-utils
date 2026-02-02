/**
 * Storybook stories for StatusOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { StatusState } from './StatusOutput/mod.ts'
import { StatusApp, type MemberStatus } from './StatusOutput/mod.ts'
import { StatusView } from './StatusOutput/view.tsx'

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
// State Factories
// =============================================================================

const createDefaultState = (): typeof StatusState.Type => ({
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: true,
  syncReasons: ["Member 'livestore' symlink missing"],
  members: exampleMembers,
  all: false,
})

const createCleanState = (): typeof StatusState.Type => ({
  name: 'my-workspace',
  root: '/Users/dev/workspace',
  syncNeeded: false,
  syncReasons: [],
  members: exampleMembersClean,
  all: false,
  lastSyncTime: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
})

const createWarningsState = (): typeof StatusState.Type => ({
  all: false,
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

const createNestedMegareposState = (): typeof StatusState.Type => ({
  all: true,
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

const createCurrentLocationState = (): typeof StatusState.Type => ({
  all: true,
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

const createLockStaleState = (): typeof StatusState.Type => ({
  all: false,
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

const createLockMissingState = (): typeof StatusState.Type => ({
  all: false,
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

const createPinnedMembersState = (): typeof StatusState.Type => ({
  all: false,
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

const createManyMembersState = (): typeof StatusState.Type => ({
  all: false,
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

const createAllNotSyncedState = (): typeof StatusState.Type => ({
  all: false,
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

const createAllDirtyState = (): typeof StatusState.Type => ({
  all: false,
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

const createLocalPathMembersState = (): typeof StatusState.Type => ({
  all: false,
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

const createSingleMemberState = (): typeof StatusState.Type => ({
  all: false,
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

const createEmptyWorkspaceState = (): typeof StatusState.Type => ({
  all: false,
  name: 'empty-workspace',
  root: '/Users/dev/empty-workspace',
  syncNeeded: false,
  syncReasons: [],
  members: [],
})

const createDeeplyNestedState = (): typeof StatusState.Type => ({
  all: true,
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

const createMultipleProblemsState = (): typeof StatusState.Type => ({
  all: false,
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

const createSymlinkDriftState = (): typeof StatusState.Type => ({
  all: false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: ["Member 'livestore' symlink drift: dev → refactor/genie-igor-ci"],
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
      symlinkDrift: undefined,
    },
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
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
        symlinkRef: 'dev',
        expectedRef: 'refactor/genie-igor-ci',
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
      symlinkDrift: undefined,
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: [],
    extraInLock: [],
  },
})

const createMultipleSymlinkDriftState = (): typeof StatusState.Type => ({
  all: false,
  name: 'my-megarepo',
  root: '/Users/dev/my-megarepo',
  syncNeeded: true,
  syncReasons: [
    "Member 'livestore' symlink drift: dev → refactor/genie-igor-ci",
    "Member 'effect' symlink drift: main → next",
  ],
  members: [
    {
      name: 'livestore',
      exists: true,
      symlinkExists: true,
      source: 'livestorejs/livestore',
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
        symlinkRef: 'dev',
        expectedRef: 'refactor/genie-igor-ci',
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
        branch: 'main',
        shortRev: 'abc1234',
      },
      symlinkDrift: {
        symlinkRef: 'main',
        expectedRef: 'next',
        actualGitBranch: 'main',
      },
    },
  ],
  lockStaleness: {
    exists: true,
    missingFromLock: [],
    extraInLock: [],
  },
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'CLI/Status Output',
  component: StatusView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Status command output showing workspace state, member status, and problems.',
      },
    },
  },
} satisfies Meta<typeof StatusView>

type Story = StoryObj<typeof StatusView>

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createDefaultState()} />
  ),
}

export const AllClean: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createCleanState()} />
  ),
}

export const WithWarnings: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createWarningsState()} />
  ),
}

export const NestedMegarepos: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={createNestedMegareposState()}
    />
  ),
}

export const CurrentLocation: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={createCurrentLocationState()}
    />
  ),
}

export const LockStale: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createLockStaleState()} />
  ),
}

export const LockMissing: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createLockMissingState()} />
  ),
}

export const PinnedMembers: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createPinnedMembersState()} />
  ),
}

export const ManyMembers: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createManyMembersState()} />
  ),
}

// =============================================================================
// Edge Cases
// =============================================================================

export const AllNotSynced: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createAllNotSyncedState()} />
  ),
}

export const AllDirty: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createAllDirtyState()} />
  ),
}

export const LocalPathMembers: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={createLocalPathMembersState()}
    />
  ),
}

export const SingleMember: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createSingleMemberState()} />
  ),
}

export const EmptyWorkspace: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createEmptyWorkspaceState()} />
  ),
}

export const DeeplyNested: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createDeeplyNestedState()} />
  ),
}

export const MultipleProblems: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={createMultipleProblemsState()}
    />
  ),
}

export const SymlinkDrift: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={createSymlinkDriftState()} />
  ),
}

export const MultipleSymlinkDrift: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={createMultipleSymlinkDriftState()}
    />
  ),
}
