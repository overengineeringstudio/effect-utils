/**
 * Complex StatusOutput stories - nested megarepos, special cases, many members.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: StatusView,
  title: 'CLI/Status/Complex',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof StatusView>

// =============================================================================
// Nested Megarepos
// =============================================================================

/** Nested megarepos (--all flag) */
export const NestedMegarepos: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createNestedMegareposState()}
    />
  ),
}

/** Deeply nested megarepos with current location highlighting */
export const DeeplyNested: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createDeeplyNestedState()}
    />
  ),
}

/** Current location highlighting */
export const CurrentLocation: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createCurrentLocationState()}
    />
  ),
}

// =============================================================================
// Special Cases
// =============================================================================

/** Members pinned to specific refs */
export const PinnedMembers: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createPinnedMembersState()}
    />
  ),
}

/** Local path members (../path or /absolute/path) */
export const LocalPathMembers: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLocalPathMembersState()}
    />
  ),
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createManyMembersState()}
    />
  ),
}

// =============================================================================
// Multiple Problems
// =============================================================================

/** Multiple different types of problems at once */
export const MultipleProblems: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createMultipleProblemsState()}
    />
  ),
}
