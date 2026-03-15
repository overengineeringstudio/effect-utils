/**
 * PushRefsOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { PushRefsState, PushRefsAction, pushRefsReducer } from './schema.ts'

export const createInitialPushRefsState = (): typeof PushRefsState.Type => ({
  _tag: 'Idle',
})

export const PushRefsApp = createTuiApp({
  stateSchema: PushRefsState,
  actionSchema: PushRefsAction,
  initial: createInitialPushRefsState(),
  reducer: pushRefsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
