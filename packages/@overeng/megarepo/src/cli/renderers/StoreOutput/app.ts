/**
 * StoreOutput TuiApp
 *
 * createTuiApp instance for all store commands.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { StoreState, StoreAction, storeReducer } from './schema.ts'

/**
 * Initial state for store output (empty ls).
 */
export const createInitialStoreState = (): typeof StoreState.Type => ({
  _tag: 'Ls',
  basePath: '',
  repos: [],
})

/**
 * TuiApp for store output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* StoreApp.run(<StoreView stateAtom={StoreApp.stateAtom} />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Set ls state
 * tui.dispatch({ _tag: 'SetLs', basePath: '...', repos: [...] })
 *
 * // Or set error state
 * tui.dispatch({ _tag: 'SetError', error: 'not_found', message: '...' })
 * ```
 */
export const StoreApp = createTuiApp({
  stateSchema: StoreState,
  actionSchema: StoreAction,
  initial: createInitialStoreState(),
  reducer: storeReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
