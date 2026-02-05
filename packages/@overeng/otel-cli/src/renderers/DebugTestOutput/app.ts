/**
 * DebugTest TUI app
 *
 * Creates the TuiApp instance for the `otel debug test` command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { TestAction, TestState, createInitialTestState, testReducer } from './schema.ts'

/** TUI app for the debug test command. */
export const DebugTestApp = createTuiApp({
  stateSchema: TestState,
  actionSchema: TestAction,
  initial: createInitialTestState(),
  reducer: testReducer,
  exitCode: (state) => {
    if (state._tag === 'Complete' && !state.allPassed) return 1
    return 0
  },
})
