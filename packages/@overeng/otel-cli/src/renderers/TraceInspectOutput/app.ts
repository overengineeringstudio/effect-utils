/**
 * TraceInspect TUI app
 *
 * Creates the TuiApp instance for the `otel trace inspect` command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { InspectAction, InspectState, createInitialInspectState, inspectReducer } from './schema.ts'

/** TUI app for trace inspection. */
export const InspectApp = createTuiApp({
  stateSchema: InspectState,
  actionSchema: InspectAction,
  initial: createInitialInspectState(),
  reducer: inspectReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
