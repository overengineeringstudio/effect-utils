/**
 * PushRefsOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { PushRefsState, PushRefsAction, pushRefsReducer } from './schema.ts'

/** Returns the default idle state for the push-refs TUI */
export const createInitialPushRefsState = (): typeof PushRefsState.Type => ({
  _tag: 'Idle',
})

/** TUI app for the `push-refs` command */
export const PushRefsApp = createTuiApp({
  stateSchema: PushRefsState,
  actionSchema: PushRefsAction,
  initial: createInitialPushRefsState(),
  reducer: pushRefsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
