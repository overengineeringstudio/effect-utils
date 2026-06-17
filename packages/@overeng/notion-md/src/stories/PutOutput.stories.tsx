import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { TaskItem } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getPutApp } from '../cli-output/put/app.ts'
import type { PutState } from '../cli-output/put/schema.ts'
import { PutView } from '../cli-output/put/view.tsx'

const PutApp = getPutApp()

const PAGE = '00000000-0000-4000-8000-000000000001'
const NEW_HASH = 'sha256:9f2c0a7b'

/** Body+title write, all stages settled (the common guarded `put`). */
const titleStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'success' },
]

/** Body-only write: the title was unchanged, so its stage is a skip. */
const bodyOnlyStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'skipped' },
]

/** Partial write: body landed, title failed (`✗`). */
const partialStages: readonly TaskItem[] = [
  { id: 'observe', label: 'observe', status: 'success' },
  { id: 'write-body', label: 'write-body', status: 'success' },
  { id: 'write-title', label: 'write-title', status: 'error' },
]

const pushedState: PutState = {
  _tag: 'Success',
  page: PAGE,
  stages: bodyOnlyStages,
  warnings: [],
  titleWritten: false,
  forced: false,
  baseHash: NEW_HASH,
}

const pushedTitleState: PutState = {
  _tag: 'Success',
  page: PAGE,
  stages: titleStages,
  warnings: [],
  titleWritten: true,
  forced: false,
  baseHash: NEW_HASH,
}

const partialWriteState: PutState = {
  _tag: 'Partial',
  page: PAGE,
  stages: partialStages,
  warnings: [
    {
      severity: 'warning',
      name: PAGE,
      status: 'partial-write',
      details: 'body written but title write failed — the page has a stale base hash',
      fixes: [
        `notion-md cat ${PAGE} to capture the new base hash`,
        `notion-md put ${PAGE} --base-hash <new-hash from cat>`,
      ],
    },
  ],
  bodyWritten: true,
  titleWritten: false,
}

const conflictState: PutState = {
  _tag: 'Conflict',
  page: PAGE,
  // The guard refuses before the body write: only observe ran.
  stages: [{ id: 'observe', label: 'observe', status: 'success' }],
  warnings: [
    {
      severity: 'warning',
      name: PAGE,
      status: 'conflict',
      details: `Remote page ${PAGE} moved since the supplied --base-hash. Re-cat and retry, or --force.`,
      fixes: [
        `notion-md cat ${PAGE} to capture the current base hash, then re-run put`,
        `notion-md put ${PAGE} --force to override the concurrency guard`,
      ],
    },
  ],
}

const errorState: PutState = {
  _tag: 'Error',
  page: PAGE,
  stages: [
    { id: 'observe', label: 'observe', status: 'success' },
    { id: 'write-body', label: 'write-body', status: 'error' },
  ],
  warnings: [],
  message: 'NmdGatewayError: failed to replace page body',
}

const story = (initialState: PutState): StoryObj<typeof PutView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md put"
      View={PutView}
      app={PutApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Put Output',
  component: PutView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PutView>

export const Pushed = story(pushedState)
export const PushedWithTitle = story(pushedTitleState)
export const PartialWrite = story(partialWriteState)
export const Conflict = story(conflictState)
export const ErrorState: StoryObj<typeof PutView> = { name: 'Error', ...story(errorState) }
