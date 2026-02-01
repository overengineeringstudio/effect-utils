/**
 * Genie TuiApp
 *
 * createTuiApp instance for the genie command.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { GenieState, GenieAction, genieReducer, createInitialGenieState } from './schema.ts'

/**
 * TuiApp for genie output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* GenieApp.run(<GenieView stateAtom={GenieApp.stateAtom} />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Dispatch state updates
 * tui.dispatch({ _tag: 'FileCompleted', path, status, message })
 *
 * // Or set final state
 * tui.dispatch({ _tag: 'SetState', state: finalState })
 * ```
 */
export const GenieApp = createTuiApp({
  stateSchema: GenieState,
  actionSchema: GenieAction,
  initial: createInitialGenieState({ cwd: '', mode: 'generate' }),
  reducer: genieReducer,
})
