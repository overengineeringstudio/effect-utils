/**
 * StatusOutput TuiApp
 *
 * createTuiApp instance for the status command.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { StatusState, StatusAction, statusReducer } from './schema.ts'

/**
 * Initial empty state for status output.
 */
export const createInitialStatusState = (): typeof StatusState.Type => ({
  name: '',
  root: '',
  syncNeeded: false,
  syncReasons: [],
  members: [],
  all: false,
})

/**
 * TuiApp for status output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* StatusApp.run(<StatusView stateAtom={StatusApp.stateAtom} />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Set final state (status is static output)
 * tui.dispatch({ _tag: 'SetState', state: statusState })
 * ```
 */
export const StatusApp = createTuiApp({
  stateSchema: StatusState,
  actionSchema: StatusAction,
  initial: createInitialStatusState(),
  reducer: statusReducer,
  exitCode: () => 0, // Status errors handled via Effect errors, not state
})
