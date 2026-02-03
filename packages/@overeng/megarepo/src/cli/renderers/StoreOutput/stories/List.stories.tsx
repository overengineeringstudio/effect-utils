/**
 * Storybook stories for StoreLs (list) output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

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
      initialState={fixtures.createLsState(fixtures.exampleStoreRepos)}
    />
  ),
}

export const Empty: Story = {
  render: () => (
    <TuiStoryPreview View={StoreView} app={StoreApp} initialState={fixtures.createLsState([])} />
  ),
}

export const ManyRepos: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState([
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
