/**
 * Nested member stories for LsOutput - hierarchical workspace scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { applyCwd, cwdArgType, flagArgTypes } from '../../_story-constants.ts'
import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
  cwd: string
}

export default {
  component: LsView,
  title: 'CLI/Ls/Nested',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    all: true,
    cwd: '(root)',
  },
  argTypes: {
    height: commonArgTypes.height,
    all: flagArgTypes.all,
    cwd: cwdArgType,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Nested members with --all flag */
export const WithAllFlag: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createWithAllFlagState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls --all"
        cwd={cwd}
      />
    )
  },
}

/** Deeply nested hierarchy (3+ levels) */
export const DeeplyNested: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createDeeplyNestedState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls --all"
        cwd={cwd}
      />
    )
  },
}
