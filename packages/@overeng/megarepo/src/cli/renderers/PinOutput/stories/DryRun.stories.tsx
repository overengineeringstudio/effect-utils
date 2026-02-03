/**
 * Dry run stories for PinOutput - preview what would happen without making changes.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: PinView,
  title: 'CLI/Pin/DryRun',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof PinView>

/** Dry run with full details - ref change, symlink change, worktree creation */
export const DryRunFull: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createDryRunFull()} />
  ),
}

/** Dry run with minimal changes - just pinned flag */
export const DryRunSimple: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createDryRunSimple()} />
  ),
}
