/**
 * Storybook stories for StoreLs (list) output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView, type StoreRepo, type StoreStateType } from './StoreOutput/mod.ts'

// =============================================================================
// Example Data
// =============================================================================

const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/effect-ts/effect' },
  { relativePath: 'github.com/overengineeringstudio/effect-utils' },
  { relativePath: 'github.com/schickling/dotfiles' },
]

// =============================================================================
// State Factories
// =============================================================================

const createLsState = (repos: StoreRepo[]): StoreStateType => ({
  _tag: 'Ls',
  basePath: '/Users/dev/.megarepo',
  repos,
})

// =============================================================================
// Meta
// =============================================================================

export default {
  component: StoreView,
  title: 'CLI/Store/List',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr store ls` command. Shows repositories in the store.',
      },
    },
  },
} satisfies Meta

type Story = StoryObj<{ height?: number }>

// =============================================================================
// Stories
// =============================================================================

export const WithRepos: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createLsState(exampleStoreRepos)}
    />
  ),
}

export const Empty: Story = {
  render: () => (
    <TuiStoryPreview View={StoreView} app={StoreApp} initialState={createLsState([])} />
  ),
}

export const ManyRepos: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createLsState([
        { relativePath: 'github.com/effect-ts/effect' },
        { relativePath: 'github.com/effect-ts/effect-schema' },
        { relativePath: 'github.com/effect-ts/effect-platform' },
        { relativePath: 'github.com/overengineeringstudio/effect-utils' },
        { relativePath: 'github.com/overengineeringstudio/tui-react' },
        { relativePath: 'github.com/schickling/dotfiles' },
        { relativePath: 'github.com/schickling/config' },
        { relativePath: 'gitlab.com/company/internal-lib' },
      ])}
    />
  ),
}
