import { createTuiApp } from '@overeng/tui-react'

import { DiffState, DiffAction, diffReducer } from './schema.ts'

export const DiffApp = createTuiApp({
  stateSchema: DiffState,
  actionSchema: DiffAction,
  initial: { _tag: 'Loading' } as DiffState,
  reducer: diffReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
