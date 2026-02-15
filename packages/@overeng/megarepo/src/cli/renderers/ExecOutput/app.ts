/**
 * ExecOutput TuiApp
 *
 * createTuiApp instance for the exec command.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { ExecState, ExecAction, execReducer } from './schema.ts'

/**
 * Initial state for exec output.
 */
export const createInitialExecState = (): typeof ExecState.Type => ({
  _tag: 'Running',
  command: '',
  mode: 'parallel',
  verbose: false,
  members: [],
})

/**
 * TuiApp for exec output.
 *
 * Usage in CLI:
 * ```typescript
 * const tui = yield* ExecApp.run(<ExecView stateAtom={ExecApp.stateAtom} />).pipe(
 *   Effect.provide(outputModeLayer(output))
 * )
 *
 * // Start exec
 * tui.dispatch({ _tag: 'Start', command: 'npm test', mode: 'parallel', verbose: false, members: ['a', 'b'] })
 *
 * // Update member status
 * tui.dispatch({ _tag: 'UpdateMember', name: 'a', status: 'running' })
 * tui.dispatch({ _tag: 'UpdateMember', name: 'a', status: 'success', exitCode: 0, stdout: '...' })
 *
 * // Mark complete
 * tui.dispatch({ _tag: 'Complete' })
 * ```
 */
export const ExecApp = createTuiApp({
  stateSchema: ExecState,
  actionSchema: ExecAction,
  initial: createInitialExecState(),
  reducer: execReducer,
  exitCode: (state) => {
    if (state._tag === 'Error') return 1
    if (state._tag === 'Complete' && state.hasErrors === true) return 1
    return 0
  },
})
