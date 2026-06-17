import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getStatusApp } from '../cli-output/status/app.ts'
import { statusResultPayload } from '../cli-output/status/map.ts'
import type { StatusState } from '../cli-output/status/schema.ts'
import { StatusView } from '../cli-output/status/view.tsx'
import type { StatusResult } from '../sync.ts'

const StatusApp = getStatusApp()

const PAGE = '00000000-0000-4000-8000-000000000001'

/** Build a StatusResult with the given change flags (rest defaulted clean). */
const status = (overrides: Partial<StatusResult> = {}): StatusResult => ({
  path: 'demo/showcase.nmd',
  pageId: PAGE,
  localChanged: false,
  localPageMetadataChanged: false,
  localPropertiesChanged: false,
  remoteChanged: false,
  remoteBodyChanged: false,
  remotePageMetadataChanged: false,
  bodyHash: 'h',
  localBodyHash: 'h',
  remoteBodyHash: 'h',
  unresolvedUnknownBlocks: [],
  ...overrides,
})

/** Wrap a computed payload into a terminal Success state for a target. */
const successFor = ({
  target,
  result,
}: {
  readonly target: string
  readonly result: StatusResult | Parameters<typeof statusResultPayload>[0]
}): StatusState => ({ _tag: 'Success', target, ...statusResultPayload(result) })

const cleanState = successFor({ target: 'demo/showcase.nmd', result: status() })

const driftState = successFor({
  target: 'notes/planning.nmd',
  result: status({ path: 'notes/planning.nmd', localChanged: true, remoteChanged: true }),
})

const unknownBlocksState = successFor({
  target: 'docs/research.nmd',
  result: status({
    path: 'docs/research.nmd',
    localChanged: true,
    unresolvedUnknownBlocks: [
      'synced_block',
      'equation',
      'link_preview',
      'link_preview',
      'pdf',
      'bookmark',
    ],
  }),
})

const treeState = successFor({
  target: 'docs',
  result: {
    _tag: 'tree',
    root: 'docs',
    rootPageId: PAGE,
    rootFile: 'index.nmd',
    direction: 'local',
    plan: true,
    ops: [
      { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
      { _tag: 'create', relPath: 'guide/setup.nmd', title: 'Setup' },
      { _tag: 'noop', relPath: 'guide/usage.nmd', pageId: PAGE },
      { _tag: 'noop', relPath: 'reference/api.nmd', pageId: PAGE },
      { _tag: 'conflict', relPath: 'reference/cli.nmd', pageId: PAGE },
    ],
  },
})

const errorState: StatusState = {
  _tag: 'Error',
  target: 'demo/showcase.nmd',
  message: 'NmdGatewayError: failed to read remote page',
}

const story = (initialState: StatusState): StoryObj<typeof StatusView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md status"
      View={StatusView}
      app={StatusApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Status Output',
  component: StatusView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof StatusView>

export const Clean = story(cleanState)
export const Drift = story(driftState)
export const UnknownBlocks = story(unknownBlocksState)
export const Tree = story(treeState)
export const ErrorState: StoryObj<typeof StatusView> = { name: 'Error', ...story(errorState) }
