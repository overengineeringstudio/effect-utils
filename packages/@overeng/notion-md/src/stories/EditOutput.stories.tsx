import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { TaskItem } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getEditApp } from '../cli-output/edit/app.ts'
import type { EditState } from '../cli-output/edit/schema.ts'
import { EditView } from '../cli-output/edit/view.tsx'

const EditApp = getEditApp()

const PAGE = '00000000-0000-4000-8000-000000000001'

/** All four engine stages, settled, for a body+title push (the common case). */
const settledStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'success' },
  { id: 'settle', label: 'settle', status: 'success', message: 'verified' },
]

/** Body-only push: the title stage is a skip. */
const bodyOnlyStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'skipped' },
  { id: 'settle', label: 'settle', status: 'success', message: 'verified' },
]

const pushedState: EditState = {
  _tag: 'Success',
  page: PAGE,
  stages: settledStages,
  warnings: [],
  noChange: false,
  titleWritten: true,
}

const noopState: EditState = {
  _tag: 'Success',
  page: PAGE,
  stages: [],
  warnings: [],
  noChange: true,
}

const autoMergeState: EditState = {
  _tag: 'Success',
  page: PAGE,
  stages: bodyOnlyStages,
  warnings: [
    {
      severity: 'warning',
      name: 'auto-merge',
      status: 'merged',
      details: 'remote changed since pull — auto-merged your edit with the upstream change',
      fixes: ['cat the page to confirm the merged result before further edits'],
    },
  ],
  noChange: false,
  titleWritten: false,
}

const conflictState: EditState = {
  _tag: 'Conflict',
  page: PAGE,
  // Conflict aborts before the body write: only observe ran.
  stages: [{ id: 'observe', label: 'observe', status: 'success' }],
  warnings: [
    {
      severity: 'warning',
      name: `${PAGE}.conflict.md`,
      status: 'conflict',
      details: 'remote changed and overlaps your edit — nothing pushed',
      fixes: [`open ${PAGE}.conflict.md to resolve, then re-run \`notion-md edit\``],
    },
  ],
  conflictPath: `${PAGE}.conflict.md`,
}

const errorState: EditState = {
  _tag: 'Error',
  page: PAGE,
  stages: [
    { id: 'observe', label: 'observe', status: 'success' },
    { id: 'write-body', label: 'write-body', status: 'error' },
  ],
  warnings: [],
  message: 'NmdGatewayError: failed to replace page body',
}

const story = (initialState: EditState): StoryObj<typeof EditView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md edit"
      View={EditView}
      app={EditApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Edit Output',
  component: EditView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EditView>

export const Pushed = story(pushedState)
export const NoChange = story(noopState)
export const AutoMergeDrift = story(autoMergeState)
export const Conflict = story(conflictState)
export const ErrorState: StoryObj<typeof EditView> = { name: 'Error', ...story(errorState) }
