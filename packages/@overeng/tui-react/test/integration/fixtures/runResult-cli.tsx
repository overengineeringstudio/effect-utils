/**
 * Fixture CLI used by runResult-stdout-contract.test.ts.
 *
 * Shape intentionally mirrors op-proxy-style commands: a small `runResult`
 * app that dispatches state, returns a payload. Stdin → stdout (result)
 * should be byte-clean regardless of how stdout is captured. Stderr carries
 * the view.
 */

import { NodeRuntime } from '@effect/platform-node'
import { Schema } from 'effect'
import { Effect } from 'effect'
import React from 'react'

import {
  createTuiApp,
  runResult,
  Box,
  Text,
  useTuiAtomValue,
  type TuiApp,
} from '../../../src/mod.tsx'
import { runTuiMain, tuiRuntimeLayer } from '../../../src/node/mod.ts'

const State = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Approved', { output: Schema.String }),
)
type State = typeof State.Type

const Action = Schema.Union(Schema.TaggedStruct('Approve', { output: Schema.String }))
type Action = typeof Action.Type

const App: TuiApp<State, Action> = createTuiApp({
  stateSchema: State,
  actionSchema: Action,
  initial: { _tag: 'Idle' },
  reducer: ({ action }) => ({ _tag: 'Approved' as const, output: action.output }),
})

const View = (): React.ReactElement => {
  const state = useTuiAtomValue(App.stateAtom)
  if (state._tag === 'Idle') {
    return (
      <Box>
        <Text>waiting…</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>✓ Approved</Text>
      <Text>payload: {state.output}</Text>
    </Box>
  )
}

const program = runResult(
  App,
  (tui) =>
    Effect.sync(() => {
      const payload = process.env.TEST_PAYLOAD ?? 'hello-world'
      tui.dispatch({ _tag: 'Approve', output: payload })
      return payload
    }),
  { result: Schema.String, view: <View /> },
)

runTuiMain(NodeRuntime)(
  program.pipe(Effect.provide(tuiRuntimeLayer('auto'))) as Effect.Effect<unknown, never, never>,
)
