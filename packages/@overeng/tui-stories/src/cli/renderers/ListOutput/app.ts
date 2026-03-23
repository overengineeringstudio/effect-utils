import { createTuiApp } from '@overeng/tui-react'

import { ListState, ListAction, listReducer, type ListStateType } from './schema.ts'

/** Creates the default empty list state */
export const createInitialListState = (): ListStateType => ({
  groups: [],
  skippedCount: 0,
  packagePath: '',
})

/** TUI app definition for the list output renderer */
export const ListApp = createTuiApp({
  stateSchema: ListState,
  actionSchema: ListAction,
  initial: createInitialListState(),
  reducer: listReducer,
})
