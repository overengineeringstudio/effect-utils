import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { InfoState, InfoAction, infoReducer } from './schema.ts'

let cached: TuiApp<InfoState, InfoAction> | undefined

/**
 * TUI app definition for the database info command.
 *
 * Constructed lazily (and memoized) rather than at module top level: building it
 * eagerly is a module-load side-effect that crashes the umbrella `notion` binary
 * under Bun's concurrent command-tree import (#787).
 */
export const getInfoApp = (): TuiApp<InfoState, InfoAction> =>
  (cached ??= createTuiApp({
    stateSchema: InfoState,
    actionSchema: InfoAction,
    initial: { _tag: 'Loading' } as InfoState,
    reducer: infoReducer,
    exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
  }))
