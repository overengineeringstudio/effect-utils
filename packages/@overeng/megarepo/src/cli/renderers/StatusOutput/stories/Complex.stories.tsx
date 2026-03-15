/**
 * Complex StatusOutput stories - nested megarepos, special cases, many members.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { applyCwd, cwdArgType, flagArgTypes, MEMBERS } from '../../_story-constants.ts'
import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
  cwd: string
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
    cwd: '(root)',
  },
  argTypes: {
    height: commonArgTypes.height,
    all: flagArgTypes.all,
    cwd: cwdArgType,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Nested Megarepos
// =============================================================================

/** Nested megarepos (--all flag) */
export const NestedMegarepos: Story = {
  args: { all: true },
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createNestedMegareposState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status --all"
        cwd={cwd}
      />
    )
  },
}

/** Deeply nested megarepos with current location scope dimming */
export const DeeplyNested: Story = {
  args: { cwd: MEMBERS.devTools },
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createDeeplyNestedState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={args.all === true ? 'mr status --all' : 'mr status'}
        cwd={cwd}
      />
    )
  },
}

/** Current location scope dimming — toggle --all to see dimming disabled */
export const CurrentLocation: Story = {
  args: { cwd: MEMBERS.devTools },
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createCurrentLocationState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={args.all === true ? 'mr status --all' : 'mr status'}
        cwd={cwd}
      />
    )
  },
}

// =============================================================================
// Special Cases
// =============================================================================

/** Members pinned to specific refs */
export const PinnedMembers: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createPinnedMembersState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

/** Local path members (../path or /absolute/path) */
export const LocalPathMembers: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createLocalPathMembersState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createManyMembersState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

// =============================================================================
// Multiple Problems
// =============================================================================

/** Multiple different types of problems at once */
export const MultipleProblems: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createMultipleProblemsState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}
