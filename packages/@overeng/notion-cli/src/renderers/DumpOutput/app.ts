import { createTuiApp } from '@overeng/tui-react'

import { DumpState, DumpAction, dumpReducer } from './schema.ts'

export const DumpApp = createTuiApp({
  stateSchema: DumpState,
  actionSchema: DumpAction,
  initial: { _tag: 'Loading', databaseId: '' } as DumpState,
  reducer: dumpReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
