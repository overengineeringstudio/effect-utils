import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { TaskItem } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getSyncApp } from '../cli-output/sync/app.ts'
import type { SyncPageRow, SyncState } from '../cli-output/sync/schema.ts'
import { SyncView } from '../cli-output/sync/view.tsx'

const SyncApp = getSyncApp()

const FILE = 'docs/getting-started.nmd'
const TREE = 'docs'

/** Single-page push, all stages settled. */
const pushStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success', message: 'remote pulled' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'skipped' },
  { id: 'settle', label: 'settle', status: 'success', message: 'verified' },
]

const singlePushedState: SyncState = {
  _tag: 'Success',
  target: FILE,
  stages: pushStages,
  warnings: [],
  pages: [],
  multi: false,
}

const treePages: readonly SyncPageRow[] = [
  { path: 'index.nmd', outcome: 'updated' },
  { path: 'guide/setup.nmd', outcome: 'created' },
  { path: 'guide/usage.nmd', outcome: 'noop' },
  { path: 'reference/api.nmd', outcome: 'pulled' },
  { path: 'reference/cli.nmd', outcome: 'conflict' },
]

const treeMixedState: SyncState = {
  _tag: 'Conflict',
  target: TREE,
  stages: [],
  warnings: [
    {
      severity: 'warning',
      name: 'reference/cli.nmd',
      status: 'conflict',
      details: 'local and remote both changed — nothing pushed for this page',
      fixes: ['notion-md status reference/cli.nmd to inspect the divergence'],
    },
  ],
  pages: treePages,
  multi: true,
}

const treeCleanState: SyncState = {
  _tag: 'Success',
  target: TREE,
  stages: [],
  warnings: [],
  pages: [
    { path: 'index.nmd', outcome: 'updated' },
    { path: 'guide/setup.nmd', outcome: 'created' },
    { path: 'guide/usage.nmd', outcome: 'noop' },
  ],
  multi: true,
}

const errorState: SyncState = {
  _tag: 'Error',
  target: FILE,
  stages: [
    { id: 'observe', label: 'observe', status: 'success', message: 'remote pulled' },
    { id: 'write-body', label: 'write-body', status: 'error' },
  ],
  warnings: [],
  message: 'NmdGatewayError: failed to push page body',
}

const story = (initialState: SyncState): StoryObj<typeof SyncView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md sync"
      View={SyncView}
      app={SyncApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Sync Output',
  component: SyncView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof SyncView>

export const SinglePagePushed = story(singlePushedState)
export const TreeClean = story(treeCleanState)
export const TreeMixed = story(treeMixedState)
export const ErrorState: StoryObj<typeof SyncView> = { name: 'Error', ...story(errorState) }
