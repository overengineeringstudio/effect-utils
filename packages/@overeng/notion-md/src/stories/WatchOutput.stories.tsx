import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { getWatchApp } from '../cli-output/watch/app.ts'
import {
  type WatchAction,
  type WatchReason,
  type WatchState,
  initialWatchState,
  watchReducer,
} from '../cli-output/watch/schema.ts'
import { WatchView } from '../cli-output/watch/view.tsx'

const WatchApp = getWatchApp()

const FILE = 'docs/getting-started.nmd'
const TREE = '3 targets'

/** Fold a sequence of actions onto the initial state (mirrors the live loop). */
const accumulate = ({
  target,
  pollIntervalMs,
  passes,
}: {
  readonly target: string
  readonly pollIntervalMs: number
  readonly passes: readonly WatchAction[]
}): WatchState => {
  let state = initialWatchState(target)
  state = watchReducer({ state, action: { _tag: 'Init', target, pollIntervalMs } })
  for (const action of passes) state = watchReducer({ state, action })
  return state
}

/** A single-file pass producing one outcome. */
const single = ({
  reason,
  outcome,
}: {
  readonly reason: WatchReason
  readonly outcome: 'pushed' | 'pulled' | 'noop' | 'conflict'
}): WatchAction =>
  outcome === 'conflict'
    ? {
        _tag: 'WatchPass',
        reason,
        result: { _tag: 'Single', outcome },
        detail: 'local and remote both changed — nothing pushed',
      }
    : { _tag: 'WatchPass', reason, result: { _tag: 'Single', outcome } }

/** Several accumulated single-file passes, clean (pushed/pulled/noop mix). */
const singleCleanState = accumulate({
  target: FILE,
  pollIntervalMs: 2000,
  passes: [
    single({ reason: 'initial', outcome: 'pulled' }),
    single({ reason: 'file', outcome: 'pushed' }),
    single({ reason: 'poll', outcome: 'noop' }),
    single({ reason: 'file', outcome: 'pushed' }),
    single({ reason: 'poll', outcome: 'noop' }),
    single({ reason: 'poll', outcome: 'noop' }),
  ],
})

/** A run where the latest pass conflicted (surfaces a WARNING + error glyph). */
const singleConflictState = accumulate({
  target: FILE,
  pollIntervalMs: 2000,
  passes: [
    single({ reason: 'initial', outcome: 'pulled' }),
    single({ reason: 'file', outcome: 'pushed' }),
    single({ reason: 'file', outcome: 'conflict' }),
  ],
})

/** A batch run accumulating mixed multi-file passes incl. a conflict. */
const batchMixedState = accumulate({
  target: TREE,
  pollIntervalMs: 5000,
  passes: [
    {
      _tag: 'WatchPass',
      reason: 'initial',
      result: { _tag: 'Batch', outcomes: ['pushed', 'noop', 'pulled'] },
    },
    {
      _tag: 'WatchPass',
      reason: 'batch',
      result: { _tag: 'Batch', outcomes: ['pushed', 'pushed', 'conflict'] },
      detail: '0 failed · 1 conflict in batch',
    },
    {
      _tag: 'WatchPass',
      reason: 'poll',
      result: { _tag: 'Batch', outcomes: ['noop', 'noop', 'noop'] },
    },
  ],
})

/** A run where the latest pass failed outright (network/missing file). */
const failureState = accumulate({
  target: FILE,
  pollIntervalMs: 2000,
  passes: [
    single({ reason: 'initial', outcome: 'pulled' }),
    {
      _tag: 'WatchPass',
      reason: 'poll',
      result: { _tag: 'Failure', message: 'NmdGatewayError: request timed out' },
      detail: 'NmdGatewayError: request timed out',
    },
  ],
})

const story = (initialState: WatchState): StoryObj<typeof WatchView> => ({
  render: () => (
    <TuiStoryPreview
      command="notion-md sync --watch"
      View={WatchView}
      app={WatchApp}
      initialState={initialState}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
})

export default {
  title: 'notion-md/Watch Output',
  component: WatchView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof WatchView>

export const SingleClean = story(singleCleanState)
export const SingleConflict = story(singleConflictState)
export const BatchMixed = story(batchMixedState)
export const Failure = story(failureState)
