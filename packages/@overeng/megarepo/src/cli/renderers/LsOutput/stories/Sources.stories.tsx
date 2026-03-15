/**
 * Source type stories for LsOutput - local paths and error states.
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
  title: 'CLI/Ls/Sources',
  parameters: {
    layout: 'fullscreen',
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

/** Members with local filesystem paths as sources */
export const LocalPaths: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createLocalPathsState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}

/** Error state - megarepo.json not found */
export const ErrorState: Story = {
  render: (args) => {
    const { cwd } = applyCwd({ state: fixtures.createErrorState(), cwdArg: args.cwd })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={fixtures.createErrorState()}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}
