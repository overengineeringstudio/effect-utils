/**
 * Error state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: ExecView,
  title: 'CLI/Exec/Errors',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Error output views for the `mr exec` command.',
      },
    },
  },
} satisfies Meta

type Story = StoryObj

export const NotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview View={ExecView} app={ExecApp} initialState={fixtures.errorState} />
  ),
}

export const MemberNotFound: Story = {
  render: () => (
    <TuiStoryPreview View={ExecView} app={ExecApp} initialState={fixtures.memberNotFoundState} />
  ),
}
