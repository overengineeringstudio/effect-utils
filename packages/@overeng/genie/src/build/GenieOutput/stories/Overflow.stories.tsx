/**
 * Overflow stories for GenieOutput - viewport truncation behavior demos.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, defaultStoryArgs, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { GenieApp } from '../../app.ts'
import { GenieView } from '../../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  mode: 'generate' | 'check' | 'dry-run'
}

export default {
  component: GenieView,
  title: 'CLI/Genie/Overflow',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    height: 300,
    mode: 'generate',
  },
  argTypes: {
    ...commonArgTypes,
    mode: {
      description: 'Genie operation mode',
      control: { type: 'select' },
      options: ['generate', 'check', 'dry-run'],
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Many files in generating phase - demonstrates viewport overflow during progress */
export const ManyFilesGenerating: Story = {
  // Overflow stories focus on viewport truncation testing - interactive mode not applicable
  args: {
    interactive: false,
  },
  argTypes: {
    interactive: { control: false },
    playbackSpeed: { control: false },
  },
  render: (args) => {
    const initialState = useMemo(() => {
      const state = fixtures.createManyFilesState('generating')
      return { ...state, mode: args.mode }
    }, [args.mode])

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={initialState}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}

/** Many files in complete phase - demonstrates viewport overflow in final output */
export const ManyFilesComplete: Story = {
  // Overflow stories focus on viewport truncation testing - interactive mode not applicable
  args: {
    interactive: false,
  },
  argTypes: {
    interactive: { control: false },
    playbackSpeed: { control: false },
  },
  render: (args) => {
    const initialState = useMemo(() => {
      const state = fixtures.createManyFilesState('complete')
      return { ...state, mode: args.mode }
    }, [args.mode])

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={initialState}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}
