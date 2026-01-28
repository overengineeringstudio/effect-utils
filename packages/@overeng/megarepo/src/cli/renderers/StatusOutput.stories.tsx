/**
 * Storybook stories for StatusOutput component.
 */

import type { StoryObj } from '@storybook/react'
import { createCliMeta } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { StatusOutput, type StatusOutputProps, type MemberStatus } from './StatusOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleMembers: MemberStatus[] = [
  {
    name: 'effect',
    exists: true,
    source: 'effect-ts/effect',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' },
  },
  {
    name: 'effect-utils',
    exists: true,
    source: 'overengineeringstudio/effect-utils',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'def5678abc', pinned: false },
    isMegarepo: true,
    nestedMembers: [
      {
        name: 'dotdot',
        exists: true,
        source: 'local',
        isLocal: true,
        lockInfo: undefined,
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: true, changesCount: 3, hasUnpushed: false, branch: 'feature', shortRev: 'fed9876' },
      },
    ],
    gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: true, branch: 'main', shortRev: 'def5678' },
  },
  {
    name: 'livestore',
    exists: false,
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
    source: 'effect-ts/effect',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' },
  },
  {
    name: 'effect-utils',
    exists: true,
    source: 'overengineeringstudio/effect-utils',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'def5678abc', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'def5678' },
  },
]

// =============================================================================
// Meta
// =============================================================================

const meta = createCliMeta<StatusOutputProps>(StatusOutput, {
  title: 'CLI/Status Output',
  description: 'Status command output showing workspace state, member status, and problems.',
  defaultArgs: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    members: [],
  },
})

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  args: {
    members: exampleMembers,
  },
}

export const AllClean: Story = {
  args: {
    members: exampleMembersClean,
    lastSyncTime: new Date(Date.now() - 1000 * 60 * 30),
  },
}

export const WithWarnings: Story = {
  args: {
    members: [
      {
        name: 'effect',
        exists: true,
        source: 'effect-ts/effect',
        isLocal: false,
        lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: true, changesCount: 5, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' },
      },
      {
        name: 'livestore',
        exists: false,
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
        source: 'schickling/dotfiles',
        isLocal: false,
        lockInfo: { ref: 'main', commit: '9876543', pinned: false },
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: true, branch: 'main', shortRev: '9876543' },
      },
    ],
  },
}

export const NestedMegarepos: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    members: [
      {
        name: 'effect-utils',
        exists: true,
        source: 'overengineeringstudio/effect-utils',
        isLocal: false,
        lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
        isMegarepo: true,
        nestedMembers: [
          {
            name: 'cli-ui',
            exists: true,
            source: 'local',
            isLocal: true,
            lockInfo: undefined,
            isMegarepo: false,
            nestedMembers: undefined,
            gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'def5678' },
          },
          {
            name: 'tui-react',
            exists: true,
            source: 'local',
            isLocal: true,
            lockInfo: undefined,
            isMegarepo: false,
            nestedMembers: undefined,
            gitStatus: { isDirty: true, changesCount: 2, hasUnpushed: false, branch: 'feature', shortRev: 'fed9876' },
          },
        ],
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' },
      },
      {
        name: 'livestore',
        exists: true,
        source: 'livestorejs/livestore',
        isLocal: false,
        lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
        isMegarepo: true,
        nestedMembers: [
          {
            name: 'examples',
            exists: true,
            source: 'local',
            isLocal: true,
            lockInfo: undefined,
            isMegarepo: false,
            nestedMembers: undefined,
            gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'dev', shortRev: 'aaa1111' },
          },
        ],
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'dev', shortRev: '9876543' },
      },
    ],
  },
}

export const CurrentLocation: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    members: [
      {
        name: 'effect-utils',
        exists: true,
        source: 'overengineeringstudio/effect-utils',
        isLocal: false,
        lockInfo: { ref: 'main', commit: 'abc1234', pinned: false },
        isMegarepo: true,
        nestedMembers: [
          {
            name: 'tui-react',
            exists: true,
            source: 'local',
            isLocal: true,
            lockInfo: undefined,
            isMegarepo: false,
            nestedMembers: undefined,
            gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'def5678' },
          },
        ],
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' },
      },
      {
        name: 'livestore',
        exists: true,
        source: 'livestorejs/livestore',
        isLocal: false,
        lockInfo: { ref: 'dev', commit: '9876543', pinned: false },
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'dev', shortRev: '9876543' },
      },
    ],
    currentMemberPath: ['effect-utils', 'tui-react'],
  },
}

export const LockStale: Story = {
  args: {
    members: exampleMembersClean,
    lockStaleness: {
      exists: true,
      missingFromLock: ['new-repo', 'another-repo'],
      extraInLock: ['old-repo'],
    },
  },
}

export const LockMissing: Story = {
  args: {
    members: exampleMembersClean,
    lockStaleness: {
      exists: false,
      missingFromLock: [],
      extraInLock: [],
    },
  },
}

export const PinnedMembers: Story = {
  args: {
    members: [
      {
        name: 'effect',
        exists: true,
        source: 'effect-ts/effect',
        isLocal: false,
        lockInfo: { ref: 'v3.0.0', commit: 'abc1234', pinned: true },
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'HEAD', shortRev: 'abc1234' },
      },
      {
        name: 'effect-utils',
        exists: true,
        source: 'overengineeringstudio/effect-utils',
        isLocal: false,
        lockInfo: { ref: 'main', commit: 'def5678', pinned: false },
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'def5678' },
      },
    ],
  },
}

export const ManyMembers: Story = {
  args: {
    name: 'large-workspace',
    root: '/Users/dev/large-workspace',
    members: Array.from({ length: 10 }, (_, i) => ({
      name: `repo-${String(i + 1).padStart(2, '0')}`,
      exists: true,
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
    lastSyncTime: new Date(Date.now() - 1000 * 60 * 60 * 2),
  },
}

// =============================================================================
// Edge Cases
// =============================================================================

export const AllNotSynced: Story = {
  args: {
    name: 'new-workspace',
    root: '/Users/dev/new-workspace',
    members: [
      { name: 'effect', exists: false, source: 'effect-ts/effect', isLocal: false, lockInfo: { ref: 'main', commit: 'abc1234', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: undefined },
      { name: 'effect-utils', exists: false, source: 'overengineeringstudio/effect-utils', isLocal: false, lockInfo: { ref: 'main', commit: 'def5678', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: undefined },
      { name: 'livestore', exists: false, source: 'livestorejs/livestore', isLocal: false, lockInfo: { ref: 'dev', commit: '9876543', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: undefined },
    ],
  },
}

export const AllDirty: Story = {
  args: {
    members: [
      { name: 'effect', exists: true, source: 'effect-ts/effect', isLocal: false, lockInfo: { ref: 'main', commit: 'abc1234', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 12, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' } },
      { name: 'effect-utils', exists: true, source: 'overengineeringstudio/effect-utils', isLocal: false, lockInfo: { ref: 'main', commit: 'def5678', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 3, hasUnpushed: false, branch: 'feature', shortRev: 'def5678' } },
      { name: 'livestore', exists: true, source: 'livestorejs/livestore', isLocal: false, lockInfo: { ref: 'dev', commit: '9876543', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 25, hasUnpushed: true, branch: 'dev', shortRev: '9876543' } },
    ],
  },
}

export const LocalPathMembers: Story = {
  args: {
    name: 'local-dev',
    root: '/Users/dev/local-dev',
    members: [
      { name: 'my-lib', exists: true, source: '../my-lib', isLocal: true, lockInfo: undefined, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' } },
      { name: 'shared-utils', exists: true, source: '/Users/dev/shared-utils', isLocal: true, lockInfo: undefined, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 2, hasUnpushed: false, branch: 'main', shortRev: 'def5678' } },
    ],
  },
}

export const SingleMember: Story = {
  args: {
    name: 'minimal',
    root: '/Users/dev/minimal',
    members: [
      { name: 'effect', exists: true, source: 'effect-ts/effect', isLocal: false, lockInfo: { ref: 'main', commit: 'abc1234', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' } },
    ],
    lastSyncTime: new Date(Date.now() - 1000 * 60 * 5),
  },
}

export const EmptyWorkspace: Story = {
  args: {
    name: 'empty-workspace',
    root: '/Users/dev/empty-workspace',
    members: [],
  },
}

export const DeeplyNested: Story = {
  args: {
    name: 'deep-workspace',
    root: '/Users/dev/deep-workspace',
    members: [
      {
        name: 'level-1',
        exists: true,
        source: 'org/level-1',
        isLocal: false,
        lockInfo: { ref: 'main', commit: 'aaa1111', pinned: false },
        isMegarepo: true,
        nestedMembers: [
          {
            name: 'level-2a',
            exists: true,
            source: 'org/level-2a',
            isLocal: false,
            lockInfo: { ref: 'main', commit: 'bbb2222', pinned: false },
            isMegarepo: true,
            nestedMembers: [
              { name: 'level-3', exists: true, source: 'org/level-3', isLocal: false, lockInfo: { ref: 'main', commit: 'ccc3333', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'ccc3333' } },
            ],
            gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'bbb2222' },
          },
          { name: 'level-2b', exists: true, source: 'org/level-2b', isLocal: false, lockInfo: { ref: 'dev', commit: 'ddd4444', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 3, hasUnpushed: false, branch: 'dev', shortRev: 'ddd4444' } },
        ],
        gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: false, branch: 'main', shortRev: 'aaa1111' },
      },
    ],
    currentMemberPath: ['level-1', 'level-2a', 'level-3'],
  },
}

export const MultipleProblems: Story = {
  args: {
    name: 'problematic-workspace',
    root: '/Users/dev/problematic-workspace',
    members: [
      { name: 'dirty-repo', exists: true, source: 'org/dirty-repo', isLocal: false, lockInfo: { ref: 'main', commit: 'abc1234', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 5, hasUnpushed: false, branch: 'main', shortRev: 'abc1234' } },
      { name: 'unpushed-repo', exists: true, source: 'org/unpushed-repo', isLocal: false, lockInfo: { ref: 'main', commit: 'def5678', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: false, changesCount: 0, hasUnpushed: true, branch: 'feature', shortRev: 'def5678' } },
      { name: 'not-synced-repo', exists: false, source: 'org/not-synced-repo', isLocal: false, lockInfo: { ref: 'dev', commit: '9876543', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: undefined },
      { name: 'all-problems', exists: true, source: 'org/all-problems', isLocal: false, lockInfo: { ref: 'main', commit: 'xyz9999', pinned: false }, isMegarepo: false, nestedMembers: undefined, gitStatus: { isDirty: true, changesCount: 10, hasUnpushed: true, branch: 'wip', shortRev: 'xyz9999' } },
    ],
    lockStaleness: {
      exists: true,
      missingFromLock: ['new-member'],
      extraInLock: ['removed-member'],
    },
  },
}
