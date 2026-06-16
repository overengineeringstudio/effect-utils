import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { GenerateConfigState, GenerateConfigAction, generateConfigReducer } from './schema.ts'

let cached: TuiApp<GenerateConfigState, GenerateConfigAction> | undefined

/**
 * TUI app definition for the config-based schema generation command.
 *
 * Constructed lazily (and memoized) rather than at module top level: building it
 * eagerly is a module-load side-effect that crashes the umbrella `notion` binary
 * under Bun's concurrent command-tree import (#787).
 */
export const getGenerateConfigApp = (): TuiApp<GenerateConfigState, GenerateConfigAction> =>
  (cached ??= createTuiApp({
    stateSchema: GenerateConfigState,
    actionSchema: GenerateConfigAction,
    initial: { _tag: 'Loading', configPath: '' } as GenerateConfigState,
    reducer: generateConfigReducer,
    exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
  }))
