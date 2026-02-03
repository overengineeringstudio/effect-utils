/**
 * Ref tracking related StatusOutput stories.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: StatusView,
  title: 'CLI/Status/Ref Issues',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof StatusView>

/** Lock/symlink track different ref than source specifies */
export const SymlinkDrift: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createSymlinkDriftState()}
    />
  ),
}

/** Multiple members with symlink drift */
export const MultipleSymlinkDrift: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createMultipleSymlinkDriftState()}
    />
  ),
}

/** Git HEAD differs from store path ref (Issue #88) */
export const RefMismatch: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createRefMismatchState()}
    />
  ),
}
