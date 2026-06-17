import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getPlanApp } from '../cli-output/plan/app.ts'
import { planResultPayload } from '../cli-output/plan/map.ts'
import type { PlanState } from '../cli-output/plan/schema.ts'
import { PlanView } from '../cli-output/plan/view.tsx'
import type { TreeOp, TreeSyncResult } from '../tree.ts'

const PlanApp = getPlanApp()

const PAGE = '00000000-0000-4000-8000-000000000001'

const tree = (ops: readonly TreeOp[]): TreeSyncResult => ({
  _tag: 'tree',
  root: 'docs',
  rootPageId: PAGE,
  rootFile: 'index.nmd',
  direction: 'local',
  plan: true,
  ops,
})

const successFor = ({
  target,
  ops,
}: {
  readonly target: string
  readonly ops: readonly TreeOp[]
}): PlanState => ({ _tag: 'Success', target, ...planResultPayload(tree(ops)) })

const createHeavyState = successFor({
  target: 'docs',
  ops: Array.from(
    { length: 7 },
    (_, i): TreeOp => ({ _tag: 'create', relPath: `guide/p${i}.nmd`, title: `P${i}` }),
  ),
})

const mixedOpsState = successFor({
  target: 'docs',
  ops: [
    { _tag: 'create', relPath: 'guide/setup.nmd', title: 'Setup' },
    { _tag: 'create', relPath: 'guide/usage.nmd', title: 'Usage' },
    { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
    { _tag: 'move', relPath: 'reference/api.nmd', pageId: PAGE },
    { _tag: 'trash', relPath: 'old/legacy.nmd', pageId: PAGE },
    { _tag: 'noop', relPath: 'reference/cli.nmd', pageId: PAGE },
  ],
})

const noopState = successFor({
  target: 'docs',
  ops: [
    { _tag: 'noop', relPath: 'index.nmd', pageId: PAGE },
    { _tag: 'noop', relPath: 'guide/setup.nmd', pageId: PAGE },
    { _tag: 'noop', relPath: 'guide/usage.nmd', pageId: PAGE },
  ],
})

const blockedState = successFor({
  target: 'docs',
  ops: [
    { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
    { _tag: 'conflict', relPath: 'reference/cli.nmd', pageId: PAGE },
    { _tag: 'trash_blocked', relPath: 'old/legacy.nmd', pageId: PAGE },
  ],
})

const errorState: PlanState = {
  _tag: 'Error',
  target: 'docs',
  message: 'NmdGatewayError: failed to read remote tree',
}

const story = (initialState: PlanState): StoryObj<typeof PlanView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md plan"
      View={PlanView}
      app={PlanApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Plan Output',
  component: PlanView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PlanView>

export const CreateHeavy = story(createHeavyState)
export const MixedOps = story(mixedOpsState)
export const Noop = story(noopState)
export const Blocked = story(blockedState)
export const ErrorState: StoryObj<typeof PlanView> = { name: 'Error', ...story(errorState) }
