import { createTuiApp } from '@overeng/tui-react'

import { InspectState, InspectAction, inspectReducer, type InspectStateType } from './schema.ts'

/** Creates the default empty inspect state */
export const createInitialInspectState = (): InspectStateType => ({
  id: '',
  title: '',
  name: '',
  filePath: '',
  args: [],
  hasTimeline: false,
  timelineEventCount: 0,
})

/** TUI app definition for the inspect output renderer */
export const InspectApp = createTuiApp({
  stateSchema: InspectState,
  actionSchema: InspectAction,
  initial: createInitialInspectState(),
  reducer: inspectReducer,
})
