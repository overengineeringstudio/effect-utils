/**
 * Storybook stories for StoreLs (list) output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

const ALL_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

type StoryArgs = {
  height: number
}

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
  args: { height: 400 },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

export const WithRepos: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState(fixtures.exampleStoreRepos)}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const Empty: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState([])}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const ManyRepos: Story = {
  render: (args) => (
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
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
