import { createTuiApp } from '@overeng/tui-react'

import { IntrospectState, IntrospectAction, introspectReducer } from './schema.ts'

/** TUI app definition for the database introspection command. */
export const IntrospectApp = createTuiApp({
  stateSchema: IntrospectState,
  actionSchema: IntrospectAction,
  initial: { _tag: 'Loading' } as IntrospectState,
  reducer: introspectReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
