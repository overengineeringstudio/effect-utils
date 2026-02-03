/**
 * Warning stories for PinOutput - non-blocking issues.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: PinView,
  title: 'CLI/Pin/Warnings',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof PinView>

/** Warning: Worktree for pinned ref not available */
export const WarningWorktreeNotAvailable: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createWarningWorktreeNotAvailable()}
    />
  ),
}

/** Warning: Member was removed from config */
export const WarningMemberRemovedFromConfig: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createWarningMemberRemovedFromConfig()}
    />
  ),
}
