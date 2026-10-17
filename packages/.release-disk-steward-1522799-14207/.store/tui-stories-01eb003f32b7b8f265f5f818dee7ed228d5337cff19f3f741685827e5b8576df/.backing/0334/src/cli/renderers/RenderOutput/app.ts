import { createTuiApp } from '@overeng/tui-react'

import { RenderState, RenderAction, renderReducer, type RenderStateType } from './schema.ts'

/** Creates the default render state (rendering in progress) */
export const createInitialRenderState = (): RenderStateType => ({
  _tag: 'Rendering',
  storyId: '',
  width: 80,
  timelineMode: 'initial',
})

/** TUI app definition for the render output */
export const RenderApp = createTuiApp({
  stateSchema: RenderState,
  actionSchema: RenderAction,
  initial: createInitialRenderState(),
  reducer: renderReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
