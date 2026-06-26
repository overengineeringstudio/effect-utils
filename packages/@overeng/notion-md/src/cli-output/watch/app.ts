import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import {
  WatchAction,
  WatchState,
  initialWatchState,
  watchExitCode,
  watchReducer,
} from './schema.ts'

let cached: TuiApp<WatchState, WatchAction> | undefined

/**
 * TUI app definition for the `sync --watch` live human view.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors `getSyncApp()`/`getEditApp()`; drop the laziness once the Bun fix lands.
 *
 * NOTE: no `ndjson` config — the machine modes deliberately bypass this app and
 * stream the existing `writeJsonLine` per-pass lines verbatim (byte-identity).
 * Adding an `ndjson` mapping here would re-introduce the bootstrap-snapshot line
 * and schema-key-order risk that breaks that contract.
 */
export const getWatchApp = (): TuiApp<WatchState, WatchAction> =>
  (cached ??= createTuiApp({
    stateSchema: WatchState,
    actionSchema: WatchAction,
    initial: initialWatchState('') as WatchState,
    reducer: watchReducer,
    exitCode: watchExitCode,
  }))
