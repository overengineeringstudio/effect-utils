/**
 * Source type stories for LsOutput - local paths and error states.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: LsView,
  title: 'CLI/Ls/Sources',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta

type Story = StoryObj

/** Members with local filesystem paths as sources */
export const LocalPaths: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={fixtures.createLocalPathsState()} />
  ),
}

/** Error state - megarepo.json not found */
export const ErrorState: Story = {
  render: () => (
    <TuiStoryPreview View={LsView} app={LsApp} initialState={fixtures.createErrorState()} />
  ),
}
