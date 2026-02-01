/**
 * LsOutput TuiApp
 *
 * createTuiApp instance for the ls command.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { LsState, LsAction, lsReducer } from './schema.ts'

/**
 * Initial state for ls output (empty members list).
 */
export const createInitialLsState = (): typeof LsState.Type => ({
  _tag: 'Success',
  members: [],
})

/**
 * TuiApp for ls output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* LsApp.run(<LsView stateAtom={LsApp.stateAtom} />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Set success state
 * tui.dispatch({ _tag: 'SetMembers', members: [...] })
 *
 * // Or set error state
 * tui.dispatch({ _tag: 'SetError', error: 'not_found', message: 'No megarepo.json found' })
 * ```
 */
export const LsApp = createTuiApp({
  stateSchema: LsState,
  actionSchema: LsAction,
  initial: createInitialLsState(),
  reducer: lsReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
