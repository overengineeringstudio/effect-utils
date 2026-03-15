/**
 * Basic stories for DepsOutput - dependency graph scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

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
    height: commonArgTypes.height,
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

/** Error state — no lock file */
export const ErrorNoLockFile: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr deps"
      View={DepsView}
      app={DepsApp}
      initialState={fixtures.createDepsErrorState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Error state — custom message */
export const ErrorCustom: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr deps"
      View={DepsView}
      app={DepsApp}
      initialState={fixtures.createDepsErrorState(
        'Failed to parse flake.lock in member effect-utils',
      )}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
