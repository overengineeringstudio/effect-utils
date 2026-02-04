/**
 * Complex StatusOutput stories - nested megarepos, special cases, many members.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
}

export default {
  component: StatusView,
  title: 'CLI/Status/Complex',
  parameters: {
    layout: 'padded',
  },
  args: {
    height: 400,
    all: false,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    all: {
      description: '--all flag: show nested megarepos recursively',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Nested Megarepos
// =============================================================================

/** Nested megarepos (--all flag) */
export const NestedMegarepos: Story = {
  args: { all: true },
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createNestedMegareposState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Deeply nested megarepos with current location highlighting */
export const DeeplyNested: Story = {
  args: { all: true },
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createDeeplyNestedState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Current location highlighting */
export const CurrentLocation: Story = {
  args: { all: true },
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createCurrentLocationState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

// =============================================================================
// Special Cases
// =============================================================================

/** Members pinned to specific refs */
export const PinnedMembers: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createPinnedMembersState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Local path members (../path or /absolute/path) */
export const LocalPathMembers: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLocalPathMembersState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createManyMembersState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

// =============================================================================
// Multiple Problems
// =============================================================================

/** Multiple different types of problems at once */
export const MultipleProblems: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createMultipleProblemsState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
