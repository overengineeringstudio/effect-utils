/**
 * InitOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { InitState, InitAction, initReducer } from './schema.ts'

/**
 * Initial state (default to initialized with empty path).
 */
export const createInitialInitState = (): typeof InitState.Type => ({
  _tag: 'Success',
  path: '',
})

/**
 * TuiApp for init output.
 */
export const InitApp = createTuiApp({
  stateSchema: InitState,
  actionSchema: InitAction,
  initial: createInitialInitState(),
  reducer: initReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
