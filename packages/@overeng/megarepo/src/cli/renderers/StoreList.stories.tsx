/**
 * Storybook stories for StoreListOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreListOutput, type StoreListOutputProps, type StoreRepo } from './StoreOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/effect-ts/effect' },
  { relativePath: 'github.com/overengineeringstudio/effect-utils' },
  { relativePath: 'github.com/schickling/dotfiles' },
]

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Store/List',
  component: StoreListOutput,
  render: (args) => (
    <TuiStoryPreview>
      <StoreListOutput {...args} />
    </TuiStoryPreview>
  ),
  args: {
    basePath: '/Users/dev/.megarepo',
    repos: [],
  },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr store ls` command. Shows repositories in the store.',
      },
    },
  },
} satisfies Meta<StoreListOutputProps>

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const WithRepos: Story = {
  args: {
    repos: exampleStoreRepos,
  },
}

export const Empty: Story = {
  args: {
    repos: [],
  },
}

export const ManyRepos: Story = {
  args: {
    repos: [
      { relativePath: 'github.com/effect-ts/effect' },
      { relativePath: 'github.com/effect-ts/effect-schema' },
      { relativePath: 'github.com/effect-ts/effect-platform' },
      { relativePath: 'github.com/overengineeringstudio/effect-utils' },
      { relativePath: 'github.com/overengineeringstudio/tui-react' },
      { relativePath: 'github.com/schickling/dotfiles' },
      { relativePath: 'github.com/schickling/config' },
      { relativePath: 'gitlab.com/company/internal-lib' },
    ],
  },
}
