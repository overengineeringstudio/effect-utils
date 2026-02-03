/**
 * Basic StatusOutput stories - clean states, single member, empty workspace.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: StatusView,
  title: 'CLI/Status/Basic',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof StatusView>

/** Default state with mixed member status */
export const Default: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createDefaultState()}
    />
  ),
}

/** All members clean, no issues */
export const AllClean: Story = {
  render: () => (
    <TuiStoryPreview View={StatusView} app={StatusApp} initialState={fixtures.createCleanState()} />
  ),
}

/** Workspace with single member */
export const SingleMember: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createSingleMemberState()}
    />
  ),
}

/** Empty workspace with no members */
export const EmptyWorkspace: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createEmptyWorkspaceState()}
    />
  ),
}
