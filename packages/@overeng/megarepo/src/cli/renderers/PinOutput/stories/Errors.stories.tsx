/**
 * Error stories for PinOutput - various error conditions.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
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

export default {
  component: PinView,
  title: 'CLI/Pin/Errors',
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

/** Error: Not running in a megarepo workspace */
export const ErrorNotInMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorNotInMegarepo()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: Member not found in configuration */
export const ErrorMemberNotFound: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorMemberNotFound()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: Member not synced yet */
export const ErrorNotSynced: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorNotSynced()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: Cannot pin local path members */
export const ErrorLocalPath: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorLocalPath()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: Member not in lock file */
export const ErrorNotInLock: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorNotInLock()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
