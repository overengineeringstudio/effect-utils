/**
 * GenerateOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { GenerateState, GenerateAction, generateReducer } from './schema.ts'

/**
 * Initial state (idle).
 */
export const createInitialGenerateState = (): typeof GenerateState.Type => ({
  _tag: 'Idle',
})

/**
 * TuiApp for generate output.
 */
export const GenerateApp = createTuiApp({
  stateSchema: GenerateState,
  actionSchema: GenerateAction,
  initial: createInitialGenerateState(),
  reducer: generateReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
