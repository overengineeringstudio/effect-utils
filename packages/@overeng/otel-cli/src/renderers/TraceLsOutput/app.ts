/**
 * TraceLs TUI app
 *
 * Creates the TuiApp instance for the `otel trace ls` command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { LsAction, LsState, createInitialLsState, lsReducer } from './schema.ts'

/** TUI app for trace listing. */
export const LsApp = createTuiApp({
  stateSchema: LsState,
  actionSchema: LsAction,
  initial: createInitialLsState(),
  reducer: lsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
