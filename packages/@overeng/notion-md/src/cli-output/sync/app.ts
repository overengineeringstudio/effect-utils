import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { SyncAction, SyncState, initialSyncState, syncExitCode, syncReducer } from './schema.ts'

let cached: TuiApp<SyncState, SyncAction> | undefined

/**
 * TUI app definition for the one-shot `sync` command output.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors `getEditApp()`; drop the laziness once the Bun fix lands.
 *
 * `initial` carries an empty target placeholder — the handler dispatches stage
 * transitions and the terminal action over the real target; the target label
 * itself comes through the view's `context` header.
 */
export const getSyncApp = (): TuiApp<SyncState, SyncAction> =>
  (cached ??= createTuiApp({
    stateSchema: SyncState,
    actionSchema: SyncAction,
    initial: initialSyncState('') as SyncState,
    reducer: syncReducer,
    exitCode: syncExitCode,
  }))
