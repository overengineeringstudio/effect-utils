/**
 * Storybook stories for StoreLs (list) output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
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
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
  },
  argTypes: {
    height: commonArgTypes.height,
    interactive: {
      description: 'Enable animated timeline playback (no animation for instant results)',
      control: { type: 'boolean' },
    },
    playbackSpeed: {
      description: 'Playback speed multiplier (when interactive)',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
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
      cwd="~/workspace"
      command="mr store ls"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState(fixtures.exampleStoreRepos)}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const Empty: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store ls"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState([])}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const ManyRepos: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store ls"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createLsState([
        { relativePath: 'github.com/effect-ts/effect' },
        { relativePath: 'github.com/effect-ts/effect-schema' },
        { relativePath: 'github.com/effect-ts/effect-platform' },
        { relativePath: 'github.com/acme-org/dev-tools' },
        { relativePath: 'github.com/acme-org/tui-react' },
        { relativePath: 'github.com/alice/dotfiles' },
        { relativePath: 'github.com/alice/infra-config' },
        { relativePath: 'gitlab.com/company/internal-lib' },
      ])}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
