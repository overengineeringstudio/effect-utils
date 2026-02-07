/**
 * Health TUI app
 *
 * Creates the TuiApp instance for the `otel health` command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { HealthAction, HealthState, createInitialHealthState, healthReducer } from './schema.ts'

/** TUI app for health checking. */
export const HealthApp = createTuiApp({
  stateSchema: HealthState,
  actionSchema: HealthAction,
  initial: createInitialHealthState(),
  reducer: healthReducer,
  exitCode: (state) => {
    if (state._tag === 'Error') return 1
    if (state._tag === 'Success' && !state.allHealthy) return 1
    return 0
  },
})
