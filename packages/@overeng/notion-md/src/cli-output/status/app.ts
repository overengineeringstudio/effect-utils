import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import {
  StatusAction,
  StatusState,
  initialStatusState,
  statusExitCode,
  statusReducer,
} from './schema.ts'

let cached: TuiApp<StatusState, StatusAction> | undefined

/**
 * TUI app definition for the read-only `status` command output.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors `getSyncApp()`; drop the laziness once the Bun fix lands.
 *
 * `initial` carries an empty target placeholder — the handler dispatches the real
 * target (`SetTarget`) and the terminal result; the target label surfaces through
 * the view's `context` header.
 */
export const getStatusApp = (): TuiApp<StatusState, StatusAction> =>
  (cached ??= createTuiApp({
    stateSchema: StatusState,
    actionSchema: StatusAction,
    initial: initialStatusState('') as StatusState,
    reducer: statusReducer,
    exitCode: statusExitCode,
  }))
