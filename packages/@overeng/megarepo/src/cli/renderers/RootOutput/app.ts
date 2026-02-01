/**
 * RootOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { RootState, RootAction, rootReducer } from './schema.ts'

/**
 * Initial state (empty success state).
 */
export const createInitialRootState = (): typeof RootState.Type => ({
  root: '',
  name: '',
  source: 'search',
})

/**
 * TuiApp for root output.
 */
export const RootApp = createTuiApp({
  stateSchema: RootState,
  actionSchema: RootAction,
  initial: createInitialRootState(),
  reducer: rootReducer,
})
