/**
 * Storybook stories for LsOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { LsState, MemberInfo } from './LsOutput/mod.ts'
import { LsApp } from './LsOutput/mod.ts'
import { LsView } from './LsOutput/view.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleMembers: MemberInfo[] = [
  {
    name: 'effect',
    source: 'effect-ts/effect',
    megarepoPath: [],
    isMegarepo: false,
  },
  {
    name: 'effect-utils',
    source: 'overengineeringstudio/effect-utils',
    megarepoPath: [],
    isMegarepo: true,
  },
  {
    name: 'livestore',
    source: 'livestorejs/livestore',
    megarepoPath: [],
    isMegarepo: false,
  },
]

const nestedMembers: MemberInfo[] = [
  {
    name: 'effect',
    source: 'effect-ts/effect',
    megarepoPath: [],
    isMegarepo: false,
  },
  {
    name: 'effect-utils',
    source: 'overengineeringstudio/effect-utils',
    megarepoPath: [],
    isMegarepo: true,
  },
  {
    name: 'tui-react',
    source: 'local',
    megarepoPath: ['effect-utils'],
    isMegarepo: false,
  },
  {
    name: 'cli-ui',
    source: 'local',
    megarepoPath: ['effect-utils'],
    isMegarepo: false,
  },
  {
    name: 'livestore',
    source: 'livestorejs/livestore',
    megarepoPath: [],
    isMegarepo: true,
  },
  {
    name: 'examples',
    source: 'local',
    megarepoPath: ['livestore'],
    isMegarepo: false,
  },
]

const deeplyNestedMembers: MemberInfo[] = [
  {
    name: 'level-1',
    source: 'org/level-1',
    megarepoPath: [],
    isMegarepo: true,
  },
  {
    name: 'level-2a',
    source: 'org/level-2a',
    megarepoPath: ['level-1'],
    isMegarepo: true,
  },
  {
    name: 'level-3',
    source: 'org/level-3',
    megarepoPath: ['level-1', 'level-2a'],
    isMegarepo: false,
  },
  {
    name: 'level-2b',
    source: 'org/level-2b',
    megarepoPath: ['level-1'],
    isMegarepo: false,
  },
]

const localPathMembers: MemberInfo[] = [
  {
    name: 'my-lib',
    source: '../my-lib',
    megarepoPath: [],
    isMegarepo: false,
  },
  {
    name: 'shared-utils',
    source: '/Users/dev/shared-utils',
    megarepoPath: [],
    isMegarepo: false,
  },
]

// =============================================================================
// State Factories
// =============================================================================

const createDefaultState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: exampleMembers,
  all: false,
  megarepoName: 'my-workspace',
})

const createWithAllFlagState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: nestedMembers,
  all: true,
  megarepoName: 'my-workspace',
})

const createDeeplyNestedState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: deeplyNestedMembers,
  all: true,
  megarepoName: 'deep-workspace',
})

const createLocalPathsState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: localPathMembers,
  all: false,
  megarepoName: 'local-dev',
})

const createSingleMemberState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: [
    {
      name: 'effect',
      source: 'effect-ts/effect',
      megarepoPath: [],
      isMegarepo: false,
    },
  ],
  all: false,
  megarepoName: 'minimal',
})

const createEmptyState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: [],
  all: false,
  megarepoName: 'empty-workspace',
})

const createErrorState = (): typeof LsState.Type => ({
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found in current directory or any parent',
})

const createManyMembersState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: Array.from({ length: 15 }, (_, i) => ({
    name: `repo-${String(i + 1).padStart(2, '0')}`,
    source: `org/repo-${i + 1}`,
    megarepoPath: [],
    isMegarepo: i % 5 === 0,
  })),
  all: false,
  megarepoName: 'large-workspace',
})

const createAllMegareposState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: [
    {
      name: 'effect-utils',
      source: 'overengineeringstudio/effect-utils',
      megarepoPath: [],
      isMegarepo: true,
    },
    {
      name: 'livestore',
      source: 'livestorejs/livestore',
      megarepoPath: [],
      isMegarepo: true,
    },
    {
      name: 'dotfiles',
      source: 'schickling/dotfiles',
      megarepoPath: [],
      isMegarepo: true,
    },
  ],
  all: false,
  megarepoName: 'all-megarepos',
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'CLI/Ls Output',
  component: LsView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Ls command output showing megarepo members and their sources.',
      },
    },
  },
} satisfies Meta<typeof LsView>

type Story = StoryObj<typeof LsView>

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  render: () => <TuiStoryPreview View={LsView} app={LsApp} initialState={createDefaultState()} />,
}

export const WithAllFlag: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createWithAllFlagState()} />
  ),
}

export const DeeplyNested: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createDeeplyNestedState()} />
  ),
}

export const LocalPaths: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createLocalPathsState()} />
  ),
}

export const SingleMember: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createSingleMemberState()} />
  ),
}

export const EmptyWorkspace: Story = {
  render: () => <TuiStoryPreview View={LsView} app={LsApp} initialState={createEmptyState()} />,
}

export const Error: Story = {
  render: () => <TuiStoryPreview View={LsView} app={LsApp} initialState={createErrorState()} />,
}

export const ManyMembers: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createManyMembersState()} />
  ),
}

export const AllMegarepos: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={createAllMegareposState()} />
  ),
}
