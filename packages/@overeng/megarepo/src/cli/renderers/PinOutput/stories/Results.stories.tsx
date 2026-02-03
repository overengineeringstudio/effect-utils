/**
 * Result state stories for PinOutput - various pin/unpin completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: PinView,
  title: 'CLI/Pin/Results',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof PinView>

/** Pin member to a specific ref (tag/branch) */
export const PinWithRef: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createPinSuccessWithRef()}
    />
  ),
}

/** Pin member to current commit */
export const PinCurrentCommit: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createPinSuccessWithCommit()}
    />
  ),
}

/** Unpin member */
export const Unpin: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createUnpinSuccess()} />
  ),
}

/** Member already pinned */
export const AlreadyPinned: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createAlreadyPinned()} />
  ),
}

/** Member already unpinned */
export const AlreadyUnpinned: Story = {
  render: () => (
    <TuiStoryPreview View={PinView} app={PinApp} initialState={fixtures.createAlreadyUnpinned()} />
  ),
}
