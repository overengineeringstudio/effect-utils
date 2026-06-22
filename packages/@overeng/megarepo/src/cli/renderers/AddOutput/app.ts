/**
 * AddOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { AddState, AddAction, addReducer } from './schema.ts'

/**
 * Initial state (idle).
 */
export const createInitialAddState = (): AddState => ({
  _tag: 'Idle',
})

/**
 * TuiApp for add output.
 */
export const AddApp = createTuiApp({
  stateSchema: AddState,
  actionSchema: AddAction,
  initial: createInitialAddState(),
  reducer: addReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
