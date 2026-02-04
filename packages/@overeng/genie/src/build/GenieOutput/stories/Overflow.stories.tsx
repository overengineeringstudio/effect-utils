/**
 * Overflow stories for GenieOutput - viewport truncation behavior demos.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { GenieApp } from '../../app.ts'
import { GenieView } from '../../view.tsx'
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
    height: 300,
    interactive: false,
    playbackSpeed: 1,
    mode: 'generate',
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels - reduce height to see truncation behavior',
      control: { type: 'range', min: 150, max: 600, step: 25 },
    },
    interactive: {
      description: 'Enable animated timeline playback',
      control: { type: 'boolean' },
    },
    playbackSpeed: {
      description: 'Playback speed multiplier (when interactive)',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
    },
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
        tabs={ALL_TABS}
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
        tabs={ALL_TABS}
      />
    )
  },
}
