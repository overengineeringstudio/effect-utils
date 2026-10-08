import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { InfoState, InfoAction, infoReducer } from './schema.ts'

/**
 * TUI app definition for the database info command.
 */
export const InfoApp: TuiApp<InfoState, InfoAction> = createTuiApp({
  stateSchema: InfoState,
  actionSchema: InfoAction,
  initial: { _tag: 'Loading' } as InfoState,
  reducer: infoReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
