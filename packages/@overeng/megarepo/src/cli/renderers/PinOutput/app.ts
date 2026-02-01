/**
 * PinOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { PinState, PinAction, pinReducer } from './schema.ts'

/**
 * Initial state (idle).
 */
export const createInitialPinState = (): typeof PinState.Type => ({
  _tag: 'Idle',
})

/**
 * TuiApp for pin/unpin output.
 */
export const PinApp = createTuiApp({
  stateSchema: PinState,
  actionSchema: PinAction,
  initial: createInitialPinState(),
  reducer: pinReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
