/**
 * DepsOutput TuiApp
 *
 * createTuiApp instance for the deps command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { DepsState, DepsAction, depsReducer } from './schema.ts'

/** Creates the initial empty state for the deps command TUI */
export const createInitialDepsState = (): typeof DepsState.Type => ({
  _tag: 'Empty',
})

/** TUI app instance for the deps command (state management + rendering) */
export const DepsApp = createTuiApp({
  stateSchema: DepsState,
  actionSchema: DepsAction,
  initial: createInitialDepsState(),
  reducer: depsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
