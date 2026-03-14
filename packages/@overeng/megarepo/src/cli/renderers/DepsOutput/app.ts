/**
 * DepsOutput TuiApp
 *
 * createTuiApp instance for the deps command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { DepsState, DepsAction, depsReducer } from './schema.ts'

export const createInitialDepsState = (): typeof DepsState.Type => ({
  _tag: 'Empty',
})

export const DepsApp = createTuiApp({
  stateSchema: DepsState,
  actionSchema: DepsAction,
  initial: createInitialDepsState(),
  reducer: depsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
