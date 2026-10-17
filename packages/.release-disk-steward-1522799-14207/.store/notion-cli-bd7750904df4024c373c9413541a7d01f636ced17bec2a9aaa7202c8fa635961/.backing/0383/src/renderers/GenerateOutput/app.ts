import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { GenerateState, GenerateAction, generateReducer } from './schema.ts'

let cached: TuiApp<GenerateState, GenerateAction> | undefined

/**
 * TUI app definition for the single-database schema generation command.
 *
 * Constructed lazily (and memoized) rather than at module top level: building it
 * eagerly is a module-load side-effect that crashes the umbrella `notion` binary
 * under Bun's concurrent command-tree import (#787).
 */
export const getGenerateApp = (): TuiApp<GenerateState, GenerateAction> =>
  (cached ??= createTuiApp({
    stateSchema: GenerateState,
    actionSchema: GenerateAction,
    initial: { _tag: 'Introspecting', databaseId: '' } as GenerateState,
    reducer: generateReducer,
    exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
  }))
