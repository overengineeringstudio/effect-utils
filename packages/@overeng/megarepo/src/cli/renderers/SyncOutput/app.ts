/**
 * SyncOutput TuiApp
 *
 * createTuiApp instance for the sync command.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { SyncState, SyncAction, syncReducer } from './schema.ts'

/**
 * Initial empty state for sync output.
 */
export const createInitialSyncState = (params: {
  workspaceName: string
  workspaceRoot: string
}): typeof SyncState.Type => ({
  workspace: {
    name: params.workspaceName,
    root: params.workspaceRoot,
  },
  options: {
    dryRun: false,
    frozen: false,
    pull: false,
    deep: false,
  },
  phase: 'idle',
  members: [],
  results: [],
  logs: [],
  nestedMegarepos: [],
  generatedFiles: [],
})

/**
 * TuiApp for sync output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* SyncApp.run(<SyncConnectedView />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Dispatch state updates
 * tui.dispatch({ _tag: 'AddResult', result: memberResult })
 *
 * // Or set final state
 * tui.dispatch({ _tag: 'SetState', state: finalState })
 * ```
 */
export const SyncApp = createTuiApp({
  stateSchema: SyncState,
  actionSchema: SyncAction,
  initial: createInitialSyncState({ workspaceName: '', workspaceRoot: '' }),
  reducer: syncReducer,
})
