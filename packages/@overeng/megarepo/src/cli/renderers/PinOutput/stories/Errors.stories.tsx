/**
 * Error stories for PinOutput - various error conditions.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: PinView,
  title: 'CLI/Pin/Errors',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof PinView>

/** Error: Not running in a megarepo workspace */
export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorNotInMegarepo()}
    />
  ),
}

/** Error: Member not found in configuration */
export const ErrorMemberNotFound: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createErrorMemberNotFound()}
    />
  ),
}

/** Error: Member not synced yet */
export const ErrorNotSynced: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createErrorNotSynced()} />
  ),
}

/** Error: Cannot pin local path members */
export const ErrorLocalPath: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createErrorLocalPath()} />
  ),
}

/** Error: Member not in lock file */
export const ErrorNotInLock: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createErrorNotInLock()} />
  ),
}
