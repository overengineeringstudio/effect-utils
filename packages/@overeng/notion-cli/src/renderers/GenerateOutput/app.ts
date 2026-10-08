import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { GenerateState, GenerateAction, generateReducer } from './schema.ts'

/**
 * TUI app definition for the single-database schema generation command.
 */
export const GenerateApp: TuiApp<GenerateState, GenerateAction> = createTuiApp({
  stateSchema: GenerateState,
  actionSchema: GenerateAction,
  initial: { _tag: 'Introspecting', databaseId: '' } as GenerateState,
  reducer: generateReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
