import { createTuiApp } from '@overeng/tui-react'

import { GenerateConfigState, GenerateConfigAction, generateConfigReducer } from './schema.ts'

/** TUI app definition for the config-based schema generation command. */
export const GenerateConfigApp = createTuiApp({
  stateSchema: GenerateConfigState,
  actionSchema: GenerateConfigAction,
  initial: { _tag: 'Loading', configPath: '' } as GenerateConfigState,
  reducer: generateConfigReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
