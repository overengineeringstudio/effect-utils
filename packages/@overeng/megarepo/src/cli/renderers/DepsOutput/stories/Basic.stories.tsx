/**
 * Basic stories for DepsOutput - dependency graph scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { DepsApp } from '../mod.ts'
import { DepsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
}

export default {
  component: DepsView,
  title: 'CLI/Deps',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Full dependency graph */
export const DefaultGraph: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr deps"
      View={DepsView}
      app={DepsApp}
      initialState={fixtures.createDepsSuccessState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** No dependencies found */
export const EmptyGraph: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr deps"
      View={DepsView}
      app={DepsApp}
      initialState={fixtures.createDepsEmptyState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Single upstream member with dependents */
export const SingleUpstream: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr deps"
      View={DepsView}
      app={DepsApp}
      initialState={fixtures.createDepsSuccessState(fixtures.singleUpstreamGraph)}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
