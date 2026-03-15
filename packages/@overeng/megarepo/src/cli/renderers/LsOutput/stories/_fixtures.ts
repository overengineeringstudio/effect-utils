/**
 * Shared fixtures for LsOutput stories.
 *
 * @internal
 */

import type { LsState as LsStateType, MemberInfo } from '../mod.ts'

// =============================================================================
// Example Data
// =============================================================================

export const exampleMembers: MemberInfo[] = [
  {
    name: 'core-lib',
    source: 'alice/core-lib',
    owner: { _tag: 'Root' },
    isMegarepo: false,
  },
  {
    name: 'dev-tools',
    source: 'acme-org/dev-tools',
    owner: { _tag: 'Root' },
    isMegarepo: true,
  },
  {
    name: 'app-platform',
    source: 'acme-org/app-platform',
    owner: { _tag: 'Root' },
    isMegarepo: false,
  },
]

export const nestedMembers: MemberInfo[] = [
  {
    name: 'core-lib',
    source: 'alice/core-lib',
    owner: { _tag: 'Root' },
    isMegarepo: false,
  },
  {
    name: 'dev-tools',
    source: 'acme-org/dev-tools',
    owner: { _tag: 'Root' },
    isMegarepo: true,
  },
  {
    name: 'tui-react',
    source: 'local',
    owner: { _tag: 'Nested', path: ['dev-tools'] },
    isMegarepo: false,
  },
  {
    name: 'cli-ui',
    source: 'local',
    owner: { _tag: 'Nested', path: ['dev-tools'] },
    isMegarepo: false,
  },
  {
    name: 'app-platform',
    source: 'acme-org/app-platform',
    owner: { _tag: 'Root' },
    isMegarepo: true,
  },
  {
    name: 'examples',
    source: 'local',
    owner: { _tag: 'Nested', path: ['app-platform'] },
    isMegarepo: false,
  },
]

export const deeplyNestedMembers: MemberInfo[] = [
  {
    name: 'level-1',
    source: 'org/level-1',
    owner: { _tag: 'Root' },
    isMegarepo: true,
  },
  {
    name: 'level-2a',
    source: 'org/level-2a',
    owner: { _tag: 'Nested', path: ['level-1'] },
    isMegarepo: true,
  },
  {
    name: 'level-3',
    source: 'org/level-3',
    owner: { _tag: 'Nested', path: ['level-1', 'level-2a'] },
    isMegarepo: false,
  },
  {
    name: 'level-2b',
    source: 'org/level-2b',
    owner: { _tag: 'Nested', path: ['level-1'] },
    isMegarepo: false,
  },
]

export const localPathMembers: MemberInfo[] = [
  {
    name: 'my-lib',
    source: '../my-lib',
    owner: { _tag: 'Root' },
    isMegarepo: false,
  },
  {
    name: 'shared-utils',
    source: '/Users/dev/.megarepo/github.com/alice/shared-utils/refs/heads/main/',
    owner: { _tag: 'Root' },
    isMegarepo: false,
  },
]

// =============================================================================
// State Factories
// =============================================================================

type SuccessStateOptions = { all?: boolean }

export const createDefaultState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: exampleMembers,
  all: options?.all ?? false,
  megarepoName: 'dev-workspace',
})

export const createWithAllFlagState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: nestedMembers,
  all: options?.all ?? true,
  megarepoName: 'dev-workspace',
})

export const createDeeplyNestedState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: deeplyNestedMembers,
  all: options?.all ?? true,
  megarepoName: 'deep-workspace',
})

export const createLocalPathsState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: localPathMembers,
  all: options?.all ?? false,
  megarepoName: 'local-dev',
})

export const createSingleMemberState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: [
    {
      name: 'core-lib',
      source: 'alice/core-lib',
      owner: { _tag: 'Root' },
      isMegarepo: false,
    },
  ],
  all: options?.all ?? false,
  megarepoName: 'minimal',
})

export const createEmptyState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: [],
  all: options?.all ?? false,
  megarepoName: 'empty-workspace',
})

export const createErrorState = (): LsStateType => ({
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found in current directory or any parent',
})

export const createManyMembersState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: Array.from({ length: 15 }, (_, i) => ({
    name: `repo-${String(i + 1).padStart(2, '0')}`,
    source: `org/repo-${i + 1}`,
    owner: { _tag: 'Root' } as const,
    isMegarepo: i % 5 === 0,
  })),
  all: options?.all ?? false,
  megarepoName: 'large-workspace',
})

export const createAllMegareposState = (options?: SuccessStateOptions): LsStateType => ({
  _tag: 'Success',
  members: [
    {
      name: 'dev-tools',
      source: 'acme-org/dev-tools',
      owner: { _tag: 'Root' },
      isMegarepo: true,
    },
    {
      name: 'app-platform',
      source: 'acme-org/app-platform',
      owner: { _tag: 'Root' },
      isMegarepo: true,
    },
    {
      name: 'dotfiles',
      source: 'alice/dotfiles',
      owner: { _tag: 'Root' },
      isMegarepo: true,
    },
  ],
  all: options?.all ?? false,
  megarepoName: 'all-megarepos',
})
