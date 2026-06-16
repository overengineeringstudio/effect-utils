import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { DiffState, DiffAction, diffReducer } from './schema.ts'

let cached: TuiApp<DiffState, DiffAction> | undefined

/**
 * TUI app definition for the schema diff command.
 *
 * Constructed lazily (and memoized) rather than at module top level: building it
 * eagerly is a module-load side-effect that crashes the umbrella `notion` binary
 * under Bun's concurrent command-tree import (#787).
 */
export const getDiffApp = (): TuiApp<DiffState, DiffAction> =>
  (cached ??= createTuiApp({
    stateSchema: DiffState,
    actionSchema: DiffAction,
    initial: { _tag: 'Loading' } as DiffState,
    reducer: diffReducer,
    exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
  }))
